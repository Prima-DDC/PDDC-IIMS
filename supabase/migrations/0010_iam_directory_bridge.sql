-- PDDC IIMS 0010 : the bridge to the shared identity, and per-request actor
-- resolution.
--
-- WHY THIS EXISTS
-- Migration 0002 granted iims_app SELECT on auth.users and auth.sessions, but
-- that was ineffective: the role has no USAGE on the `auth` schema, so every
-- read failed with "permission denied for schema auth". Separately,
-- public.profiles carries the website's own RLS policy
-- (`id = auth.uid() or public.is_admin()`), and auth.uid() is null on a direct
-- Postgres connection, so iims_app saw zero rows.
--
-- Granting schema usage and fighting the website's policies would widen the
-- blast radius for no benefit. Instead the IIMS reaches the shared identity
-- through the three narrow SECURITY DEFINER functions below. They expose
-- exactly the columns the platform needs and nothing else, which is a tighter
-- boundary than blanket read access would have been.
--
-- The now-redundant grants are revoked so a security review does not have to
-- wonder whether they are load-bearing.

revoke select on auth.users from iims_app;
revoke select on auth.sessions from iims_app;

-- ---------------------------------------------------------------------------
-- Per-request actor resolution.
--
-- One round trip returns everything the session layer needs: identity from the
-- shared directory, IIMS status and clearance, the permissions version (so a
-- permission change applies without re-login), and whether the Supabase
-- session behind this JWT is still live.
--
-- That last column is what makes suspension immediate. Supabase's
-- `ban_duration` blocks future sign-ins but does NOT revoke existing sessions,
-- and access tokens are stateless JWTs, so the only reliable check is to look
-- the session up on every request (PRD 3.3).
-- ---------------------------------------------------------------------------
create or replace function iam.resolve_actor(
  p_user    uuid,
  p_session uuid default null
)
  returns table (
    user_id                 uuid,
    email                   text,
    full_name               text,
    photo_path              text,
    employee_id             text,
    job_title               text,
    status                  text,
    clearance               text,
    permissions_version     bigint,
    locked_until            timestamptz,
    session_timeout_minutes int,
    mfa_enrolled_at         timestamptz,
    is_administrator        boolean,
    session_live            boolean,
    office_name             text,
    department_name         text,
    country_code            text,
    primary_role            text
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    u.id,
    -- The directory is the website's; the IIMS reads it and never writes it.
    coalesce(p.email, au.email::text)                      as email,
    p.full_name,
    p.photo_path,
    u.employee_id,
    u.job_title,
    u.status,
    u.clearance,
    u.permissions_version,
    u.locked_until,
    u.session_timeout_minutes,
    u.mfa_enrolled_at,
    iam.is_administrator(u.id)                             as is_administrator,
    -- When no session id is supplied the check is skipped rather than failed,
    -- so server-side jobs acting for a user are not locked out.
    case
      when p_session is null then true
      else exists (select 1 from auth.sessions s where s.id = p_session and s.user_id = u.id)
    end                                                    as session_live,
    o.name                                                 as office_name,
    d.name                                                 as department_name,
    u.country_code,
    (select r.name
     from iam.user_roles ur
     join iam.roles r on r.id = ur.role_id
     where ur.user_id = u.id
       and ur.is_primary
       and ur.valid_from <= now()
       and (ur.valid_to is null or ur.valid_to > now())
     limit 1)                                              as primary_role
  from iam.users u
  left join public.profiles p on p.id = u.id
  left join auth.users au     on au.id = u.id
  left join iam.offices o     on o.id = u.office_id
  left join iam.departments d on d.id = u.department_id
  where u.id = p_user
    and u.deleted_at is null
$$;

grant execute on function iam.resolve_actor(uuid, uuid) to iims_app;

-- ---------------------------------------------------------------------------
-- The shared employee directory, as the admin dashboard needs to see it:
-- every person who can sign in, and whether they have an IIMS account.
--
-- This is what makes "an administrator must grant IIMS access" workable. A
-- primaddc.com account appears here with iims_status null, and provisioning it
-- creates the iam.users row.
-- ---------------------------------------------------------------------------
create or replace function iam.directory_profiles(
  p_search          text    default null,
  p_only_unlinked   boolean default false,
  p_limit           int     default 50,
  p_offset          int     default 0
)
  returns table (
    user_id        uuid,
    email          text,
    full_name      text,
    website_role   text,
    iims_status    text,
    iims_clearance text,
    has_iims_access boolean,
    total_count    bigint
  )
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
begin
  -- Reading the staff directory is a user-administration action.
  if not iam.has_permission('users', 'view') then
    raise exception 'not permitted to read the staff directory'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with candidates as (
    select
      p.id,
      p.email,
      p.full_name,
      p.role          as website_role,
      u.status        as iims_status,
      u.clearance     as iims_clearance,
      (u.id is not null and u.deleted_at is null) as has_access
    from public.profiles p
    left join iam.users u on u.id = p.id
    where (p_only_unlinked = false or u.id is null or u.deleted_at is not null)
      and (
        p_search is null
        or p.email ilike '%' || p_search || '%'
        or coalesce(p.full_name, '') ilike '%' || p_search || '%'
      )
  )
  select c.id, c.email, c.full_name, c.website_role, c.iims_status,
         c.iims_clearance, c.has_access,
         count(*) over () as total_count
  from candidates c
  order by c.full_name nulls last, c.email
  limit least(coalesce(p_limit, 50), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end
$$;

grant execute on function iam.directory_profiles(text, boolean, int, int) to iims_app;

-- ---------------------------------------------------------------------------
-- Name and email for a set of user ids, for rendering lists without exposing
-- the whole directory. Used wherever a record names an actor.
-- ---------------------------------------------------------------------------
create or replace function iam.display_names(p_ids uuid[])
  returns table (user_id uuid, email text, full_name text)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select p.id, p.email, p.full_name
  from public.profiles p
  where p.id = any(p_ids)
$$;

grant execute on function iam.display_names(uuid[]) to iims_app;

-- ---------------------------------------------------------------------------
-- Active Supabase sessions for one user, so an administrator can see and
-- revoke them (PRD 3.3 "View: ... active sessions", "revoke sessions").
-- ---------------------------------------------------------------------------
create or replace function iam.user_sessions(p_user uuid)
  returns table (
    session_id   uuid,
    created_at   timestamptz,
    updated_at   timestamptz,
    not_after    timestamptz,
    user_agent   text,
    ip           text
  )
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
begin
  if not (iam.has_permission('users', 'view') or p_user = iam.current_user_id()) then
    raise exception 'not permitted to view sessions for this user'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select s.id, s.created_at, s.updated_at, s.not_after,
         s.user_agent, host(s.ip)
  from auth.sessions s
  where s.user_id = p_user
  order by s.updated_at desc nulls last;
end
$$;

grant execute on function iam.user_sessions(uuid) to iims_app;

-- PDDC IIMS 0007: the authorization engine, and RLS policies for iam.
--
-- Effective permissions = union of all permissions from the user's ACTIVE
-- roles, plus user-specific grants, MINUS user-specific denies. An explicit
-- deny always overrides an allow (PRD §3.2).
--
-- Every function here is SECURITY DEFINER with a pinned empty search_path.
-- SECURITY DEFINER is not a convenience: a policy on iam.users that called a
-- function which itself selects from iam.users would recurse infinitely. This
-- is the same pattern the website already uses for public.is_admin().
--
-- These functions are the SECOND line of defence. The authoritative check runs
-- in the application use case (PRD §14 "Server-side RBAC ... on every
-- request"); RLS exists so that a missed check fails closed instead of
-- leaking.

-- ------------------------------------------------------------- primitives

create or replace function iam.current_user_id()
  returns uuid
  language sql
  stable
  set search_path = ''
as $$
  -- NULL when unset, which makes every policy below deny. Never add a
  -- fallback here: a query that escapes withActor() must fail, not succeed.
  select nullif(current_setting('iims.user_id', true), '')::uuid
$$;

create or replace function iam.clearance_rank(p_code text)
  returns int
  language sql
  stable
  set search_path = ''
as $$
  select coalesce(
    (select rank from iam.classification_levels where code = p_code),
    999   -- unknown level ranks above everything, so it is never readable
  )
$$;

create or replace function iam.scope_rank(p_scope text)
  returns int
  language sql
  immutable
  set search_path = ''
as $$
  select case p_scope
    when 'own'        then 1
    when 'assigned'   then 2
    when 'team'       then 3
    when 'department' then 4
    when 'office'     then 5
    when 'country'    then 6
    when 'all'        then 7
    else 0
  end
$$;

/**
 * Does this user hold an active Administrator role?
 *
 * The Administrator role carries every clearance level (PRD §3.2) and a
 * wildcard permission grant (PRD §3.5), so this is checked first in both
 * has_permission() and has_clearance().
 */
create or replace function iam.is_administrator(p_user uuid default null)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1
    from iam.user_roles ur
    join iam.roles r on r.id = ur.role_id
    join iam.users u on u.id = ur.user_id
    where ur.user_id = coalesce(p_user, iam.current_user_id())
      and r.is_administrator
      and r.is_active
      and r.deleted_at is null
      and u.status = 'active'
      and u.deleted_at is null
      and ur.valid_from <= now()
      and (ur.valid_to is null or ur.valid_to > now())
  )
$$;

/**
 * Is this user cleared for material classified at p_required?
 *
 * Clearance is assigned per user and is never conferred by a role alone: the
 * Administrator role is the documented exception (PRD §3.2).
 */
create or replace function iam.has_clearance(p_required text, p_user uuid default null)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    iam.is_administrator(coalesce(p_user, iam.current_user_id()))
    or exists (
      select 1
      from iam.users u
      where u.id = coalesce(p_user, iam.current_user_id())
        and u.status = 'active'
        and u.deleted_at is null
        and iam.clearance_rank(u.clearance) >= iam.clearance_rank(p_required)
    )
$$;

-- ------------------------------------------------- effective permissions

/**
 * Every permission this user effectively holds, after role union, user grants
 * and user denies.
 *
 * Deny is applied at (resource, action) granularity: a deny removes that
 * resource/action entirely, regardless of the scope any role granted it at.
 * That is what "an explicit deny always overrides an allow" has to mean to be
 * safe: a narrower surviving grant would make a deny look applied while
 * leaving a hole.
 */
create or replace function iam.effective_permissions(p_user uuid default null)
  returns table (
    resource               text,
    action                 text,
    scope                  text,
    classification_ceiling text,
    source                 text      -- which role or override produced it
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  with target as (
    select coalesce(p_user, iam.current_user_id()) as uid
  ),
  -- Only roles that are active, undeleted, and inside their validity window.
  active_roles as (
    select ur.role_id, r.key as role_key
    from iam.user_roles ur
    join iam.roles r on r.id = ur.role_id
    cross join target t
    where ur.user_id = t.uid
      and r.is_active
      and r.deleted_at is null
      and ur.valid_from <= now()
      and (ur.valid_to is null or ur.valid_to > now())
  ),
  granted as (
    select p.resource, p.action, p.scope, p.classification_ceiling,
           'role:' || ar.role_key as source
    from active_roles ar
    join iam.role_permissions rp on rp.role_id = ar.role_id
    join iam.permissions p on p.id = rp.permission_id

    union all

    select p.resource, p.action, p.scope, p.classification_ceiling,
           'override:allow' as source
    from iam.user_permission_overrides o
    join iam.permissions p on p.id = o.permission_id
    cross join target t
    where o.user_id = t.uid
      and o.effect = 'allow'
      and (o.expires_at is null or o.expires_at > now())
  ),
  denied as (
    select p.resource, p.action
    from iam.user_permission_overrides o
    join iam.permissions p on p.id = o.permission_id
    cross join target t
    where o.user_id = t.uid
      and o.effect = 'deny'
      and (o.expires_at is null or o.expires_at > now())
  )
  select g.resource, g.action, g.scope, g.classification_ceiling, g.source
  from granted g
  where not exists (
    select 1 from denied d
    where d.resource = g.resource and d.action = g.action
  )
$$;

/**
 * The single question the whole platform asks: may this user do this?
 *
 * p_classification, when supplied, additionally requires that the permission's
 * ceiling AND the user's own clearance both reach it. A role can never lift a
 * user above their personal clearance.
 */
create or replace function iam.has_permission(
  p_resource       text,
  p_action         text,
  p_classification text default null,
  p_user           uuid default null
)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  with target as (
    select coalesce(p_user, iam.current_user_id()) as uid
  )
  select
    -- An inactive or suspended user holds nothing, whatever their roles say.
    -- This is also what makes suspension effective immediately.
    exists (
      select 1 from iam.users u cross join target t
      where u.id = t.uid and u.status = 'active' and u.deleted_at is null
        and (u.locked_until is null or u.locked_until <= now())
    )
    and (
      iam.is_administrator((select uid from target))
      or (
        exists (
          select 1
          from iam.effective_permissions((select uid from target)) ep
          where (ep.resource = p_resource or ep.resource = '*')
            and (ep.action = p_action or ep.action = '*')
            and (
              p_classification is null
              or iam.clearance_rank(ep.classification_ceiling)
                 >= iam.clearance_rank(p_classification)
            )
        )
        -- The user's personal clearance caps everything.
        and (p_classification is null
             or iam.has_clearance(p_classification, (select uid from target)))
      )
    )
$$;

/** Broadest scope this user holds for a resource/action, or null. */
create or replace function iam.permission_scope(
  p_resource text,
  p_action   text,
  p_user     uuid default null
)
  returns text
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select case
    when iam.is_administrator(coalesce(p_user, iam.current_user_id())) then 'all'
    else (
      select ep.scope
      from iam.effective_permissions(coalesce(p_user, iam.current_user_id())) ep
      where (ep.resource = p_resource or ep.resource = '*')
        and (ep.action = p_action or ep.action = '*')
      order by iam.scope_rank(ep.scope) desc
      limit 1
    )
  end
$$;

/** Feature flags: role defaults, with a per-user override winning. */
create or replace function iam.has_feature(p_key text, p_user uuid default null)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  with target as (select coalesce(p_user, iam.current_user_id()) as uid)
  select coalesce(
    -- A user-specific override decides, allow or deny.
    (select uf.enabled
     from iam.user_features uf cross join target t
     where uf.user_id = t.uid and uf.feature_key = p_key
       and (uf.expires_at is null or uf.expires_at > now())),
    -- Otherwise: enabled if any active role enables it.
    (select exists (
       select 1
       from iam.user_roles ur
       join iam.role_features rf on rf.role_id = ur.role_id
       join iam.roles r on r.id = ur.role_id
       cross join target t
       where ur.user_id = t.uid
         and rf.feature_key = p_key
         and rf.enabled
         and r.is_active and r.deleted_at is null
         and ur.valid_from <= now()
         and (ur.valid_to is null or ur.valid_to > now())
     )),
    false
  )
$$;

-- ------------------------------------------ immediate permission changes
/**
 * Bumps iam.users.permissions_version so a permission change takes effect
 * WITHOUT the user re-logging in (PRD §3.4). Each request compares the version
 * it cached against the stored one and re-resolves when they differ.
 */
create or replace function iam.bump_permissions_version()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_row  jsonb;
  v_user uuid;
  v_role uuid;
begin
  -- One trigger function serves six tables with different columns, so the row
  -- is read as jsonb rather than through NEW.<field>. Referencing a field that
  -- does not exist on the triggering table fails when PL/pgSQL plans the
  -- statement, even inside a branch that never runs, and NEW is unassigned on
  -- DELETE. Going through jsonb sidesteps both and needs no per-table code.
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
  else
    v_row := to_jsonb(new);
  end if;

  v_user := nullif(v_row ->> 'user_id', '')::uuid;

  -- iam.roles identifies the role by `id`; the mapping tables by `role_id`.
  v_role := coalesce(
    nullif(v_row ->> 'role_id', '')::uuid,
    case when tg_table_name = 'roles' then nullif(v_row ->> 'id', '')::uuid end
  );

  if v_user is not null then
    update iam.users
    set permissions_version = permissions_version + 1
    where id = v_user;

  elsif v_role is not null then
    -- A role or role-permission change affects everyone holding that role.
    update iam.users u
    set permissions_version = u.permissions_version + 1
    where exists (
      select 1 from iam.user_roles ur
      where ur.user_id = u.id and ur.role_id = v_role
    );
  end if;

  return null;   -- AFTER trigger
end
$$;

drop trigger if exists user_roles_bump on iam.user_roles;
create trigger user_roles_bump
  after insert or update or delete on iam.user_roles
  for each row execute function iam.bump_permissions_version();

drop trigger if exists overrides_bump on iam.user_permission_overrides;
create trigger overrides_bump
  after insert or update or delete on iam.user_permission_overrides
  for each row execute function iam.bump_permissions_version();

drop trigger if exists user_features_bump on iam.user_features;
create trigger user_features_bump
  after insert or update or delete on iam.user_features
  for each row execute function iam.bump_permissions_version();

drop trigger if exists role_permissions_bump on iam.role_permissions;
create trigger role_permissions_bump
  after insert or update or delete on iam.role_permissions
  for each row execute function iam.bump_permissions_version();

drop trigger if exists role_features_bump on iam.role_features;
create trigger role_features_bump
  after insert or update or delete on iam.role_features
  for each row execute function iam.bump_permissions_version();

-- -------------------------------------------- last administrator standing
/**
 * "The last active administrator cannot be removed or suspended" (PRD §3.4).
 *
 * Enforced in the database because losing every administrator is
 * unrecoverable without break-glass access, and a service-layer check can be
 * bypassed by any other code path.
 */
create or replace function iam.guard_last_administrator()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_remaining int;
begin
  -- Only interesting when an administrator stops being usable.
  if tg_table_name = 'users' then
    if new.status = 'active' and new.deleted_at is null then
      return new;
    end if;
    if not iam.is_administrator(new.id) then
      return new;
    end if;
  end if;

  select count(*) into v_remaining
  from iam.users u
  where u.status = 'active'
    and u.deleted_at is null
    and u.id <> coalesce(new.id, old.id)
    and iam.is_administrator(u.id);

  if v_remaining = 0 then
    raise exception
      'refused: this is the last active administrator. Appoint another before suspending, deactivating or deleting this account (PRD §3.4).'
      using errcode = 'integrity_constraint_violation';
  end if;

  return new;
end
$$;

drop trigger if exists users_guard_last_admin on iam.users;
create trigger users_guard_last_admin
  before update on iam.users
  for each row execute function iam.guard_last_administrator();

-- -------------------------------------------------------- login throttle
/**
 * Per-account lockout. Supabase Auth rate-limits per IP and has no account
 * lockout at all, so PRD §14's "login throttling, account lockout" has to be
 * ours. Returns the lockout expiry when the account is now locked.
 */
create or replace function iam.register_login_attempt(
  p_email        text,
  p_user_id      uuid,
  p_succeeded    boolean,
  p_failure_kind text default null,
  p_ip           inet default null,
  p_user_agent   text default null,
  p_threshold    int default 5,
  p_lockout      interval default interval '15 minutes'
)
  returns timestamptz
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_locked_until timestamptz;
begin
  insert into iam.login_attempts (email, user_id, succeeded, failure_kind, ip, user_agent)
  values (p_email, p_user_id, p_succeeded, p_failure_kind, p_ip, p_user_agent);

  if p_user_id is null then
    return null;   -- unknown email: recorded, but nothing to lock
  end if;

  if p_succeeded then
    update iam.users
    set failed_login_count = 0, locked_until = null, last_seen_at = now()
    where id = p_user_id;
    return null;
  end if;

  update iam.users
  set failed_login_count = failed_login_count + 1,
      locked_until = case
        when failed_login_count + 1 >= p_threshold then now() + p_lockout
        else locked_until
      end
  where id = p_user_id
  returning locked_until into v_locked_until;

  return v_locked_until;
end
$$;

-- --------------------------------------------------------- grants and RLS

grant execute on function
  iam.current_user_id(),
  iam.clearance_rank(text),
  iam.scope_rank(text),
  iam.is_administrator(uuid),
  iam.has_clearance(text, uuid),
  iam.effective_permissions(uuid),
  iam.has_permission(text, text, text, uuid),
  iam.permission_scope(text, text, uuid),
  iam.has_feature(text, uuid),
  iam.register_login_attempt(text, uuid, boolean, text, inet, text, int, interval)
to iims_app;

-- Reference data: readable by any identified IIMS user; only configurable with
-- the settings permission.
do $$
declare
  t text;
begin
  foreach t in array array['countries','offices','departments','classification_levels',
                           'features','permissions','roles']
  loop
    execute format('drop policy if exists %I_read on iam.%I', t, t);
    execute format($f$
      create policy %I_read on iam.%I
        for select to iims_app
        using (iam.current_user_id() is not null)
    $f$, t, t);

    execute format('drop policy if exists %I_write on iam.%I', t, t);
    execute format($f$
      create policy %I_write on iam.%I
        for all to iims_app
        using (iam.has_permission('settings', 'configure'))
        with check (iam.has_permission('settings', 'configure'))
    $f$, t, t);
  end loop;
end
$$;

-- iam.users: always your own record; others require the users permission.
drop policy if exists users_select on iam.users;
create policy users_select on iam.users
  for select to iims_app
  using (
    id = iam.current_user_id()
    or iam.has_permission('users', 'view')
  );

drop policy if exists users_insert on iam.users;
create policy users_insert on iam.users
  for insert to iims_app
  with check (iam.has_permission('users', 'create'));

drop policy if exists users_update on iam.users;
create policy users_update on iam.users
  for update to iims_app
  using (iam.has_permission('users', 'edit') or id = iam.current_user_id())
  with check (iam.has_permission('users', 'edit') or id = iam.current_user_id());

-- Deliberately no DELETE policy: removal is a soft delete (PRD §3.5), applied
-- as an UPDATE setting deleted_at.

-- Role assignments, overrides and features: visible for yourself so the
-- interface can show "every assigned role and the permissions each one
-- contributes" (PRD §3.2); managing them needs the users permission.
do $$
declare
  t text;
begin
  foreach t in array array['user_roles','user_permission_overrides','user_features']
  loop
    execute format('drop policy if exists %I_select on iam.%I', t, t);
    execute format($f$
      create policy %I_select on iam.%I
        for select to iims_app
        using (user_id = iam.current_user_id() or iam.has_permission('users', 'view'))
    $f$, t, t);

    execute format('drop policy if exists %I_write on iam.%I', t, t);
    execute format($f$
      create policy %I_write on iam.%I
        for all to iims_app
        using (iam.has_permission('users', 'assign'))
        with check (iam.has_permission('users', 'assign'))
    $f$, t, t);
  end loop;
end
$$;

-- Role permission/feature mapping and versions: read widely, write with
-- settings:configure.
do $$
declare
  t text;
begin
  foreach t in array array['role_permissions','role_features','role_versions',
                           'role_incompatibilities']
  loop
    execute format('drop policy if exists %I_read on iam.%I', t, t);
    execute format($f$
      create policy %I_read on iam.%I
        for select to iims_app
        using (iam.current_user_id() is not null)
    $f$, t, t);

    execute format('drop policy if exists %I_write on iam.%I', t, t);
    execute format($f$
      create policy %I_write on iam.%I
        for all to iims_app
        using (iam.has_permission('settings', 'configure'))
        with check (iam.has_permission('settings', 'configure'))
    $f$, t, t);
  end loop;
end
$$;

-- Two-person approvals: any administrator may see and decide them.
drop policy if exists access_requests_read on iam.access_change_requests;
create policy access_requests_read on iam.access_change_requests
  for select to iims_app
  using (requested_by = iam.current_user_id() or iam.is_administrator());

drop policy if exists access_requests_insert on iam.access_change_requests;
create policy access_requests_insert on iam.access_change_requests
  for insert to iims_app
  with check (requested_by = iam.current_user_id() and iam.is_administrator());

drop policy if exists access_requests_decide on iam.access_change_requests;
create policy access_requests_decide on iam.access_change_requests
  for update to iims_app
  using (iam.is_administrator())
  -- The CHECK constraint on the table already forbids self-approval; this
  -- keeps a non-administrator from touching the row at all.
  with check (iam.is_administrator());

-- Invitations: managed by whoever may create users.
drop policy if exists invitations_all on iam.user_invitations;
create policy invitations_all on iam.user_invitations
  for all to iims_app
  using (iam.has_permission('users', 'create'))
  with check (iam.has_permission('users', 'create'));

-- Login attempts: the application appends them (via the SECURITY DEFINER
-- function above); reading the history needs the audit permission.
drop policy if exists login_attempts_read on iam.login_attempts;
create policy login_attempts_read on iam.login_attempts
  for select to iims_app
  using (iam.has_permission('audit', 'view'));

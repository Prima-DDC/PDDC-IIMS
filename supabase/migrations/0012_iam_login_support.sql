-- PDDC IIMS 0012 : sign-in support.
--
-- The sign-in action runs before any actor is identified, so it cannot use the
-- permission-checked helpers. These two functions are deliberately narrow and
-- are only ever called by the server-side sign-in path.
--
-- Both are SECURITY DEFINER because they read auth.users, which iims_app has
-- no access to at all (see migration 0010).

-- ---------------------------------------------------------------------------
-- Resolves an email to its lockout state, so the sign-in form can refuse a
-- locked account and report the right thing.
--
-- It returns no row for an unknown email, and the caller gives the same
-- generic message either way, so this does not become an account-enumeration
-- oracle.
-- ---------------------------------------------------------------------------
create or replace function iam.login_state(p_email text)
  returns table (
    user_id       uuid,
    has_iims_user boolean,
    status        text,
    locked_until  timestamptz
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    au.id,
    (u.id is not null and u.deleted_at is null) as has_iims_user,
    u.status,
    u.locked_until
  from auth.users au
  left join iam.users u on u.id = au.id
  where lower(au.email) = lower(p_email)
  limit 1
$$;

grant execute on function iam.login_state(text) to iims_app;

-- ---------------------------------------------------------------------------
-- Records an attempt by email, resolving the user itself.
--
-- The sign-in path has an email and a result, not a user id. Resolving inside
-- the function keeps the email-to-id lookup out of the application, and means
-- an attempt against an unknown address is still recorded for the audit trail
-- without anything to lock.
--
-- Returns the lockout expiry when this attempt caused a lockout.
-- ---------------------------------------------------------------------------
create or replace function iam.register_login_attempt_by_email(
  p_email        text,
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
  v_user uuid;
begin
  select au.id into v_user
  from auth.users au
  where lower(au.email) = lower(p_email)
  limit 1;

  -- Only count against an account that actually exists in the IIMS; a website
  -- account with no IIMS access cannot be locked out of something it cannot
  -- reach anyway.
  if v_user is not null and not exists (
    select 1 from iam.users u where u.id = v_user and u.deleted_at is null
  ) then
    v_user := null;
  end if;

  return iam.register_login_attempt(
    p_email, v_user, p_succeeded, p_failure_kind, p_ip, p_user_agent,
    p_threshold, p_lockout
  );
end
$$;

grant execute on function
  iam.register_login_attempt_by_email(text, boolean, text, inet, text, int, interval)
to iims_app;

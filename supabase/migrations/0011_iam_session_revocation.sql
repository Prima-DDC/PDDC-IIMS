-- PDDC IIMS 0011 : real session revocation.
--
-- PRD 3.3 requires an administrator to be able to "force logout, revoke
-- sessions and trusted devices", and suspension to block login "immediately".
--
-- Supabase gives us no way to do this from the client SDK:
--   - auth.admin.signOut() requires the USER'S OWN JWT, which an
--     administrator does not have.
--   - There is no listUserSessions or deleteSession admin API in supabase-js
--     v2 (verified against the installed SDK types, which reject both).
--   - updateUserById({ ban_duration }) blocks future sign-ins but the docs
--     state plainly that it does NOT revoke existing sessions, and access
--     tokens are stateless JWTs that cannot be recalled.
--
-- Deleting the rows is therefore the only mechanism that actually works.
-- Verified that the migration role can do it. Removing the session cascades
-- to its refresh tokens, so the session cannot be renewed, and the
-- per-request liveness check in iam.resolve_actor() rejects the existing
-- access token on its very next use rather than waiting for it to expire.

create or replace function iam.revoke_user_sessions(
  p_user   uuid,
  p_reason text default null
)
  returns int
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_count int;
begin
  -- Revoking someone else's sessions is a user-administration action; a user
  -- may always sign themselves out everywhere.
  if not (iam.has_permission('users', 'edit') or p_user = iam.current_user_id()) then
    raise exception 'not permitted to revoke sessions for this user'
      using errcode = 'insufficient_privilege';
  end if;

  delete from auth.refresh_tokens where user_id = (
    select au.id::text from auth.users au where au.id = p_user
  );

  delete from auth.sessions where user_id = p_user;
  get diagnostics v_count = row_count;

  perform audit.write(
    'user.sessions_revoked', 'auth.sessions', p_user::text, null, null,
    jsonb_build_object('revoked', v_count), p_reason
  );

  return v_count;
end
$$;

grant execute on function iam.revoke_user_sessions(uuid, text) to iims_app;

-- ---------------------------------------------------------------------------
-- Revoking one specific session, for the "active sessions" list on a user's
-- profile where an administrator signs out a single device.
-- ---------------------------------------------------------------------------
create or replace function iam.revoke_session(
  p_session uuid,
  p_reason  text default null
)
  returns boolean
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_user uuid;
begin
  select user_id into v_user from auth.sessions where id = p_session;
  if v_user is null then
    return false;
  end if;

  if not (iam.has_permission('users', 'edit') or v_user = iam.current_user_id()) then
    raise exception 'not permitted to revoke this session'
      using errcode = 'insufficient_privilege';
  end if;

  delete from auth.sessions where id = p_session;

  perform audit.write(
    'user.session_revoked', 'auth.sessions', p_session::text, null, null,
    jsonb_build_object('userId', v_user), p_reason
  );

  return true;
end
$$;

grant execute on function iam.revoke_session(uuid, text) to iims_app;

-- ---------------------------------------------------------------------------
-- Recording MFA enrolment. Supabase owns the factors; the IIMS only needs to
-- know whether a user has completed enrolment, so the admin screens can show
-- who still has not (PRD 14 makes MFA mandatory).
-- ---------------------------------------------------------------------------
create or replace function iam.sync_mfa_enrolment(p_user uuid)
  returns timestamptz
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_first timestamptz;
begin
  select min(f.created_at) into v_first
  from auth.mfa_factors f
  where f.user_id = p_user and f.status = 'verified';

  update iam.users set mfa_enrolled_at = v_first where id = p_user;
  return v_first;
end
$$;

grant execute on function iam.sync_mfa_enrolment(uuid) to iims_app;

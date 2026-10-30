-- ---------------------------------------------------------------------------
-- 0052: a names-only staff directory every IIMS user can read.
--
-- PRD 6.2 requires a custody entry to record who released an item and who
-- received it. The pickers that ask those questions are filled from
-- `iam.users`, whose select policy is:
--
--   id = iam.current_user_id() OR iam.has_permission('users', 'view')
--
-- and PRD 16 gives `users` rights to CEO/Admin alone. So an investigator saw
-- exactly one name in the directory, their own, and could not record a
-- transfer to anybody: the one thing a chain of custody is for. An
-- administrator driving the same screen saw everybody, which is why it was
-- not noticed.
--
-- The same limit silently narrowed every other "who did this" picker. Those
-- happen to default to the current user, so they looked fine.
--
-- WHY NOT WIDEN `users_select`. Because a row of `iam.users` is not a name. It
-- carries clearance, status, failed login count, lockout time, MFA enrolment
-- and notes. Letting everybody read all of that in order to spell a colleague
-- correctly would be a far larger grant than the problem needs, and PRD 16
-- withholds `users` from investigators deliberately.
--
-- WHY NOT GRANT `users:view`. Same reason, and it would contradict PRD 16's
-- matrix.
--
-- So: naming a colleague is not user administration. A directory of active
-- people's names is the minimum PRD 6.2 needs, and this returns that and
-- nothing else, to anybody who already has IIMS access at all. Being able to
-- see that Kwame Mensah works here is not a disclosure; it is the staff list
-- the website already publishes.
-- ---------------------------------------------------------------------------

create or replace function iam.staff_directory()
returns table (id uuid, name text)
language sql
security definer
set search_path = ''
stable
as $$
  -- Only for somebody who is themselves an active IIMS user: this is not a
  -- public list, and a caller outside `withActor` has no identity, so
  -- `current_user_id()` is null and nothing comes back.
  select u.id,
         coalesce(nullif(btrim(p.full_name), ''), p.email) as name
  from iam.users u
  join public.profiles p on p.id = u.id
  where u.status = 'active'
    and u.deleted_at is null
    and exists (
      select 1 from iam.users me
      where me.id = iam.current_user_id()
        and me.status = 'active'
        and me.deleted_at is null
    )
  order by name;
$$;

comment on function iam.staff_directory is
  'PRD 6.2: a custody entry names who released and who received an item, so '
  'every IIMS user needs to be able to spell a colleague. Returns id and name '
  'only, never clearance, status or anything else on iam.users, and only to '
  'an active IIMS user.';

revoke all on function iam.staff_directory() from public;
grant execute on function iam.staff_directory() to iims_app;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_ok boolean;
  v_count integer;
begin
  select p.prosecdef and p.proconfig @> array['search_path=""']
  into v_ok
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'iam' and p.proname = 'staff_directory';

  if v_ok is not true then
    raise exception
      'iam.staff_directory must be SECURITY DEFINER with search_path pinned';
  end if;

  if has_function_privilege('public', 'iam.staff_directory()', 'execute') then
    raise exception 'PUBLIC can execute iam.staff_directory';
  end if;

  if not has_function_privilege('iims_app', 'iam.staff_directory()', 'execute') then
    raise exception 'iims_app cannot execute iam.staff_directory';
  end if;

  -- It returns two columns and no more. The point of the function is what it
  -- does NOT return, so that is what is asserted.
  select count(*)
  into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join unnest(p.proargnames) as arg
  where n.nspname = 'iam' and p.proname = 'staff_directory';

  if v_count <> 2 then
    raise exception
      'iam.staff_directory should return exactly id and name, found % output columns',
      v_count;
  end if;

  -- And `iam.users` is still closed to anyone without users:view, so this
  -- function remains the only widening.
  if exists (
    select 1 from pg_policy p
    where p.polrelid = 'iam.users'::regclass
      and p.polname = 'users_select'
      and pg_get_expr(p.polqual, p.polrelid) not like '%has_permission%'
  ) then
    raise exception 'the iam.users select policy no longer requires users:view';
  end if;
end $$;

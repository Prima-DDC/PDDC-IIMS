-- ---------------------------------------------------------------------------
-- 0057: who to tell, when the answer is "whoever can deal with it".
--
-- Several of PRD 12.1's notifications have an audience rather than a
-- recipient, and the audience is defined by what somebody is allowed to do:
--
--   PRD 8.3: a possible conflict needs a MANAGER to decide it, and until one
--   does, the enquiry cannot become a case. Telling only the person who ran
--   the check tells the one person who is not allowed to resolve it.
--
--   PRD 5.8: a missed safety check-in alerts the supervisor and the
--   Operations Manager. Nobody is named in advance, because who is on duty
--   depends on the case.
--
--   PRD 12.1: an integrity failure has to reach whoever can act on a broken
--   exhibit, which is a permission and not a person.
--
-- Working that out in the application would mean reading `iam.users`, whose
-- select policy requires `users:view`, so an investigator's action could not
-- find the manager to tell. The same shape of problem as 0052, and the same
-- answer: a function that returns the minimum.
--
-- WHAT IT RETURNS IS IDS AND NOTHING ELSE. Not names, not email addresses,
-- not roles. A uuid is useless on its own: it is passed straight back into
-- `notify.publish`, which reads the directory itself. So a caller learns how
-- many people can approve a conflict and no more, which is not a disclosure
-- about any of them.
--
-- A loop over the user table, calling `iam.has_permission` per row, is the
-- obvious implementation and the right one here. Effective permissions are
-- the union of roles, grants and denies, resolved by that function, and
-- re-deriving the union in a join would be a second copy of the rule that
-- could disagree with the first. PDDC has fourteen employees; a correct
-- answer from the one authority on the question is worth more than a clever
-- query, and if the staff list ever reaches a size where this matters, the
-- index to add is on the permission resolution rather than here.
-- ---------------------------------------------------------------------------

create or replace function iam.permission_holders(
  p_resource text,
  p_action   text
)
returns table (id uuid)
language sql
security definer
set search_path = ''
stable
as $$
  -- Only for an active IIMS user or a named system process: the scheduled
  -- scans that raise safety and integrity alerts have no signed-in user, and
  -- they are the callers that need this most.
  select u.id
  from iam.users u
  where u.status = 'active'
    and u.deleted_at is null
    and iam.has_permission(p_resource, p_action, null, u.id)
    and (
      nullif(current_setting('iims.system_process', true), '') is not null
      or exists (
        select 1 from iam.users me
        where me.id = iam.current_user_id()
          and me.status = 'active'
          and me.deleted_at is null
      )
    );
$$;

comment on function iam.permission_holders(text, text) is
  'The ids of active users who hold a permission, for notifications whose '
  'audience is defined by what somebody may do (PRD 5.8, 8.3, 12.1). Returns '
  'ids only, never names, addresses or roles, and only to an active IIMS user '
  'or a named system process.';

revoke all on function iam.permission_holders(text, text) from public;
grant execute on function iam.permission_holders(text, text) to iims_app;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'iam' and p.proname = 'permission_holders'
      and p.prosecdef and p.proconfig @> array['search_path=""']
  ) then
    raise exception
      'iam.permission_holders must be SECURITY DEFINER with search_path pinned';
  end if;

  if has_function_privilege('public', 'iam.permission_holders(text, text)', 'execute') then
    raise exception 'PUBLIC can execute iam.permission_holders';
  end if;

  -- One output column. The point of the function is what it does not return,
  -- so that is what is asserted.
  select count(*)
  into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join unnest(p.proargnames) as arg
  where n.nspname = 'iam' and p.proname = 'permission_holders'
    and arg = 'id';

  if v_count <> 1 then
    raise exception
      'iam.permission_holders should return exactly id, found % matching output columns',
      v_count;
  end if;

  -- With no identity at all it returns nobody, which is the fail-closed half.
  perform set_config('iims.user_id', '', true);
  perform set_config('iims.system_process', '', true);

  select count(*) into v_count from iam.permission_holders('conflicts', 'approve');
  if v_count <> 0 then
    raise exception
      'iam.permission_holders answered a caller with no identity, returning % rows',
      v_count;
  end if;

  -- And an administrator can be found, which is the fail-open half: a
  -- function that returned nobody to everybody would silently stop every
  -- audience notification and look like working code.
  perform set_config('iims.system_process', 'probe', true);

  select count(*) into v_count from iam.permission_holders('conflicts', 'approve');
  if v_count = 0 then
    raise exception
      'nobody at all holds conflicts:approve, so no conflict could ever be decided';
  end if;

  perform set_config('iims.system_process', '', true);
end $$;

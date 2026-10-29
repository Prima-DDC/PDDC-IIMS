-- PDDC IIMS 0041 : the entity SELECT policy must read the row it is deciding
-- about.
--
-- 0037 added "whoever recorded an entity can see it" to
-- `intel.can_reach_entity`, as a lookup: `select 1 from intel.entities e
-- where e.id = p_entity_id and e.created_by = iam.current_user_id()`. That is
-- correct for a row that exists, and useless for the one case it was added
-- for.
--
-- `INSERT ... RETURNING` applies the SELECT policy to the new row, and a
-- query issued from inside that same command cannot see the row the command
-- is inserting. So the lookup returned false, the SELECT policy failed, and
-- Postgres reported "new row violates row-level security policy", which
-- reads like the INSERT policy refusing, and is not.
--
-- Every registration of a subject by an Investigator failed. Proved by
-- running the insert as `iims_app` with the actor's settings: without
-- RETURNING it succeeds, with RETURNING it is refused, and
-- `iam.has_permission('entities','create','CONFIDENTIAL')` is true throughout.
--
-- WHY THE INTEGRATION TESTS DID NOT CATCH IT
-- The repository test harness connects as `postgres`, which Supabase grants
-- BYPASSRLS, so it never evaluated the policy at all. The containment test
-- that connects as `iims_app` now covers this, which is where a claim about
-- what the application role can reach belongs.
--
-- THE FIX
-- The policy reads `created_by` from the row it is given, because only the
-- policy has that row. `intel.can_reach_entity` keeps the two clauses that
-- are about other tables, where a lookup is the only way to answer them.
--
-- The author rule is therefore stated in one place and only one: the policy.
-- The function's own author clause is removed rather than left as a harmless
-- duplicate, because two copies of a rule is how the two copies come to
-- disagree.

create or replace function intel.can_reach_entity(p_entity_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    iam.scope_rank(iam.permission_scope('entities', 'view'))
      >= iam.scope_rank('all')
    or exists (
      select 1
      from intel.case_subjects s
      where s.entity_id = p_entity_id
        and s.removed_at is null
        and casework.can_reach_case(s.case_id, 'view')
    )
$$;

comment on function intel.can_reach_entity(uuid) is
  'Whether the current actor can see an entity through something other than '
  'having recorded it: at "all" scope, or through a case the entity is a '
  'subject of. The author rule lives in entities_select, because only a '
  'policy has the row and INSERT ... RETURNING evaluates it on a row no '
  'query can yet see.';

drop policy if exists entities_select on intel.entities;
create policy entities_select on intel.entities
  for select to iims_app
  using (
    deleted_at is null
    and iam.has_permission('entities', 'view', intel.entities.classification)
    and (
      -- Read from the row, not looked up. This is the clause that makes
      -- `insert ... returning` work for the role that registers subjects,
      -- and it is why it cannot live in a function.
      intel.entities.created_by = iam.current_user_id()
      or intel.can_reach_entity(intel.entities.id)
    )
  );

-- ---------------------------------------------------------------------------
-- The same shape, checked everywhere else in the platform.
--
-- A SELECT policy that calls a function which re-reads its own table has this
-- defect wherever it appears, so this asserts that `intel.entities` was the
-- only one. Every other reach function reads a DIFFERENT table
-- (`casework.cases`, `reporting.reports`, and so on), which an in-flight row
-- does not affect.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(format('%s.%s (%s)', schemaname, tablename, policyname), ', ')
  into v_bad
  from pg_catalog.pg_policies
  where schemaname in ('iam', 'crm', 'casework', 'evidence', 'docs', 'intel',
                       'reporting', 'notify', 'config')
    and cmd in ('SELECT', 'ALL')
    and qual is not null
    -- A policy whose expression names a reach function taking only this
    -- table's own id is the pattern that breaks.
    and qual like '%can_reach_entity%'
    and tablename <> 'entities';

  if v_bad is not null then
    raise exception
      'these policies call intel.can_reach_entity and may have the same in-flight row problem: %',
      v_bad;
  end if;
end
$$;

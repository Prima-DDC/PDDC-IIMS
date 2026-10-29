-- PDDC IIMS 0029 : the case policies must not read the table they protect.
--
-- THE DEFECT
-- 0025 wrote the cases policies in terms of casework.can_reach_case(id), which
-- is convenient and reads well, and which works for every CHILD table because
-- there the function queries a different table from the one being written.
--
-- On casework.cases itself it is wrong, and wrong in a way that is invisible
-- until something tries it. can_reach_case is STABLE and does
-- `select exists (select 1 from casework.cases c where c.id = p_case_id ...)`,
-- so it evaluates against the snapshot taken at the start of the statement. A
-- row being INSERTed is not in that snapshot. The SELECT policy therefore
-- returns false for the row just written, and because Postgres applies the
-- SELECT policy to the rows an INSERT returns, every
-- `insert into casework.cases ... returning id` was refused with
--
--   new row violates row-level security policy for table "cases"
--
-- which points at the WITH CHECK and is not where the problem was: the insert
-- itself was fine, and the identical statement without RETURNING succeeded.
-- Opening a case was impossible through the application, while every direct
-- test of the permissions said it should work.
--
-- The UPDATE policy had a quieter version of the same fault. Its WITH CHECK
-- also went through can_reach_case, which read the row as it was BEFORE the
-- update, so the classification being checked was the old one. Raising a
-- case's classification above the editor's own clearance would have passed.
--
-- THE FIX
-- The cases policies are rewritten over the row's own columns, so nothing
-- re-reads casework.cases. The rule itself is not duplicated: it moves into
-- casework.can_reach(), which takes the classification as an argument, and
-- can_reach_case() becomes a thin lookup in front of it for the child tables
-- that legitimately want to pass only an id.

/**
 * May the current actor act on a case with this classification?
 *
 * Takes the classification rather than looking it up, so a policy can call it
 * with the row's own column and nothing has to read the table being written.
 *
 * Three ways in, and no others:
 *   a permission at `all` scope, which is what supervision needs;
 *   a permission at a narrower scope plus a live assignment;
 *   nothing.
 *
 * The classification ceiling and the actor's own clearance apply either way,
 * so holding cases:view at `all` does not open a case above their clearance.
 */
create or replace function casework.can_reach(
  p_case_id        uuid,
  p_classification text,
  p_action         text default 'view'
)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    iam.has_permission('cases', p_action, p_classification)
    and (
      iam.scope_rank(iam.permission_scope('cases', p_action))
        >= iam.scope_rank('all')
      or iam.is_assigned_to_case(p_case_id)
    )
$$;

grant execute on function casework.can_reach(uuid, text, text) to iims_app;

comment on function casework.can_reach(uuid, text, text) is
  'The case reach rule, over a classification passed in. Policies on '
  'casework.cases call this with the row own columns so that nothing re-reads '
  'the table being written: a STABLE function cannot see a row inserted by the '
  'same statement, which silently broke INSERT ... RETURNING (see 0029).';

-- can_reach_case keeps its signature for the child tables, which pass an id
-- and are never the table being inserted into, and now delegates so there is
-- one definition of the rule.
create or replace function casework.can_reach_case(
  p_case_id uuid,
  p_action text default 'view'
)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1 from casework.cases c
    where c.id = p_case_id
      and casework.can_reach(c.id, c.classification, p_action)
  )
$$;

-- ---------------------------------------------------------------------------
-- The cases policies, over the row's own columns.
-- ---------------------------------------------------------------------------
drop policy if exists cases_select on casework.cases;
create policy cases_select on casework.cases
  for select to iims_app
  using (deleted_at is null and casework.can_reach(id, classification, 'view'));

drop policy if exists cases_update on casework.cases;
create policy cases_update on casework.cases
  for update to iims_app
  -- USING sees the row as it is, WITH CHECK sees it as it will be. Both are
  -- checked, so an editor can neither edit a case they cannot reach nor move
  -- one to a classification they could not then open.
  using (casework.can_reach(id, classification, 'edit'))
  with check (casework.can_reach(id, classification, 'edit'));

-- cases_insert already read only the new row's classification and was never
-- affected; it is restated here so all three live together and the next reader
-- does not have to go back to 0025 to find it.
drop policy if exists cases_insert on casework.cases;
create policy cases_insert on casework.cases
  for insert to iims_app
  with check (iam.has_permission('cases', 'create', classification));

-- PDDC IIMS 0025 : row-level security for the casework schema.
--
-- The authoritative check is still the one in the use case (PRD 14, "deny by
-- default" on every request). These policies are the second line: a query that
-- reaches the database without one returns nothing rather than everything.
--
-- Everything here routes through casework.can_reach_case(), which is where the
-- rule lives: a permission at `all` scope reaches every case, a permission at
-- `assigned` scope reaches only the cases the actor holds a live assignment
-- on, and the classification ceiling applies either way. Writing that once and
-- calling it from every table is the point; PRD 20.2 requires an unassigned
-- investigator to get nothing "via API, via global search and via direct URL",
-- and three different spellings of the rule would eventually disagree about
-- one of those.
--
-- NOTE ON QUALIFYING THE OUTER COLUMN
-- The same trap as 0020. casework.cases has BOTH `id` (uuid) and `case_id`
-- (the human-readable PDDC-YYYY-NNNNNN text), while every child table has
-- `case_id` as a uuid pointing at cases.id. Inside a subquery over
-- casework.cases an unqualified `case_id` therefore binds to the TEXT column
-- and the policy fails to create with "operator does not exist: uuid = text".
-- can_reach_case() takes the uuid directly, which avoids the subquery
-- entirely; where a subquery is unavoidable the outer column is written out in
-- full.

-- ---------------------------------------------------------------------------
-- Cases.
-- ---------------------------------------------------------------------------
drop policy if exists cases_select on casework.cases;
create policy cases_select on casework.cases
  for select to iims_app
  using (deleted_at is null and casework.can_reach_case(id, 'view'));

-- The recycle bin needs the soft-deleted ones, and only with delete rights.
drop policy if exists cases_select_deleted on casework.cases;
create policy cases_select_deleted on casework.cases
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('cases', 'delete', classification)
  );

drop policy if exists cases_insert on casework.cases;
create policy cases_insert on casework.cases
  for insert to iims_app
  with check (iam.has_permission('cases', 'create', classification));

-- Editing needs to reach the case AND hold cases:edit on it. An investigator
-- assigned to a case can edit it; one who is not cannot, even though they hold
-- cases:edit at `assigned` scope.
drop policy if exists cases_update on casework.cases;
create policy cases_update on casework.cases
  for update to iims_app
  using (casework.can_reach_case(id, 'edit'))
  with check (casework.can_reach_case(id, 'edit'));

-- No DELETE policy anywhere in this schema, and no DELETE privilege either
-- (0024). Removal is a soft delete applied as an UPDATE.

-- ---------------------------------------------------------------------------
-- Assignments.
--
-- Readable by anybody who can reach the case, because "who is on this" is part
-- of understanding a case. Writable only with cases:assign, which is a
-- narrower permission than editing: putting somebody on a case gives them
-- access to it, so it is the one edit that changes who can see what.
-- ---------------------------------------------------------------------------
drop policy if exists case_assignments_select on casework.case_assignments;
create policy case_assignments_select on casework.case_assignments
  for select to iims_app
  using (
    casework.can_reach_case(casework.case_assignments.case_id, 'view')
    -- A person can always see their own assignment, which is what makes the
    -- "my cases" list work before the case itself is reachable.
    or user_id = iam.current_user_id()
  );

drop policy if exists case_assignments_insert on casework.case_assignments;
create policy case_assignments_insert on casework.case_assignments
  for insert to iims_app
  with check (
    casework.can_reach_case(casework.case_assignments.case_id, 'assign')
  );

drop policy if exists case_assignments_update on casework.case_assignments;
create policy case_assignments_update on casework.case_assignments
  for update to iims_app
  using (casework.can_reach_case(casework.case_assignments.case_id, 'assign'))
  with check (casework.can_reach_case(casework.case_assignments.case_id, 'assign'));

-- ---------------------------------------------------------------------------
-- Objectives, risk, scope and communications all inherit the case.
--
-- Written as a loop because the rule is identical for each: readable if the
-- case is readable, writable if the case is editable. Repeating it five times
-- by hand is how the five drift apart.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['case_objectives','risk_assessments',
                           'scope_change_requests','case_communications']
  loop
    execute format('drop policy if exists %I_select on casework.%I', t, t);
    execute format($f$
      create policy %I_select on casework.%I
        for select to iims_app
        using (casework.can_reach_case(casework.%I.case_id, 'view'))
    $f$, t, t, t);

    execute format('drop policy if exists %I_insert on casework.%I', t, t);
    execute format($f$
      create policy %I_insert on casework.%I
        for insert to iims_app
        with check (casework.can_reach_case(casework.%I.case_id, 'edit'))
    $f$, t, t, t);

    execute format('drop policy if exists %I_update on casework.%I', t, t);
    execute format($f$
      create policy %I_update on casework.%I
        for update to iims_app
        using (casework.can_reach_case(casework.%I.case_id, 'edit'))
        with check (casework.can_reach_case(casework.%I.case_id, 'edit'))
    $f$, t, t, t, t);
  end loop;
end
$$;

-- A scope version is read like the rest, and inserted like the rest, but never
-- updated: the trigger in 0022 refuses it and there is deliberately no UPDATE
-- policy, so the application cannot even reach the trigger.
drop policy if exists scope_versions_select on casework.scope_versions;
create policy scope_versions_select on casework.scope_versions
  for select to iims_app
  using (casework.can_reach_case(casework.scope_versions.case_id, 'view'));

drop policy if exists scope_versions_insert on casework.scope_versions;
create policy scope_versions_insert on casework.scope_versions
  for insert to iims_app
  with check (casework.can_reach_case(casework.scope_versions.case_id, 'edit'));

-- A communication is a record of something that was said, so one stricter than
-- its case is possible: a client's instruction may be RESTRICTED on a
-- CONFIDENTIAL case. Its own classification is therefore checked in addition
-- to the case, which replaces the select policy the loop above just made. The
-- loop's insert and update policies are correct as they stand and are left.
drop policy if exists case_communications_select on casework.case_communications;
create policy case_communications_select on casework.case_communications
  for select to iims_app
  using (
    deleted_at is null
    and iam.has_permission('cases', 'view', classification)
    and casework.can_reach_case(casework.case_communications.case_id, 'view')
  );

-- ---------------------------------------------------------------------------
-- The configuration the lifecycle reads.
--
-- Readable by everybody who can see a case, because the status badge, the
-- progress rail and the list of legal next steps all come from here and a case
-- without them renders as a blank. Writable only with settings:configure,
-- which is what PRD 4.3's "administrators can rename, add or reorder stages"
-- means.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['workflow_definitions','workflow_stages',
                           'workflow_transitions','case_types']
  loop
    execute format('drop policy if exists %I_select on config.%I', t, t);
    execute format($f$
      create policy %I_select on config.%I
        for select to iims_app
        using (iam.has_permission('cases', 'view'))
    $f$, t, t);
  end loop;
end
$$;

-- Configuring the lifecycle, spelled out rather than looped, because each
-- table needs insert, update and delete and the loop above would not read any
-- more clearly for carrying three more statements.
do $$
declare
  t text;
begin
  foreach t in array array['workflow_definitions','workflow_stages',
                           'workflow_transitions','case_types']
  loop
    execute format('drop policy if exists %I_write on config.%I', t, t);
    execute format($f$
      create policy %I_write on config.%I
        for all to iims_app
        using (iam.has_permission('settings', 'configure'))
        with check (iam.has_permission('settings', 'configure'))
    $f$, t, t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- The identifier sequence table stays policy-free: it is written only through
-- config.next_human_id(), which is SECURITY DEFINER.
-- ---------------------------------------------------------------------------

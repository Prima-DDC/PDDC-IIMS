-- PDDC IIMS 0023 : the default lifecycle, case types, and the access rules
-- that make a case need-to-know (PRD 4.2, 4.3, 5.2, 16).
--
-- The lifecycle PRD 4.2 names is seeded as DATA, so PDDC can rename, reorder
-- or add stages without a migration (PRD 4.3). The transitions are seeded too,
-- which is what lets the server reject "Draft Report straight to Closed" by
-- looking it up rather than by hard-coding it.

-- ---------------------------------------------------------------------------
-- Case types (PRD 5.2).
-- ---------------------------------------------------------------------------
insert into config.case_types (key, name, position) values
  ('due_diligence',           'Due Diligence',            10),
  ('corporate_investigation', 'Corporate Investigation',   20),
  ('insurance_investigation', 'Insurance Investigation',   30),
  ('fraud_investigation',     'Fraud Investigation',       40),
  ('background_investigation','Background Investigation',  50),
  ('employee_screening',      'Employee Screening',        60),
  ('asset_search',            'Asset Search',              70),
  ('corporate_intelligence',  'Corporate Intelligence',    80),
  ('digital_investigation',   'Digital Investigation',      90),
  ('surveillance',            'Surveillance',             100),
  ('other',                   'Other',                    110)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The default lifecycle.
--
-- PRD 4.2 lists: New, Pending Approval, Approved, Assigned, Investigation in
-- Progress, Awaiting Information, Analysis, Draft Report, Quality Review,
-- Approved, Delivered, Completed, Closed, Archived.
--
-- "Approved" appears twice in that list: once for the case being approved to
-- start, once for the report being approved. They are different states and a
-- key has to be unique, so the second is seeded as `report_approved` with the
-- name "Report Approved". Calling both "Approved" would make the status badge
-- ambiguous exactly where it matters most.
-- ---------------------------------------------------------------------------
insert into config.workflow_definitions (key, name, description, is_default)
values (
  'pddc_default',
  'PDDC standard investigation lifecycle',
  'The lifecycle in PRD 4.2. Administrators may rename, reorder or add stages.',
  true
)
on conflict (key) do nothing;

do $$
declare
  v_def uuid;
  v_stage record;
begin
  select id into v_def from config.workflow_definitions where key = 'pddc_default';

  -- key, name, position, methodology stage, terminal, needs approval
  for v_stage in
    select * from (values
      ('new',                 'New',                       10, 'planning',     false, false),
      ('pending_approval',    'Pending Approval',          20, 'planning',     false, true),
      ('approved',            'Approved',                  30, 'planning',     false, false),
      ('assigned',            'Assigned',                  40, 'planning',     false, false),
      ('in_progress',         'Investigation in Progress', 50, 'collection',   false, false),
      ('awaiting_information','Awaiting Information',      60, 'collection',   false, false),
      ('analysis',            'Analysis',                  70, 'analysis',     false, false),
      ('draft_report',        'Draft Report',              80, 'reporting',    false, false),
      ('quality_review',      'Quality Review',            90, 'reporting',    false, true),
      ('report_approved',     'Report Approved',          100, 'reporting',    false, true),
      ('delivered',           'Delivered',                110, 'reporting',    false, false),
      ('completed',           'Completed',                120, 'assessment',   false, false),
      ('closed',              'Closed',                   130, 'assessment',   true,  true),
      ('archived',            'Archived',                 140, 'assessment',   true,  false)
    ) as s(key, name, position, methodology_stage, is_terminal, requires_approval)
  loop
    insert into config.workflow_stages
      (definition_id, key, name, position, methodology_stage, is_terminal, requires_approval)
    values
      (v_def, v_stage.key, v_stage.name, v_stage.position,
       v_stage.methodology_stage, v_stage.is_terminal, v_stage.requires_approval)
    on conflict (definition_id, key) do nothing;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- The legal transitions.
--
-- The happy path forward, plus the moves real investigations need: sending
-- something back for more work, parking a case that is waiting on a third
-- party, and returning a report from quality review. Anything not listed is
-- refused, which is what PRD 4.2 asks for.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def uuid;
  v_t record;
  v_from uuid;
  v_to uuid;
begin
  select id into v_def from config.workflow_definitions where key = 'pddc_default';

  for v_t in
    select * from (values
      -- Getting a case started.
      ('new',                 'pending_approval',    null),
      ('pending_approval',    'approved',            'cases:approve'),
      ('pending_approval',    'new',                 null),
      ('approved',            'assigned',            'cases:assign'),
      ('assigned',            'in_progress',         null),

      -- Doing the work. Awaiting Information is a parking state, so it is
      -- reachable from and returnable to the stages where waiting happens.
      ('in_progress',         'awaiting_information', null),
      ('awaiting_information','in_progress',          null),
      ('in_progress',         'analysis',             null),
      ('analysis',            'in_progress',          null),
      ('analysis',            'awaiting_information', null),
      ('awaiting_information','analysis',             null),

      -- Reporting. Quality Review can return the draft, which is the whole
      -- point of having a review stage (PRD 10.1).
      ('analysis',            'draft_report',         null),
      ('draft_report',        'quality_review',       null),
      ('quality_review',      'draft_report',         null),
      ('quality_review',      'report_approved',      'reports:approve'),
      ('report_approved',     'delivered',            null),

      -- Finishing. Closure is gated by PRD 5.9's checklist in the use case as
      -- well as by this permission.
      ('delivered',           'completed',            null),
      ('completed',           'closed',               'cases:close'),
      ('closed',              'archived',             'cases:archive')
    ) as t(from_key, to_key, required_permission)
  loop
    select id into v_from from config.workflow_stages
      where definition_id = v_def and key = v_t.from_key;
    select id into v_to from config.workflow_stages
      where definition_id = v_def and key = v_t.to_key;

    insert into config.workflow_transitions
      (definition_id, from_stage_id, to_stage_id, required_permission)
    values (v_def, v_from, v_to, v_t.required_permission)
    on conflict (definition_id, from_stage_id, to_stage_id) do nothing;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Permission atoms for casework (PRD 16).
--
-- First, two new verbs. 0006 fixed the action vocabulary at view, create,
-- edit, upload, download, share, approve, delete, export, assign and
-- configure. Casework needs two more, and neither is a synonym of anything
-- already there:
--
--   `close` is PRD 5.9's "Supervisor approves closure", which is gated on a
--   checklist that approving a report has nothing to do with. Folding it into
--   `approve` would mean whoever can approve a report can close a case.
--
--   `archive` is the step after closure, and the PRD treats it as a separate
--   terminal state with its own gate.
--
-- The constraint is widened rather than dropped, so an action outside the
-- vocabulary is still refused: the point of the list is that a typo in a
-- permission grant fails loudly instead of creating an atom nothing checks.
-- ---------------------------------------------------------------------------
alter table iam.permissions drop constraint if exists permissions_action_check;
alter table iam.permissions
  add constraint permissions_action_check
    check (action in ('*','view','create','edit','upload','download','share',
                      'approve','delete','export','assign','configure',
                      'close','archive'));

do $$
declare
  v_role text;
begin
  -- Everybody who works a case can see the ones they are on. `scope` is what
  -- narrows that: `assigned` means "only cases I am assigned to", which the
  -- RLS policy below reads.
  perform config.grant_role_permission('investigator', 'cases', 'view', 'assigned', 'CONFIDENTIAL');
  perform config.grant_role_permission('investigator', 'cases', 'edit', 'assigned', 'CONFIDENTIAL');
  perform config.grant_role_permission('investigator', 'tasks', 'view', 'assigned', 'CONFIDENTIAL');
  perform config.grant_role_permission('investigator', 'tasks', 'edit', 'assigned', 'CONFIDENTIAL');
  perform config.grant_role_permission('investigator', 'tasks', 'create', 'assigned', 'CONFIDENTIAL');

  perform config.grant_role_permission('analyst', 'cases', 'view', 'assigned', 'CONFIDENTIAL');
  perform config.grant_role_permission('analyst', 'cases', 'edit', 'assigned', 'CONFIDENTIAL');
  perform config.grant_role_permission('analyst', 'tasks', 'view', 'assigned', 'CONFIDENTIAL');
  perform config.grant_role_permission('analyst', 'tasks', 'edit', 'assigned', 'CONFIDENTIAL');

  perform config.grant_role_permission('forensics', 'cases', 'view', 'assigned', 'CONFIDENTIAL');
  perform config.grant_role_permission('forensics', 'tasks', 'view', 'assigned', 'CONFIDENTIAL');
  perform config.grant_role_permission('forensics', 'tasks', 'edit', 'assigned', 'CONFIDENTIAL');

  -- A supervisor sees every case, because supervising a subset of cases you
  -- happen to be named on is not supervision.
  for v_role in select unnest(array['supervisor','manager','operations_manager']) loop
    perform config.grant_role_permission(v_role, 'cases', 'view',   'all', 'RESTRICTED');
    perform config.grant_role_permission(v_role, 'cases', 'edit',   'all', 'RESTRICTED');
    perform config.grant_role_permission(v_role, 'cases', 'create', 'all', 'RESTRICTED');
    perform config.grant_role_permission(v_role, 'cases', 'assign', 'all', 'RESTRICTED');
    perform config.grant_role_permission(v_role, 'tasks', 'view',   'all', 'RESTRICTED');
    perform config.grant_role_permission(v_role, 'tasks', 'edit',   'all', 'RESTRICTED');
    perform config.grant_role_permission(v_role, 'tasks', 'create', 'all', 'RESTRICTED');
  end loop;

  -- Approving and closing are narrower than editing.
  perform config.grant_role_permission('operations_manager', 'cases', 'approve', 'all', 'RESTRICTED');
  perform config.grant_role_permission('operations_manager', 'cases', 'delete',  'all', 'RESTRICTED');
  perform config.grant_role_permission('operations_manager', 'cases', 'archive', 'all', 'RESTRICTED');
  perform config.grant_role_permission('supervisor',         'cases', 'close',   'all', 'RESTRICTED');
  perform config.grant_role_permission('operations_manager', 'cases', 'close',   'all', 'RESTRICTED');

  -- Read-only oversight.
  perform config.grant_role_permission('ceo',                'cases', 'view', 'all', 'RESTRICTED');
  perform config.grant_role_permission('coo',                'cases', 'view', 'all', 'RESTRICTED');
  perform config.grant_role_permission('legal_counsel',      'cases', 'view', 'all', 'RESTRICTED');
  perform config.grant_role_permission('compliance_officer', 'cases', 'view', 'all', 'RESTRICTED');
  perform config.grant_role_permission('qa_reviewer',        'cases', 'view', 'all', 'RESTRICTED');
  perform config.grant_role_permission('auditor',            'cases', 'view', 'all', 'RESTRICTED');

  -- Finance sees that a case exists so it can bill, and nothing in it. The
  -- INTERNAL ceiling is what stops it opening a CONFIDENTIAL case record
  -- (PRD 3.1, 16).
  perform config.grant_role_permission('finance', 'cases', 'view', 'all', 'INTERNAL');
end
$$;

-- ---------------------------------------------------------------------------
-- Assignment-aware access.
--
-- PRD 16's `assigned` scope means "only the cases I am on", and PRD 20.2
-- requires that an unassigned investigator gets nothing "via API, via global
-- search and via direct URL". That is one function, used by every casework
-- policy, so the rule cannot drift between tables.
-- ---------------------------------------------------------------------------
create or replace function iam.is_assigned_to_case(p_case_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1 from casework.case_assignments a
    where a.case_id = p_case_id
      and a.user_id = iam.current_user_id()
      and a.unassigned_at is null
  )
$$;

grant execute on function iam.is_assigned_to_case(uuid) to iims_app;

comment on function iam.is_assigned_to_case(uuid) is
  'True when the current actor holds a live assignment on the case. Read by '
  'every casework policy, so the `assigned` scope in PRD 16 means one thing.';

/**
 * Whether the actor may reach this case at all.
 *
 * Three ways in, and no others:
 *   a permission at `all` scope, which is what supervision needs;
 *   a permission at `assigned` scope plus a live assignment;
 *   nothing.
 *
 * The classification ceiling applies either way: holding cases:view at `all`
 * does not let somebody open a case classified above their clearance.
 */
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
      -- The classification ceiling and the user's own clearance are checked by
      -- has_permission either way, so holding cases:view at `all` still does
      -- not open a case classified above the holder's clearance.
      and iam.has_permission('cases', p_action, c.classification)
      and (
        -- `all` (or broader) reaches every case; anything narrower reaches
        -- only the cases the actor is actually assigned to. scope_rank is used
        -- rather than an equality test so a future `country` or `office` scope
        -- does not silently become the widest one.
        iam.scope_rank(iam.permission_scope('cases', p_action))
          >= iam.scope_rank('all')
        or iam.is_assigned_to_case(c.id)
      )
  )
$$;

grant execute on function casework.can_reach_case(uuid, text) to iims_app;

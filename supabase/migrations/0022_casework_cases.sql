-- PDDC IIMS 0022 : cases, assignment, objectives, risk and scope (PRD 5).
--
-- The case is the centre of the platform: "every screen is case-centric"
-- (PRD 18), and the relationship chain the whole system exists to protect runs
-- Case -> Subject -> Source -> Information -> Evidence -> Analysis -> Finding
-- -> Report. This migration builds the case itself and the four things PRD 5
-- says a case cannot be run without: who is on it, what it is for, what its
-- risks are, and what is in scope.
--
-- Four decisions here are not obvious, so each is argued where it is made:
--
--   The lifecycle is DATA, not a CHECK constraint, because PRD 4.3 lets PDDC
--   rename, add and reorder stages without code changes.
--
--   The objective is required, with an auditable override, because PRD 5.1
--   says "a case cannot be opened without an objective unless an authorised
--   user records an override with reason".
--
--   Scope is versioned and the original is immutable, because PRD 5.4 says
--   "the original approved scope is immutable and always viewable beside
--   revisions". A revision is a new row, never an edit.
--
--   Risk is a row per assessment, not columns on the case, because PRD 5.3
--   wants the assessor and date recorded and reassessment is normal.

-- ---------------------------------------------------------------------------
-- The configurable lifecycle (PRD 4.2, 4.3).
--
-- PRD 4.2 names the states and PRD 4.3 says PDDC administrators can rename,
-- add or reorder them "without code changes". That rules out an enum or a
-- CHECK constraint: both would need a migration to change. The states are
-- therefore rows, and the legal transitions are rows too, so the server can
-- reject an illegal transition (PRD 4.2 names Draft Report straight to Closed)
-- by looking it up rather than by consulting hard-coded code.
-- ---------------------------------------------------------------------------
create table if not exists config.workflow_definitions (
  id          uuid primary key default gen_random_uuid(),
  key         text unique not null,
  name        text not null,
  description text,
  -- Exactly one definition is in force for new cases at a time.
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     int not null default 1
);

create unique index if not exists workflow_one_default_idx
  on config.workflow_definitions ((true)) where is_default;

create table if not exists config.workflow_stages (
  id            uuid primary key default gen_random_uuid(),
  definition_id uuid not null references config.workflow_definitions (id) on delete cascade,
  key           text not null,
  name          text not null,
  -- Ordering is the progression shown on the case status rail.
  position      int  not null,
  -- The methodology stage this lifecycle state belongs to (PRD 4.3's
  -- Planning / Collection / Verification / Analysis / Assessment / Reporting),
  -- so a task can be filed under the right one.
  methodology_stage text,
  -- Terminal states cannot be left. Closed and Archived are terminal.
  is_terminal   boolean not null default false,
  -- A state that needs somebody's approval to enter, which the use case reads.
  requires_approval boolean not null default false,
  description   text,

  unique (definition_id, key),
  unique (definition_id, position)
);

create table if not exists config.workflow_transitions (
  id            uuid primary key default gen_random_uuid(),
  definition_id uuid not null references config.workflow_definitions (id) on delete cascade,
  from_stage_id uuid not null references config.workflow_stages (id) on delete cascade,
  to_stage_id   uuid not null references config.workflow_stages (id) on delete cascade,
  -- The permission needed to make this move, as resource:action. Null means
  -- the ordinary cases:edit is enough.
  required_permission text,
  -- Whether a reason is demanded. Every transition records one (PRD 4.2), but
  -- some demand that the user types it rather than it being implied.
  requires_reason boolean not null default true,

  unique (definition_id, from_stage_id, to_stage_id),
  constraint transition_goes_somewhere check (from_stage_id <> to_stage_id)
);

alter table config.workflow_definitions enable row level security;
alter table config.workflow_definitions force  row level security;
alter table config.workflow_stages      enable row level security;
alter table config.workflow_stages      force  row level security;
alter table config.workflow_transitions enable row level security;
alter table config.workflow_transitions force  row level security;

-- ---------------------------------------------------------------------------
-- Case types, also administrator-configurable (PRD 5.2).
-- ---------------------------------------------------------------------------
create table if not exists config.case_types (
  key         text primary key,
  name        text not null,
  description text,
  is_active   boolean not null default true,
  position    int not null default 0
);

alter table config.case_types enable row level security;
alter table config.case_types force  row level security;

-- ---------------------------------------------------------------------------
-- The case.
-- ---------------------------------------------------------------------------
create table if not exists casework.cases (
  id            uuid primary key default gen_random_uuid(),
  case_id       text unique not null default config.next_human_id('PDDC'),

  title         text not null,
  client_id     uuid not null references crm.clients (id),
  -- A case hangs off an engagement, never off the client directly: the
  -- engagement carries the instruction and the commercial terms the work is
  -- done under (PRD 8.2).
  engagement_id uuid not null references crm.engagements (id),

  case_type     text not null references config.case_types (key),
  jurisdiction_country char(2) references iam.countries (code),
  jurisdiction_region  text,
  office_id     uuid references iam.offices (id),

  priority      text not null default 'medium'
                  check (priority in ('low','medium','high','urgent')),
  -- The overall rating from the current risk assessment, cached here so lists
  -- and filters do not have to join. casework.risk_assessments is the record.
  risk_level    text not null default 'medium'
                  check (risk_level in ('low','medium','high','critical')),

  -- The lifecycle position. A reference rather than a string, so renaming a
  -- stage renames it everywhere at once.
  definition_id uuid not null references config.workflow_definitions (id),
  stage_id      uuid not null references config.workflow_stages (id),

  opened_at     timestamptz not null default now(),
  target_completion_at timestamptz,
  actual_completion_at timestamptz,

  classification text not null default 'CONFIDENTIAL'
                  references iam.classification_levels (code),

  -- Closure (PRD 5.9). The detail lives in casework.closures; these are what
  -- the case list needs.
  retention_class text,
  closure_summary text,
  closed_by     uuid references iam.users (id),
  closed_at     timestamptz,

  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references iam.users (id),
  version     int not null default 1,
  deleted_at  timestamptz,

  constraint case_target_after_opening
    check (target_completion_at is null or target_completion_at >= opened_at),
  constraint case_closed_together
    check ((closed_at is null) = (closed_by is null))
);

create index if not exists cases_client_idx on casework.cases (client_id);
create index if not exists cases_engagement_idx on casework.cases (engagement_id);
create index if not exists cases_stage_idx on casework.cases (stage_id) where deleted_at is null;
create index if not exists cases_priority_idx on casework.cases (priority) where deleted_at is null;
create index if not exists cases_opened_idx on casework.cases (opened_at desc);
create index if not exists cases_title_trgm_idx
  on casework.cases using gin (title extensions.gin_trgm_ops);

comment on table casework.cases is
  'The investigation itself. Case ID is PDDC-YYYY-NNNNNN, allocated '
  'server-side from a sequence (PRD 5). A case belongs to an engagement, not '
  'directly to a client.';

-- ---------------------------------------------------------------------------
-- Assignment (PRD 5.2).
--
-- A row per person per role rather than columns, because
-- `supporting_investigators[]` is a list and because an assignment has its own
-- history: who put somebody on a case, when, and why.
-- ---------------------------------------------------------------------------
create table if not exists casework.case_assignments (
  id        uuid primary key default gen_random_uuid(),
  case_id   uuid not null references casework.cases (id) on delete cascade,
  user_id   uuid not null references iam.users (id),
  role      text not null
              check (role in ('lead_investigator','supporting_investigator',
                              'supervisor','analyst','specialist',
                              'operations_manager','observer')),
  assigned_at  timestamptz not null default now(),
  assigned_by  uuid references iam.users (id),
  reason       text,
  -- Removal is recorded rather than deleted, so "who was on this case in
  -- March" stays answerable.
  unassigned_at timestamptz,
  unassigned_by uuid references iam.users (id),
  unassign_reason text
);

create index if not exists case_assignments_case_idx
  on casework.case_assignments (case_id) where unassigned_at is null;
create index if not exists case_assignments_user_idx
  on casework.case_assignments (user_id) where unassigned_at is null;

-- At most one lead investigator and one supervisor at a time. A partial unique
-- index rather than a service check, because two leads is the kind of thing
-- that happens through a race rather than through a mistake.
create unique index if not exists case_one_lead_idx
  on casework.case_assignments (case_id)
  where role = 'lead_investigator' and unassigned_at is null;
create unique index if not exists case_one_supervisor_idx
  on casework.case_assignments (case_id)
  where role = 'supervisor' and unassigned_at is null;
create unique index if not exists case_person_once_per_role_idx
  on casework.case_assignments (case_id, user_id, role)
  where unassigned_at is null;

-- ---------------------------------------------------------------------------
-- Objectives (PRD 5.1, 5.2).
--
-- "A case cannot be opened without an objective unless an authorised user
--  records an override with reason." The override is a column on the case
--  rather than an absence of a row, because "nobody wrote one" and "somebody
--  decided one was not needed, and here is why" are different facts and only
--  the second is acceptable.
-- ---------------------------------------------------------------------------
alter table casework.cases
  add column if not exists objective_override_reason text,
  add column if not exists objective_override_by uuid references iam.users (id),
  add column if not exists objective_override_at timestamptz;

alter table casework.cases
  drop constraint if exists case_objective_override_complete;
alter table casework.cases
  add constraint case_objective_override_complete
    check (
      objective_override_reason is null
      or (objective_override_by is not null and objective_override_at is not null
          and length(trim(objective_override_reason)) >= 10)
    );

create table if not exists casework.case_objectives (
  id        uuid primary key default gen_random_uuid(),
  case_id   uuid not null references casework.cases (id) on delete cascade,
  -- The client's own words, kept separate from PDDC's reading of them: a
  -- report defends the objective, so the instruction it came from matters.
  client_instruction text,
  objective text not null,
  -- The questions the investigation has to answer, which the findings are
  -- later traced back to.
  questions  text[] not null default '{}',
  deliverables text[] not null default '{}',
  deadline   timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    int not null default 1,

  constraint objective_is_substantive check (length(trim(objective)) >= 10)
);

create unique index if not exists case_one_objective_idx
  on casework.case_objectives (case_id);

-- ---------------------------------------------------------------------------
-- Risk assessment (PRD 5.3).
--
-- Six ratings and an overall with a rationale, an assessor and a date. A row
-- per assessment, so reassessment is normal and the earlier view is still
-- readable. The newest row is the one in force.
-- ---------------------------------------------------------------------------
create table if not exists casework.risk_assessments (
  id        uuid primary key default gen_random_uuid(),
  case_id   uuid not null references casework.cases (id) on delete cascade,

  operational_risk   text not null check (operational_risk in ('low','medium','high','critical')),
  legal_risk         text not null check (legal_risk in ('low','medium','high','critical')),
  reputational_risk  text not null check (reputational_risk in ('low','medium','high','critical')),
  safety_risk        text not null check (safety_risk in ('low','medium','high','critical')),
  sensitivity_risk   text not null check (sensitivity_risk in ('low','medium','high','critical')),
  overall_risk       text not null check (overall_risk in ('low','medium','high','critical')),
  rationale          text not null,

  assessed_by uuid references iam.users (id),
  assessed_at timestamptz not null default now(),

  -- "Critical cases require Operations Manager approval before assignment."
  approved_by uuid references iam.users (id),
  approved_at timestamptz,

  created_at timestamptz not null default now(),

  constraint risk_rationale_is_substantive check (length(trim(rationale)) >= 10),
  constraint risk_approval_complete
    check ((approved_at is null) = (approved_by is null))
);

create index if not exists risk_assessments_case_idx
  on casework.risk_assessments (case_id, assessed_at desc);

-- ---------------------------------------------------------------------------
-- Scope, versioned, with the original immutable (PRD 5.4).
--
-- Original Scope -> Change Request -> Reason -> Approval -> Revised Scope.
-- Each version is a row and no row is ever updated: a trigger refuses it. That
-- is what makes "the original approved scope is immutable and always viewable
-- beside revisions" true rather than aspirational.
-- ---------------------------------------------------------------------------
create table if not exists casework.scope_versions (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references casework.cases (id) on delete cascade,
  version_no  int  not null,

  scope       text not null,
  out_of_scope text,

  -- Null on version 1, which is the original. Later versions name the change
  -- request that produced them.
  change_request_id uuid,

  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),

  unique (case_id, version_no),
  constraint scope_is_substantive check (length(trim(scope)) >= 10)
);

create index if not exists scope_versions_case_idx
  on casework.scope_versions (case_id, version_no desc);

create table if not exists casework.scope_change_requests (
  id          uuid primary key default gen_random_uuid(),
  change_id   text unique not null default config.next_human_id('SCR'),
  case_id     uuid not null references casework.cases (id) on delete cascade,

  -- What is being asked for, and what it costs.
  reason          text not null,
  proposed_scope  text not null,
  proposed_out_of_scope text,
  additional_cost numeric(14,2),
  additional_cost_currency char(3),
  additional_days int,
  -- The client's own approval, which PDDC records a reference to rather than
  -- holding: it usually arrives as an email or a signed letter.
  client_approval_reference text,

  status      text not null default 'pending'
                check (status in ('pending','approved','rejected','withdrawn')),

  requested_by uuid references iam.users (id),
  requested_at timestamptz not null default now(),

  -- The approving officer, who must not be the requester (PRD 16).
  approving_officer uuid references iam.users (id),
  approved_at  timestamptz,
  decision_reason text,

  -- The scope version this produced, once approved.
  resulting_version_id uuid references casework.scope_versions (id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version    int not null default 1,

  constraint scr_reason_is_substantive check (length(trim(reason)) >= 10),
  constraint scr_decision_complete
    check (
      status in ('pending','withdrawn')
      or (approving_officer is not null and approved_at is not null
          and decision_reason is not null and length(trim(decision_reason)) > 0)
    ),
  constraint scr_no_self_approval
    check (approving_officer is null or approving_officer <> requested_by)
);

create index if not exists scr_case_idx
  on casework.scope_change_requests (case_id, requested_at desc);
create index if not exists scr_pending_idx
  on casework.scope_change_requests (status) where status = 'pending';

-- The forward reference is added after both tables exist.
alter table casework.scope_versions
  drop constraint if exists scope_versions_change_request_fkey;
alter table casework.scope_versions
  add constraint scope_versions_change_request_fkey
    foreign key (change_request_id) references casework.scope_change_requests (id);

-- A scope version records what was agreed at a point in time, so it is never
-- edited. Correcting one means raising a change request, which produces the
-- next version.
create or replace function casework.guard_scope_immutable()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  raise exception
    'a scope version records what was agreed and cannot be edited. Raise a scope change request, which produces the next version (PRD 5.4).'
    using errcode = 'integrity_constraint_violation';
end
$$;

drop trigger if exists scope_versions_immutable on casework.scope_versions;
create trigger scope_versions_immutable
  before update or delete on casework.scope_versions
  for each row execute function casework.guard_scope_immutable();

-- ---------------------------------------------------------------------------
-- Case communications (PRD 5.5).
--
-- "Material communications only (instructions, clarifications, scope and
--  deadline changes, approvals, decisions)." The kind is therefore a closed
-- list: a free-text label would turn this into an inbox, which is what PRD 5.5
-- is explicitly not asking for.
-- ---------------------------------------------------------------------------
create table if not exists casework.case_communications (
  id        uuid primary key default gen_random_uuid(),
  case_id   uuid not null references casework.cases (id) on delete cascade,

  occurred_at timestamptz not null default now(),
  direction text not null check (direction in ('inbound','outbound','internal')),
  kind      text not null
              check (kind in ('instruction','clarification','scope_change',
                              'deadline_change','approval','decision',
                              'status_update','other')),
  channel   text not null default 'email'
              check (channel in ('email','telephone','meeting','letter','portal','other')),

  sender    text not null,
  recipient text not null,
  subject   text not null,
  body      text,
  attachment_reference text,

  related_task_id uuid,

  classification text not null default 'CONFIDENTIAL'
                  references iam.classification_levels (code),

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    int not null default 1,
  deleted_at timestamptz
);

create index if not exists case_comms_case_idx
  on casework.case_communications (case_id, occurred_at desc);

-- ---------------------------------------------------------------- touch
do $$
declare
  t text;
begin
  foreach t in array array['cases','case_objectives','scope_change_requests',
                           'case_communications']
  loop
    execute format('drop trigger if exists %I_touch on casework.%I', t, t);
    execute format(
      'create trigger %I_touch before update on casework.%I '
      'for each row execute function iam.touch_row()', t, t);
  end loop;
end
$$;

-- ------------------------------------------------------------------- RLS
do $$
declare
  t text;
begin
  foreach t in array array['cases','case_assignments','case_objectives',
                           'risk_assessments','scope_versions',
                           'scope_change_requests','case_communications']
  loop
    execute format('alter table casework.%I enable row level security', t);
    execute format('alter table casework.%I force row level security', t);
  end loop;
end
$$;

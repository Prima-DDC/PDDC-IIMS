-- PDDC IIMS 0030 : investigator safety (PRD 5.8).
--
-- Three tables, and the same split of attitudes as 0027:
--
--   A safety plan is a live document. It says where somebody is going, what
--   the hazards are, who to ring, and how often they must check in. It is
--   edited as the assignment changes.
--
--   A check-in is a fact about a moment. "I am at the site and I am safe" is
--   not something anybody should be able to revise afterwards, least of all
--   the person who missed one, so check-ins are insert-only: no UPDATE or
--   DELETE policy, and a guard trigger behind that.
--
--   An incident is a live record with a lifecycle. It is raised, reviewed and
--   closed with a resolution, so it is editable, and every change goes
--   through the audit trail like any other case content.
--
-- The alerting PRD 5.8 asks for ("a missed check-in raises an immediate alert
-- to the supervisor and Operations Manager") needs the scheduler, which is
-- M7. What this migration delivers is the part the alert has to be computed
-- from: every check-in carries the moment the next one falls due, so a missed
-- one is a query rather than a reconstruction of the schedule.

-- ---------------------------------------------------------------------------
-- The safety plan: one per case.
-- ---------------------------------------------------------------------------
create table if not exists casework.safety_plans (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null unique references casework.cases (id) on delete cascade,

  -- Where the work is being done. Free text rather than a structured address
  -- because "the Tema port gate 3 car park" is the useful answer and no
  -- address schema holds it.
  location            text not null,
  site_visit_risk     text not null
    check (site_visit_risk in ('low', 'medium', 'high', 'critical')),
  known_hazards       text,
  safety_instructions text,

  emergency_contact_name  text not null,
  emergency_contact_phone text not null,
  emergency_contact_note  text,

  -- How often whoever is in the field must check in. Null means no schedule,
  -- which is honest for desk work and is not the same as "zero hours".
  check_in_frequency_hours int
    check (check_in_frequency_hours is null or check_in_frequency_hours between 1 and 168),
  check_in_instructions    text,

  -- A plan can be stood down when the field work ends, without deleting the
  -- record of what the precautions were.
  is_active   boolean not null default true,

  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references iam.users (id),
  version     int not null default 1,

  constraint safety_plans_schedule_needs_instruction
    check (check_in_frequency_hours is null or length(coalesce(check_in_instructions, '')) > 0)
);

comment on table casework.safety_plans is
  'PRD 5.8 safety plan: one per case, covering location, hazards, instructions, emergency contact and the check-in schedule.';
comment on column casework.safety_plans.check_in_frequency_hours is
  'Null means no check-in schedule. A schedule without instructions is refused: somebody has to know how to check in.';

-- ---------------------------------------------------------------------------
-- Check-ins and check-outs: insert-only.
-- ---------------------------------------------------------------------------
create table if not exists casework.check_ins (
  id          uuid primary key default gen_random_uuid(),
  check_in_id text unique not null default config.next_human_id('CHK'),
  case_id     uuid not null references casework.cases (id) on delete cascade,

  -- Who is reporting. Not necessarily whoever recorded the row: a supervisor
  -- can log a check-in relayed by telephone, and both are kept.
  user_id     uuid not null references iam.users (id),

  event       text not null check (event in ('check_in', 'check_out')),
  occurred_at timestamptz not null default now(),

  location    text,
  latitude    numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  longitude   numeric(9, 6) check (longitude is null or longitude between -180 and 180),

  -- When the next check-in falls due, taken from the plan at the time this
  -- one was recorded. Stored rather than derived, because the plan's
  -- frequency can change afterwards and that must not retrospectively make
  -- somebody late.
  next_due_at timestamptz,

  is_safe     boolean not null default true,
  notes       text,

  recorded_at timestamptz not null default now(),
  recorded_by uuid references iam.users (id),

  -- Append-only tables order by this, not by a timestamp: `now()` is
  -- transaction-stable, so two rows written in one transaction tie.
  seq         bigserial not null,

  constraint check_ins_unsafe_needs_a_note
    check (is_safe or length(coalesce(notes, '')) >= 5)
);

comment on table casework.check_ins is
  'PRD 5.8 check-in and check-out events. Insert-only: a safety record somebody can revise afterwards is not a safety record.';
comment on column casework.check_ins.next_due_at is
  'Taken from the plan when the row was written, so a later change to the schedule cannot make a past check-in late.';

create index if not exists check_ins_case_idx
  on casework.check_ins (case_id, seq desc);
create index if not exists check_ins_user_idx
  on casework.check_ins (user_id, seq desc);
-- The index the overdue scan uses: an open check-in whose next one is due.
create index if not exists check_ins_due_idx
  on casework.check_ins (next_due_at)
  where event = 'check_in' and next_due_at is not null;

-- ---------------------------------------------------------------------------
-- Incidents.
-- ---------------------------------------------------------------------------
create table if not exists casework.incidents (
  id          uuid primary key default gen_random_uuid(),
  incident_id text unique not null default config.next_human_id('INC'),
  case_id     uuid not null references casework.cases (id) on delete cascade,

  occurred_at   timestamptz not null,
  incident_type text not null check (
    incident_type in (
      'threat', 'assault', 'surveillance_detected', 'detention',
      'road_accident', 'health', 'equipment_loss', 'data_loss',
      'legal_challenge', 'other'
    )
  ),
  severity    text not null check (severity in ('low', 'medium', 'high', 'critical')),

  location    text,
  description text not null,
  immediate_action text,

  injuries          boolean not null default false,
  injury_detail     text,
  police_notified   boolean not null default false,
  police_reference  text,

  -- Who it happened to, which is not always who reported it.
  affected_user_id  uuid references iam.users (id),

  status      text not null default 'open'
    check (status in ('open', 'under_review', 'closed')),
  resolution  text,
  resolved_at timestamptz,
  resolved_by uuid references iam.users (id),

  -- An incident can be more sensitive than the case it happened on.
  classification text not null references iam.classification_levels (code),

  reported_at timestamptz not null default now(),
  reported_by uuid references iam.users (id),
  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references iam.users (id),
  version     int not null default 1,

  constraint incidents_closed_needs_resolution
    check (status <> 'closed' or length(coalesce(resolution, '')) >= 10),
  constraint incidents_injuries_need_detail
    check (not injuries or length(coalesce(injury_detail, '')) > 0),
  constraint incidents_police_reference_needs_notification
    check (police_notified or police_reference is null)
);

comment on table casework.incidents is
  'PRD 5.8 incident reports. Editable through a lifecycle, and closing one needs a resolution somebody can read.';

create index if not exists incidents_case_idx
  on casework.incidents (case_id, occurred_at desc);
create index if not exists incidents_open_idx
  on casework.incidents (status, severity)
  where status <> 'closed';

-- ---------------------------------------------------------------------------
-- Check-ins are insert-only, enforced three ways.
--
-- The privilege (0002 plus 0024's revoke), the absence of an UPDATE or DELETE
-- policy, and this trigger. A row trigger never fires for TRUNCATE, so that
-- gets its own statement trigger, exactly as the audit table does.
-- ---------------------------------------------------------------------------
create or replace function casework.refuse_check_in_change()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  raise exception
    'casework.check_ins is append-only. A check-in records where somebody was at a moment in time; correct it by recording another.';
end
$$;

drop trigger if exists check_ins_no_change on casework.check_ins;
create trigger check_ins_no_change
  before update or delete on casework.check_ins
  for each row execute function casework.refuse_check_in_change();

drop trigger if exists check_ins_no_truncate on casework.check_ins;
create trigger check_ins_no_truncate
  before truncate on casework.check_ins
  for each statement execute function casework.refuse_check_in_change();

-- ---------------------------------------------------------------------------
-- updated_at / updated_by on the editable tables.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['safety_plans', 'incidents']
  loop
    execute format('drop trigger if exists %I_touch on casework.%I', t, t);
    execute format(
      'create trigger %I_touch before update on casework.%I '
      'for each row execute function iam.touch_row()', t, t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Row-level security.
--
-- Safety follows the case, with one addition that matters: somebody always
-- sees their own check-ins, the way they always see their own tasks. A field
-- investigator must be able to check in on a case whose other content is
-- above their clearance.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['safety_plans', 'check_ins', 'incidents']
  loop
    execute format('alter table casework.%I enable row level security', t);
    execute format('alter table casework.%I force row level security', t);
    execute format('drop policy if exists %I_select on casework.%I', t, t);
    execute format('drop policy if exists %I_insert on casework.%I', t, t);
    execute format('drop policy if exists %I_update on casework.%I', t, t);
  end loop;
end
$$;

create policy safety_plans_select on casework.safety_plans
  for select to iims_app
  using (casework.can_reach_case(casework.safety_plans.case_id, 'view'));

create policy safety_plans_insert on casework.safety_plans
  for insert to iims_app
  with check (
    iam.has_permission('cases', 'edit')
    and casework.can_reach_case(casework.safety_plans.case_id, 'edit')
  );

create policy safety_plans_update on casework.safety_plans
  for update to iims_app
  using (
    iam.has_permission('cases', 'edit')
    and casework.can_reach_case(casework.safety_plans.case_id, 'edit')
  )
  with check (
    iam.has_permission('cases', 'edit')
    and casework.can_reach_case(casework.safety_plans.case_id, 'edit')
  );

create policy check_ins_select on casework.check_ins
  for select to iims_app
  using (
    casework.can_reach_case(casework.check_ins.case_id, 'view')
    or casework.check_ins.user_id = iam.current_user_id()
  );

-- Anybody on the case may check in, and may check in for somebody else only
-- if they can edit the case: that is the supervisor relaying a call.
create policy check_ins_insert on casework.check_ins
  for insert to iims_app
  with check (
    casework.check_ins.user_id = iam.current_user_id()
    or (
      iam.has_permission('cases', 'edit')
      and casework.can_reach_case(casework.check_ins.case_id, 'edit')
    )
  );

create policy incidents_select on casework.incidents
  for select to iims_app
  using (
    (
      -- The entry's own classification AND the case's reachability, which is
      -- the composition 0027 settled on for activities: an incident can be
      -- more sensitive than the case, and must not be a way around either.
      iam.has_permission('cases', 'view', casework.incidents.classification)
      and casework.can_reach_case(casework.incidents.case_id, 'view')
    )
    -- Whoever it happened to always sees it. An incident report about you
    -- that you cannot read is not a record you can correct or rely on.
    or casework.incidents.affected_user_id = iam.current_user_id()
  );

create policy incidents_insert on casework.incidents
  for insert to iims_app
  with check (
    iam.has_permission('cases', 'edit', casework.incidents.classification)
    and casework.can_reach_case(casework.incidents.case_id, 'edit')
  );

-- The WITH CHECK reads the row as it will be, so raising an incident's
-- classification above the editor's own clearance is refused rather than
-- silently allowed. That is the fault 0029 found on the cases table, avoided
-- here by passing the row's own column instead of looking it up again.
create policy incidents_update on casework.incidents
  for update to iims_app
  using (
    iam.has_permission('cases', 'edit', casework.incidents.classification)
    and casework.can_reach_case(casework.incidents.case_id, 'edit')
  )
  with check (
    iam.has_permission('cases', 'edit', casework.incidents.classification)
    and casework.can_reach_case(casework.incidents.case_id, 'edit')
  );

-- The sequence behind `seq` needs its own grant: INSERT on the table is not
-- enough, which is the trap 0028 recorded.
grant usage, select on sequence casework.check_ins_seq_seq to iims_app;

-- And the schema's no-erasure rule, re-asserted over the new tables.
select config.revoke_erasure('casework');

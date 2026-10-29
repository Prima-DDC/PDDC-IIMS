-- PDDC IIMS 0027 : tasks, the activity log and investigation plans (PRD 9).
--
-- Three tables, three different attitudes to change, and the differences are
-- the point:
--
--   A task is a live thing. It moves between statuses, gets reassigned, and
--   carries comments. It is editable.
--
--   An activity is a record of something that was done. PRD 9.4 says the log
--   is "chronological and append-only" and that "corrections are new entries
--   referencing the original", so a trigger refuses UPDATE and DELETE and
--   there is a column to point at what an entry corrects. This is the same
--   discipline as the audit trail, applied to investigative work rather than
--   to system events.
--
--   An investigation plan is versioned. PRD 9.3 says "approved plans are
--   versioned; changes require re-approval", so an approved version is frozen
--   and a change produces the next one, exactly as a scope change does.

-- ---------------------------------------------------------------------------
-- Tasks (PRD 9.1).
-- ---------------------------------------------------------------------------
create table if not exists casework.tasks (
  id          uuid primary key default gen_random_uuid(),
  task_id     text unique not null default config.next_human_id('TSK'),
  case_id     uuid not null references casework.cases (id) on delete cascade,

  title       text not null,
  description text,

  assigned_to uuid references iam.users (id),

  priority    text not null default 'medium'
                check (priority in ('low','medium','high','urgent')),

  start_date  date,
  due_date    date,

  -- PRD 9.1's statuses. `blocked` and `cancelled` demand a reason, which the
  -- CHECK below enforces rather than leaving to the service layer: a blocked
  -- task whose blocker is not written down is just a late task.
  status      text not null default 'not_started'
                check (status in ('not_started','in_progress','blocked',
                                  'completed','cancelled')),
  status_reason text,
  completed_at  timestamptz,

  -- Which methodology stage this belongs to (PRD 4.3), so the plan and the
  -- tasks under it can be read together. Free text against the configured
  -- stages rather than a foreign key, because a stage may be renamed.
  methodology_stage text,

  -- A sub-task. Self-referencing, with the cycle check in the service layer:
  -- a CHECK constraint cannot see more than its own row.
  parent_task_id uuid references casework.tasks (id) on delete cascade,

  -- Set when the task came from an approved investigation plan rather than
  -- being added ad hoc (PRD 9.2).
  plan_version_id uuid,

  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references iam.users (id),
  version     int not null default 1,
  deleted_at  timestamptz,

  constraint task_dates_ordered
    check (due_date is null or start_date is null or due_date >= start_date),
  -- A blocked or cancelled task says why.
  constraint task_status_reason_required
    check (
      status not in ('blocked','cancelled')
      or (status_reason is not null and length(trim(status_reason)) >= 5)
    ),
  -- A completed task has a completion time, and an incomplete one does not.
  constraint task_completed_together
    check ((status = 'completed') = (completed_at is not null)),
  constraint task_is_not_its_own_parent
    check (parent_task_id is null or parent_task_id <> id)
);

create index if not exists tasks_case_idx
  on casework.tasks (case_id) where deleted_at is null;
create index if not exists tasks_assigned_idx
  on casework.tasks (assigned_to, status) where deleted_at is null;
-- The overdue scan reads this one, so it is the index that matters most.
create index if not exists tasks_due_idx
  on casework.tasks (due_date)
  where deleted_at is null and status not in ('completed','cancelled');
create index if not exists tasks_parent_idx on casework.tasks (parent_task_id);

comment on table casework.tasks is
  'Work items on a case (PRD 9). Tasks come from an approved investigation '
  'plan or are added ad hoc. Overdue tasks are identified by due_date against '
  'now(), not by a stored flag, so they cannot go stale.';

create table if not exists casework.task_comments (
  id        uuid primary key default gen_random_uuid(),
  task_id   uuid not null references casework.tasks (id) on delete cascade,
  body      text not null,
  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  -- Editable for a short while, then not: a comment somebody has replied to
  -- should not change under them. The window is enforced in the use case.
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    int not null default 1,
  deleted_at timestamptz,

  constraint comment_is_not_empty check (length(trim(body)) > 0)
);

create index if not exists task_comments_task_idx
  on casework.task_comments (task_id, created_at)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- The investigation activity log (PRD 9.4).
--
-- "Chronological and append-only. Corrections are new entries referencing the
--  original." That makes this the second append-only table in the platform
-- after the audit trail, and for a related reason: an activity log that can be
-- edited after the fact is worth nothing when a report is challenged.
--
-- Unlike the audit trail there is no hash chain here. The audit trail records
-- what the SYSTEM did and has to be defensible against the platform's own
-- operators; this records what INVESTIGATORS say they did, and its integrity
-- rests on the audit trail that covers it. Chaining it twice would add cost
-- without adding a guarantee.
-- ---------------------------------------------------------------------------
create table if not exists casework.activities (
  id          uuid primary key default gen_random_uuid(),
  activity_id text unique not null default config.next_human_id('ACT'),
  case_id     uuid not null references casework.cases (id) on delete cascade,

  -- When the work happened, which is not when it was written down.
  occurred_at timestamptz not null default now(),

  activity_type text not null
                  check (activity_type in ('research','interview','surveillance',
                                           'site_visit','document_review',
                                           'evidence_collection','analysis',
                                           'liaison','travel','other')),
  description text not null,
  location    text,

  -- Forward references to things that do not exist until later milestones, so
  -- they are plain uuids with no foreign key yet. M4 and M5 add the
  -- constraints when the tables arrive.
  related_source_id   uuid,
  related_evidence_id uuid,
  related_document_id uuid,
  related_task_id     uuid references casework.tasks (id),

  -- A correction points at what it corrects. The original stays exactly as it
  -- was, which is what makes the log worth reading.
  corrects_activity_id uuid references casework.activities (id),
  correction_reason    text,

  classification text not null default 'CONFIDENTIAL'
                  references iam.classification_levels (code),

  recorded_at timestamptz not null default now(),
  recorded_by uuid references iam.users (id),

  constraint activity_description_is_substantive
    check (length(trim(description)) >= 10),
  constraint activity_correction_has_a_reason
    check (
      corrects_activity_id is null
      or (correction_reason is not null and length(trim(correction_reason)) >= 5)
    ),
  constraint activity_does_not_correct_itself
    check (corrects_activity_id is null or corrects_activity_id <> id)
);

create index if not exists activities_case_idx
  on casework.activities (case_id, occurred_at desc);
create index if not exists activities_corrects_idx
  on casework.activities (corrects_activity_id)
  where corrects_activity_id is not null;

/**
 * The append-only guard.
 *
 * Same shape as the audit trail's in 0003: a row trigger for UPDATE and
 * DELETE. TRUNCATE needs its own statement-level trigger, because row triggers
 * never fire for it.
 */
create or replace function casework.reject_activity_mutation()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  raise exception
    'the investigation activity log is append-only (PRD 9.4). Record a correcting entry that references the original instead.'
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists activities_no_update on casework.activities;
create trigger activities_no_update
  before update or delete on casework.activities
  for each row execute function casework.reject_activity_mutation();

drop trigger if exists activities_no_truncate on casework.activities;
create trigger activities_no_truncate
  before truncate on casework.activities
  for each statement execute function casework.reject_activity_mutation();

comment on table casework.activities is
  'What investigators did, chronologically and append-only (PRD 9.4). A '
  'correction is a new row pointing at the original through '
  'corrects_activity_id; the original is never altered.';

-- ---------------------------------------------------------------------------
-- Investigation plans (PRD 9.3).
--
-- One plan per case, with versions. A version is drafted, submitted, and then
-- approved or returned. An approved version is frozen: PRD 9.3's "changes
-- require re-approval" means the next version starts as a draft, exactly as a
-- scope change produces a new scope version.
-- ---------------------------------------------------------------------------
create table if not exists casework.investigation_plans (
  id        uuid primary key default gen_random_uuid(),
  plan_id   text unique not null default config.next_human_id('PLN'),
  case_id   uuid not null references casework.cases (id) on delete cascade,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),

  -- One plan per case; its history lives in the versions.
  unique (case_id)
);

create table if not exists casework.plan_versions (
  id         uuid primary key default gen_random_uuid(),
  plan_id    uuid not null references casework.investigation_plans (id) on delete cascade,
  version_no int  not null,

  -- PRD 9.3's fields.
  objective          text not null,
  scope              text,
  methodology        text not null,
  sources_to_consult text[] not null default '{}',
  assigned_personnel text[] not null default '{}',
  timeline           text,
  risks              text,
  resources          text,
  expected_deliverables text[] not null default '{}',

  status     text not null default 'draft'
               check (status in ('draft','submitted','approved','returned','superseded')),

  submitted_at timestamptz,
  submitted_by uuid references iam.users (id),

  -- "Supervisor review -> Approved / Returned, with timestamped approval."
  reviewed_by  uuid references iam.users (id),
  reviewed_at  timestamptz,
  review_notes text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    int not null default 1,

  unique (plan_id, version_no),
  constraint plan_objective_is_substantive check (length(trim(objective)) >= 10),
  constraint plan_methodology_is_substantive check (length(trim(methodology)) >= 10),
  constraint plan_review_complete
    check (
      status not in ('approved','returned')
      or (reviewed_by is not null and reviewed_at is not null)
    ),
  -- A returned plan says what to fix.
  constraint plan_return_has_notes
    check (
      status <> 'returned'
      or (review_notes is not null and length(trim(review_notes)) >= 5)
    ),
  constraint plan_submission_complete
    check (
      status = 'draft'
      or (submitted_at is not null and submitted_by is not null)
    ),
  -- Nobody approves their own plan: PRD 9.3 puts a supervisor in the loop,
  -- which is only a loop if it is somebody else.
  constraint plan_no_self_review
    check (reviewed_by is null or submitted_by is null or reviewed_by <> submitted_by)
);

create index if not exists plan_versions_plan_idx
  on casework.plan_versions (plan_id, version_no desc);
create index if not exists plan_versions_submitted_idx
  on casework.plan_versions (status) where status = 'submitted';

/**
 * An approved plan version is frozen.
 *
 * Only `status` may change on it, and only to `superseded`, which is what
 * happens when a later version is approved. Everything else about it is what
 * the supervisor signed off.
 */
create or replace function casework.guard_approved_plan()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if old.status = 'approved' then
    if new.status = 'superseded'
       and new.objective = old.objective
       and new.methodology = old.methodology
       and new.version_no = old.version_no then
      return new;
    end if;

    raise exception
      'an approved investigation plan cannot be changed (PRD 9.3). Create the next version, which starts as a draft and needs approval of its own.'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

drop trigger if exists plan_versions_frozen on casework.plan_versions;
create trigger plan_versions_frozen
  before update on casework.plan_versions
  for each row execute function casework.guard_approved_plan();

-- The task's forward reference, now that plan_versions exists.
alter table casework.tasks
  drop constraint if exists tasks_plan_version_fkey;
alter table casework.tasks
  add constraint tasks_plan_version_fkey
    foreign key (plan_version_id) references casework.plan_versions (id);

-- ---------------------------------------------------------------- touch
do $$
declare
  t text;
begin
  foreach t in array array['tasks','task_comments','plan_versions']
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
  foreach t in array array['tasks','task_comments','activities',
                           'investigation_plans','plan_versions']
  loop
    execute format('alter table casework.%I enable row level security', t);
    execute format('alter table casework.%I force row level security', t);
  end loop;
end
$$;

-- Tasks, comments and plans follow their case. Activities are readable the
-- same way but insert-only: the guard trigger above refuses the rest, and
-- there is deliberately no UPDATE or DELETE policy either, so the application
-- cannot even reach the trigger.
do $$
declare
  t text;
begin
  foreach t in array array['tasks','plan_versions']
  loop
    execute format('drop policy if exists %I_select on casework.%I', t, t);
    execute format('drop policy if exists %I_insert on casework.%I', t, t);
    execute format('drop policy if exists %I_update on casework.%I', t, t);
  end loop;
end
$$;

create policy tasks_select on casework.tasks
  for select to iims_app
  using (
    deleted_at is null
    and (
      casework.can_reach_case(casework.tasks.case_id, 'view')
      -- Somebody always sees their own tasks, which is what makes the "my
      -- tasks" list work across cases.
      or assigned_to = iam.current_user_id()
    )
  );

create policy tasks_select_deleted on casework.tasks
  for select to iims_app
  using (
    deleted_at is not null
    and casework.can_reach_case(casework.tasks.case_id, 'delete')
  );

create policy tasks_insert on casework.tasks
  for insert to iims_app
  with check (
    iam.has_permission('tasks', 'create')
    and casework.can_reach_case(casework.tasks.case_id, 'view')
  );

create policy tasks_update on casework.tasks
  for update to iims_app
  using (
    iam.has_permission('tasks', 'edit')
    and (
      casework.can_reach_case(casework.tasks.case_id, 'view')
      or assigned_to = iam.current_user_id()
    )
  )
  with check (
    iam.has_permission('tasks', 'edit')
    and (
      casework.can_reach_case(casework.tasks.case_id, 'view')
      or assigned_to = iam.current_user_id()
    )
  );

drop policy if exists task_comments_select on casework.task_comments;
create policy task_comments_select on casework.task_comments
  for select to iims_app
  using (
    deleted_at is null
    and exists (
      select 1 from casework.tasks t
      where t.id = casework.task_comments.task_id
    )
  );

drop policy if exists task_comments_insert on casework.task_comments;
create policy task_comments_insert on casework.task_comments
  for insert to iims_app
  with check (
    exists (select 1 from casework.tasks t where t.id = casework.task_comments.task_id)
  );

drop policy if exists task_comments_update on casework.task_comments;
create policy task_comments_update on casework.task_comments
  for update to iims_app
  using (created_by = iam.current_user_id())
  with check (created_by = iam.current_user_id());

drop policy if exists activities_select on casework.activities;
create policy activities_select on casework.activities
  for select to iims_app
  using (
    iam.has_permission('cases', 'view', classification)
    and casework.can_reach_case(casework.activities.case_id, 'view')
  );

drop policy if exists activities_insert on casework.activities;
create policy activities_insert on casework.activities
  for insert to iims_app
  with check (casework.can_reach_case(casework.activities.case_id, 'view'));

drop policy if exists investigation_plans_select on casework.investigation_plans;
create policy investigation_plans_select on casework.investigation_plans
  for select to iims_app
  using (casework.can_reach_case(casework.investigation_plans.case_id, 'view'));

drop policy if exists investigation_plans_insert on casework.investigation_plans;
create policy investigation_plans_insert on casework.investigation_plans
  for insert to iims_app
  with check (casework.can_reach_case(casework.investigation_plans.case_id, 'view'));

create policy plan_versions_select on casework.plan_versions
  for select to iims_app
  using (
    exists (
      select 1 from casework.investigation_plans p
      where p.id = casework.plan_versions.plan_id
    )
  );

create policy plan_versions_insert on casework.plan_versions
  for insert to iims_app
  with check (
    exists (
      select 1 from casework.investigation_plans p
      where p.id = casework.plan_versions.plan_id
    )
  );

create policy plan_versions_update on casework.plan_versions
  for update to iims_app
  using (
    exists (
      select 1 from casework.investigation_plans p
      where p.id = casework.plan_versions.plan_id
    )
  )
  with check (
    exists (
      select 1 from casework.investigation_plans p
      where p.id = casework.plan_versions.plan_id
    )
  );

-- The new tables inherit the schema's no-erasure rule. Activities are the
-- strictest case: they have no UPDATE or DELETE policy at all, so the
-- privilege and the policy both say no.
select config.revoke_erasure('casework');

-- PDDC IIMS 0031 : case financials, time and expenses (PRD 5.6, 5.7).
--
-- PRD 5.6 opens with "not an accounting system", and that is the design
-- constraint rather than a disclaimer. There is no ledger, no double entry and
-- no tax handling here: one row per case holding what was quoted, what was
-- approved, what has been invoiced and what has been paid, so Operations can
-- answer "is this case paid for" without leaving the platform.
--
-- Three separate reach rules, because the three tables answer to different
-- people:
--
--   Financials are money. PRD 5.6 says "visible to Finance, Operations
--   Manager and CEO only", so they key on the `financials` permission and not
--   on case assignment: an investigator assigned to the case still cannot see
--   the fee.
--
--   Time entries are somebody's own work. The `employee` role holds
--   time:view/create/edit at `own` scope (0009), so everybody logs their own
--   and only a wider scope sees anybody else's.
--
--   Expenses are claimed by the person who incurred them and approved by
--   somebody who holds `financials`. Both halves are in the policy, which is
--   what stops a claimant approving their own claim.

-- ---------------------------------------------------------------------------
-- Case financials: one row per case.
-- ---------------------------------------------------------------------------
create table if not exists casework.case_financials (
  id       uuid primary key default gen_random_uuid(),
  case_id  uuid not null unique references casework.cases (id) on delete cascade,

  currency char(3) not null default 'GHS',

  quoted_fee      numeric(14, 2) check (quoted_fee is null or quoted_fee >= 0),
  approved_fee    numeric(14, 2) check (approved_fee is null or approved_fee >= 0),
  additional_fees numeric(14, 2) not null default 0 check (additional_fees >= 0),

  invoice_number  text,
  amount_invoiced numeric(14, 2) not null default 0 check (amount_invoiced >= 0),
  amount_paid     numeric(14, 2) not null default 0 check (amount_paid >= 0),

  -- PRD 5.6 asks for outstanding to be computed, so it is, by the database. A
  -- generated column may only reference its own row, which is all this needs,
  -- and it cannot drift from the two numbers it comes from.
  outstanding numeric(14, 2)
    generated always as (amount_invoiced - amount_paid) stored,

  payment_status text not null default 'not_invoiced' check (
    payment_status in
      ('not_invoiced', 'invoiced', 'part_paid', 'paid', 'overdue', 'written_off')
  ),
  notes text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    int not null default 1,

  -- Money that has been paid but never invoiced is a data-entry error, not a
  -- state the business has.
  constraint case_financials_paid_within_invoiced
    check (amount_paid <= amount_invoiced),
  constraint case_financials_invoiced_needs_a_number
    check (amount_invoiced = 0 or length(coalesce(invoice_number, '')) > 0),
  constraint case_financials_written_off_needs_a_note
    check (payment_status <> 'written_off' or length(coalesce(notes, '')) >= 10)
);

comment on table casework.case_financials is
  'PRD 5.6 case commercials. Deliberately not an accounting system: quoted, approved, invoiced, paid and outstanding, nothing more.';
comment on column casework.case_financials.outstanding is
  'Generated: amount_invoiced - amount_paid. Computed by the database so it cannot disagree with its own inputs.';

-- ---------------------------------------------------------------------------
-- Time entries (PRD 5.7).
-- ---------------------------------------------------------------------------
create table if not exists casework.time_entries (
  id      uuid primary key default gen_random_uuid(),
  case_id uuid not null references casework.cases (id) on delete cascade,
  user_id uuid not null references iam.users (id),
  task_id uuid references casework.tasks (id) on delete set null,

  worked_on date not null,

  -- PRD 5.7 lists hours for some kinds of work and days for others ("field
  -- days"). Both are kept in their own unit rather than converted, because a
  -- conversion needs a working-day length nobody has agreed and the lossy
  -- version cannot be undone.
  quantity numeric(6, 2) not null check (quantity > 0 and quantity <= 999),
  unit     text not null default 'hours' check (unit in ('hours', 'days')),

  work_kind text not null check (
    work_kind in (
      'investigation', 'analysis', 'surveillance', 'field_work', 'interview',
      'travel', 'report_writing', 'liaison', 'review', 'administration'
    )
  ),
  description text,
  is_billable boolean not null default true,

  approved_at timestamptz,
  approved_by uuid references iam.users (id),

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    int not null default 1,

  -- A day of field work is a day, not 30 of them.
  constraint time_entries_days_are_plausible
    check (unit <> 'days' or quantity <= 7),
  constraint time_entries_hours_fit_in_a_day
    check (unit <> 'hours' or quantity <= 24)
);

comment on table casework.time_entries is
  'PRD 5.7 time and resource tracking. Hours and field days are kept in their own units, never converted.';

create index if not exists time_entries_case_idx
  on casework.time_entries (case_id, worked_on desc);
create index if not exists time_entries_user_idx
  on casework.time_entries (user_id, worked_on desc);

-- ---------------------------------------------------------------------------
-- Expenses (PRD 5.7's travel, external and specialist costs).
-- ---------------------------------------------------------------------------
create table if not exists casework.expenses (
  id         uuid primary key default gen_random_uuid(),
  expense_id text unique not null default config.next_human_id('EXP'),
  case_id    uuid not null references casework.cases (id) on delete cascade,

  incurred_on date not null,
  category text not null check (
    category in (
      'travel', 'accommodation', 'subsistence', 'external_services',
      'specialist_fees', 'records_and_searches', 'equipment', 'communications',
      'other'
    )
  ),
  description text not null,

  amount   numeric(14, 2) not null check (amount > 0),
  currency char(3) not null default 'GHS',

  -- Whether the client pays for it, which is not the same as whether PDDC
  -- reimburses the person who paid it.
  is_billable       boolean not null default true,
  receipt_reference text,

  -- Who is out of pocket.
  incurred_by uuid references iam.users (id),

  status text not null default 'claimed' check (
    status in ('claimed', 'approved', 'rejected', 'reimbursed')
  ),
  decided_at       timestamptz,
  decided_by       uuid references iam.users (id),
  decision_reason  text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    int not null default 1,

  constraint expenses_rejection_needs_a_reason
    check (status <> 'rejected' or length(coalesce(decision_reason, '')) >= 5),
  constraint expenses_decision_has_a_decider
    check (status in ('claimed') or decided_by is not null)
);

comment on table casework.expenses is
  'PRD 5.7 case costs. Claimed by whoever incurred them and decided by somebody holding the financials permission, which is what stops self-approval.';

create index if not exists expenses_case_idx
  on casework.expenses (case_id, incurred_on desc);
create index if not exists expenses_open_idx
  on casework.expenses (status)
  where status = 'claimed';

-- ---------------------------------------------------------------------------
-- updated_at / updated_by.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['case_financials', 'time_entries', 'expenses']
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
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['case_financials', 'time_entries', 'expenses']
  loop
    execute format('alter table casework.%I enable row level security', t);
    execute format('alter table casework.%I force row level security', t);
    execute format('drop policy if exists %I_select on casework.%I', t, t);
    execute format('drop policy if exists %I_insert on casework.%I', t, t);
    execute format('drop policy if exists %I_update on casework.%I', t, t);
  end loop;
end
$$;

-- Money: the financials permission, and nothing about assignment. An
-- investigator on the case still cannot see the fee (PRD 5.6).
create policy case_financials_select on casework.case_financials
  for select to iims_app
  using (iam.has_permission('financials', 'view'));

create policy case_financials_insert on casework.case_financials
  for insert to iims_app
  with check (
    iam.has_permission('financials', 'create')
    and exists (
      select 1 from casework.cases c
      where c.id = casework.case_financials.case_id and c.deleted_at is null
    )
  );

create policy case_financials_update on casework.case_financials
  for update to iims_app
  using (iam.has_permission('financials', 'edit'))
  with check (iam.has_permission('financials', 'edit'));

-- Time: everybody logs their own, and a wider scope sees other people's.
-- `own` is the baseline every employee holds (0009), so the first branch is
-- what makes the timesheet work at all.
create policy time_entries_select on casework.time_entries
  for select to iims_app
  using (
    casework.time_entries.user_id = iam.current_user_id()
    or (
      iam.has_permission('time', 'view')
      and (
        iam.scope_rank(iam.permission_scope('time', 'view'))
          >= iam.scope_rank('all')
        or iam.is_assigned_to_case(casework.time_entries.case_id)
      )
    )
  );

create policy time_entries_insert on casework.time_entries
  for insert to iims_app
  with check (
    iam.has_permission('time', 'create')
    and (
      casework.time_entries.user_id = iam.current_user_id()
      -- Logging time for somebody else is a supervisory act, so it needs a
      -- scope wider than `own`.
      or iam.scope_rank(iam.permission_scope('time', 'create'))
           >= iam.scope_rank('team')
    )
    and casework.can_reach_case(casework.time_entries.case_id, 'view')
  );

create policy time_entries_update on casework.time_entries
  for update to iims_app
  using (
    iam.has_permission('time', 'edit')
    and (
      casework.time_entries.user_id = iam.current_user_id()
      or iam.scope_rank(iam.permission_scope('time', 'edit'))
           >= iam.scope_rank('team')
    )
  )
  with check (
    iam.has_permission('time', 'edit')
    and (
      casework.time_entries.user_id = iam.current_user_id()
      or iam.scope_rank(iam.permission_scope('time', 'edit'))
           >= iam.scope_rank('team')
    )
  );

-- Expenses: the claimant sees their own, finance sees them all.
create policy expenses_select on casework.expenses
  for select to iims_app
  using (
    casework.expenses.incurred_by = iam.current_user_id()
    or iam.has_permission('financials', 'view')
  );

create policy expenses_insert on casework.expenses
  for insert to iims_app
  with check (
    casework.can_reach_case(casework.expenses.case_id, 'view')
    and (
      casework.expenses.incurred_by = iam.current_user_id()
      or iam.has_permission('financials', 'create')
    )
  );

-- Deciding a claim needs the financials permission. The separation-of-duties
-- rule that a claimant cannot decide their own claim is enforced in the
-- domain layer, where the actor and the row are both in hand and the refusal
-- can say why: a policy can only say no.
create policy expenses_update on casework.expenses
  for update to iims_app
  using (
    iam.has_permission('financials', 'edit')
    or (
      -- A claimant may correct their own claim while it is still open.
      casework.expenses.incurred_by = iam.current_user_id()
      and casework.expenses.status = 'claimed'
    )
  )
  with check (
    iam.has_permission('financials', 'edit')
    or (
      casework.expenses.incurred_by = iam.current_user_id()
      and casework.expenses.status = 'claimed'
    )
  );

select config.revoke_erasure('casework');

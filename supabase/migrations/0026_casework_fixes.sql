-- PDDC IIMS 0026 : three defects the casework repository tests exposed.
--
-- All three were found by tests written to confirm the schema's claims rather
-- than to assume them, and none would have been visible from reading 0022.

-- ---------------------------------------------------------------------------
-- 1. scope_change_requests could not be updated at all.
--
-- 0022 attached iam.touch_row() to the table, and that trigger assigns
-- new.updated_by, but the table was given `requested_by` and no `updated_by`.
-- Every UPDATE therefore failed with `column "updated_by" does not exist`,
-- which meant a change request could be raised and then never decided or
-- withdrawn. The whole scope-change workflow of PRD 5.4 was unreachable past
-- its first step.
-- ---------------------------------------------------------------------------
alter table casework.scope_change_requests
  add column if not exists updated_by uuid references iam.users (id);

-- ---------------------------------------------------------------------------
-- 2. "The newest risk assessment" was not well defined.
--
-- assessed_at defaults to now(), which is the TRANSACTION timestamp and is
-- therefore identical for two rows written in one transaction. Ordering by it
-- descending then returned an arbitrary one of them as the assessment in
-- force, and the case's cached risk_level could disagree with what the screen
-- showed.
--
-- A monotonic sequence settles it. It is also the honest answer to "which
-- assessment is in force": the last one recorded, not the one with the latest
-- clock reading, which two assessors working a minute apart could tie on.
-- ---------------------------------------------------------------------------
alter table casework.risk_assessments
  add column if not exists seq bigserial;

create index if not exists risk_assessments_case_seq_idx
  on casework.risk_assessments (case_id, seq desc);

-- The sequence behind a bigserial needs its own grant: INSERT on the table is
-- not enough to draw from it. The same trap as audit.audit_log in 0004.
grant usage, select on all sequences in schema casework to iims_app;

comment on column casework.risk_assessments.seq is
  'Insertion order. The assessment in force is the highest seq, not the '
  'latest assessed_at: now() is transaction-stable, so two rows written '
  'together share a timestamp and could not be ordered.';

-- ---------------------------------------------------------------------------
-- 3. A case could not be backdated.
--
-- `case_target_after_opening` compares target_completion_at against opened_at,
-- which is right, but opened_at defaulted to now() and the repository offered
-- no way to set it. That made it impossible to enter a case for work that
-- started before the platform did, which is exactly what PDDC needs while it
-- moves off Excel: a case migrated with its real dates has a target that has
-- already passed.
--
-- The constraint stays. What changes is that opened_at becomes something the
-- caller can supply, which it already was in the table and now is in the
-- repository too.
-- ---------------------------------------------------------------------------
comment on column casework.cases.opened_at is
  'When the work began, which may precede the row. A case migrated from the '
  'previous manual process carries its real date, so target_completion_at may '
  'already have passed; case_target_after_opening still holds because both '
  'move together.';

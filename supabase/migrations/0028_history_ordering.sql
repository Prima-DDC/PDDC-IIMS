-- PDDC IIMS 0028 : a monotonic ordering column on every history table.
--
-- This is the third time the same defect has appeared, so it gets fixed as a
-- rule rather than a third time individually.
--
-- THE DEFECT
-- `now()` in Postgres is the TRANSACTION timestamp: every statement in one
-- transaction sees the identical value. A table whose order depends on a
-- `now()` default therefore has no defined order among rows written together,
-- and "the latest one" is whichever the planner happened to return.
--
-- It showed up as:
--   the risk assessment reported as in force being arbitrary among ties, so
--   the case's cached risk_level could disagree with the screen (fixed in 0026
--   for casework.risk_assessments);
--   task comments appearing in an arbitrary order, so a conversation did not
--   read forwards;
--   and latent in casework.activities, whose order falls back on recorded_at
--   when two entries share an occurred_at.
--
-- It is not only a test artefact. Two risk assessments recorded a second apart
-- tie on nothing, but a batch import, a retry, or any future code path that
-- writes two rows in one transaction hits it in production, and the symptom is
-- a silently wrong "most recent" rather than an error.
--
-- THE RULE
-- Every table whose meaning depends on insertion order carries a `seq
-- bigserial`, and every query that orders it uses that column, as the first
-- key where order is the whole point and as the tiebreaker where a real
-- timestamp leads. The sequence is monotonic across transactions and within
-- them, which is exactly the guarantee the timestamp cannot give.
--
-- Note the grant at the end: a bigserial draws from a sequence, and INSERT on
-- the table is not enough to use it. That trap has now been hit three times
-- too (audit.audit_log in 0004, risk_assessments in 0026, and these), so the
-- grant is written for the whole schema rather than per sequence.

alter table casework.task_comments add column if not exists seq bigserial;
alter table casework.activities    add column if not exists seq bigserial;

create index if not exists task_comments_task_seq_idx
  on casework.task_comments (task_id, seq);

-- Activities are read newest first, within a case.
create index if not exists activities_case_seq_idx
  on casework.activities (case_id, seq desc);

comment on column casework.task_comments.seq is
  'Insertion order. A conversation reads forwards, which created_at cannot '
  'guarantee: now() is transaction-stable, so two comments written together '
  'share a timestamp.';

comment on column casework.activities.seq is
  'Insertion order, used as the tiebreaker after occurred_at. Two entries '
  'recorded together share recorded_at, because now() is the transaction '
  'timestamp.';

-- A bigserial needs USAGE on its sequence beyond INSERT on the table.
grant usage, select on all sequences in schema casework to iims_app;
alter default privileges for role postgres in schema casework
  grant usage, select on sequences to iims_app;

-- PDDC IIMS 0042 : the report workflow history needs a total order.
--
-- `reporting.report_transitions` was ordered by `decided_at`, which is
-- `now()` and therefore the transaction's start time. Three decisions taken
-- in quick succession can share it, and then the history reads back in an
-- arbitrary order: a report that was submitted, submitted again and returned
-- can appear to have been submitted, returned and submitted.
--
-- Caught by the integration test asserting the sequence of decisions, which
-- failed on the ordering rather than on the content. A history whose order
-- depends on how fast somebody clicked is not a history, which is the same
-- reason `audit.audit_log` and `evidence.custody_events` each carry a
-- sequence of their own.
--
-- `bigserial` rather than a timestamp with more precision: the question "what
-- happened next" is about insertion order, and only a sequence answers it
-- exactly.

alter table reporting.report_transitions
  add column if not exists seq bigserial;

create index if not exists report_transitions_seq_idx
  on reporting.report_transitions (report_id, seq);

comment on column reporting.report_transitions.seq is
  'Insertion order, so the workflow history has a total order. decided_at is '
  'the transaction clock and ties between decisions taken seconds apart.';

-- The sequence behind a bigserial needs the same grant the other append-only
-- tables' sequences have, or an insert by the application fails.
grant usage, select on sequence reporting.report_transitions_seq_seq to iims_app;

-- Existing rows get their order from when they were decided, which is the
-- best available answer for history written before this column existed.
do $$
begin
  if exists (
    select 1 from reporting.report_transitions where seq is null
  ) then
    raise exception
      'report_transitions has rows with no seq, which bigserial should have filled';
  end if;
end
$$;

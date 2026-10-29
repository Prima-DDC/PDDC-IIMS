-- PDDC IIMS 0004: grant fixes found by the containment test suite.
--
-- 1. audit.audit_log.seq is a bigserial. INSERT on the table is not enough:
--    nextval() additionally needs USAGE on the backing sequence. Migration
--    0002 granted sequence usage across the nine operational schemas but not
--    `audit`, where it deliberately granted INSERT on tables only, so every
--    attempt to append an audit row failed with
--    "permission denied for sequence audit_log_seq_seq".
--
--    Caught by tests/integration/app-role-containment.test.ts, which is
--    exactly the sort of thing asserting GRANTs alone would have missed.
--
-- 2. The application has no business touching the migration ledger.

grant usage on all sequences in schema audit to iims_app;

-- Cover sequences added by future audit migrations.
alter default privileges for role postgres in schema audit
  grant usage on sequences to iims_app;

-- USAGE only: enough for nextval(), but not setval(), so the application
-- cannot rewind the audit sequence to overwrite an existing row's position.
revoke select, update on all sequences in schema audit from iims_app;

-- ---------------------------------------------------------------------------
-- Least privilege: config._migrations is the migration runner's ledger and is
-- written only by `postgres`. The application never reads it.
-- ---------------------------------------------------------------------------
revoke all on config._migrations from iims_app;

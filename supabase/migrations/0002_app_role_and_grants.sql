-- PDDC IIMS 0002: the restricted runtime role (PRD §13, §14).
--
-- WHY A CUSTOM ROLE AT ALL
-- PRD §13 requires that the application database role hold no UPDATE or
-- DELETE privilege on the audit schema. Supabase's service_role and the
-- postgres role both bypass RLS (postgres by table ownership), so neither can
-- deliver that guarantee. All IIMS data access therefore runs as iims_app
-- over a direct Postgres connection, and supabase-js is used only for auth,
-- storage and realtime.
--
-- The role is created NOLOGIN here. scripts/bootstrap-app-role.mjs grants
-- LOGIN and sets the password from IIMS_APP_DB_PASSWORD, so no credential
-- ever appears in a committed migration.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'iims_app') then
    create role iims_app nologin;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- A NOTE ON OWNERSHIP, AND A DESIGN DECISION RECORDED HERE
--
-- An earlier draft introduced a separate `iims_audit_owner` role to own the
-- audit schema and its trigger functions, on the theory that an owner-split
-- would make interference by the platform admin role anomalous rather than
-- routine.
--
-- It was dropped. Postgres 16 split role membership into separate SET,
-- INHERIT and ADMIN options, and the membership a CREATEROLE role receives
-- implicitly over a role it creates carries SET FALSE. Reassigning ownership
-- therefore fails with "must be able to SET ROLE", and working around it would
-- require every future migration to SET ROLE before touching an audit object: -- fragile, and easy to get wrong silently.
--
-- The split bought very little in exchange for that: the postgres role can
-- defeat the audit schema regardless (see the residual-risk note at the foot
-- of this file), so the split raised no real barrier. The protections that do
-- the work: INSERT-only privileges, FORCEd RLS, and the mutation triggers: -- are unaffected by who owns the schema.
--
-- The SECURITY DEFINER functions in 0003 therefore run as postgres. That is
-- safe here because each body is fixed, narrow, and pins `search_path = ''`,
-- so there is no search-path hijacking surface and no caller-supplied SQL.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- PUBLIC-INHERITED PRIVILEGES
--
-- A fresh Postgres role silently inherits grants held by PUBLIC: usage on the
-- public schema, usage on the pg_net `net` schema, large-object functions and
-- system catalogue reads.
--
-- Supabase's hardening guide suggests revoking the revocable ones, but those
-- statements (`revoke all on schema public from public`, `revoke temporary on
-- database`, and database-wide default-privilege changes) are NOT run here:
-- this database also serves the live primaddc.com website, whose PostgREST
-- access depends on privileges in `public`. Changing them is exactly the kind
-- of blast-radius the isolation rules exist to prevent.
--
-- Instead the containment is positive: iims_app is granted table privileges
-- ONLY in the ten IIMS schemas, plus the three explicit cross-schema SELECTs
-- at the foot of this file. Inheriting `usage` on the public schema conveys
-- nothing without a table privilege to go with it, and the assertion in
-- scripts/check-coexistence.mjs fails the build if iims_app ever acquires one.
--
-- Never grant role membership (`grant postgres to iims_app`): membership would
-- pass along every privilege and defeat all of the above.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Schema usage. iims_app may enter the ten IIMS schemas and nothing else.
-- ---------------------------------------------------------------------------
grant usage on schema iam, crm, casework, intel, evidence, docs, reporting,
                      notify, config to iims_app;

-- The audit schema is entered but only ever written to.
grant usage on schema audit to iims_app;

-- ---------------------------------------------------------------------------
-- Table privileges. Full DML on the operational schemas; the audit schema is
-- INSERT-only. Note TRUNCATE is a separate privilege that row-level triggers
-- cannot catch, so it is never granted anywhere.
-- ---------------------------------------------------------------------------
do $$
declare
  s text;
begin
  foreach s in array array['iam','crm','casework','intel','evidence','docs',
                           'reporting','notify','config']
  loop
    execute format(
      'grant select, insert, update, delete on all tables in schema %I to iims_app', s);
    execute format(
      'grant usage, select on all sequences in schema %I to iims_app', s);
    execute format(
      'grant execute on all functions in schema %I to iims_app', s);

    -- ALTER DEFAULT PRIVILEGES is per-creating-role, and every IIMS object is
    -- created by postgres via the migration runner. Without this, tables added
    -- by later migrations would be unreachable until re-granted.
    execute format(
      'alter default privileges for role postgres in schema %I '
      'grant select, insert, update, delete on tables to iims_app', s);
    execute format(
      'alter default privileges for role postgres in schema %I '
      'grant usage, select on sequences to iims_app', s);
    execute format(
      'alter default privileges for role postgres in schema %I '
      'grant execute on functions to iims_app', s);
  end loop;
end
$$;

-- Audit and custody: insert only, forever.
grant insert on all tables in schema audit to iims_app;
alter default privileges for role postgres in schema audit
  grant insert on tables to iims_app;

-- ---------------------------------------------------------------------------
-- Cross-schema reads the IIMS needs but must not be able to modify.
--
-- public.profiles is the SHARED employee directory with primaddc.com: one
-- person record, one login. The IIMS reads it and never writes it: the
-- website's handle_new_user() trigger remains the only writer.
-- auth.users / auth.sessions back our own suspension and session-liveness
-- checks, because Supabase's ban_duration does not revoke live sessions.
-- ---------------------------------------------------------------------------
grant select on public.profiles to iims_app;
grant select on auth.users to iims_app;
grant select on auth.sessions to iims_app;

-- Vault holds the cron worker secret in plaintext behind a view. The
-- application role must never be able to read it. (Guarded: the vault schema
-- only exists once supabase_vault is enabled.)
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'vault') then
    execute 'revoke all on all tables in schema vault from iims_app';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- RESIDUAL RISK: recorded here deliberately, and in docs/architecture.md.
--
-- The postgres role owns every table these migrations create. It can DROP
-- TRIGGER, ALTER TABLE ... NO FORCE ROW LEVEL SECURITY, DROP POLICY, or set
-- session_replication_role = 'replica' to skip triggers entirely. Supabase's
-- only superuser (supabase_admin) is not available to customers, and
-- privileged-role event triggers are skipped for reserved roles, so there is
-- no lock that holds against it.
--
-- What the platform therefore delivers, and what PDDC is asked to accept in
-- writing, is:
--
--   append-only and tamper-PROOF for every application role;
--   tamper-EVIDENT against the platform administrator role, via hash
--   chaining plus signed chain-head anchors published on a schedule to
--   storage outside this project.
--
-- Mitigations in force: the postgres credential used
-- only by the migration runner and held as a break-glass secret; and external
-- anchoring, which makes tampering detectable even though it cannot be
-- prevented.
-- ---------------------------------------------------------------------------

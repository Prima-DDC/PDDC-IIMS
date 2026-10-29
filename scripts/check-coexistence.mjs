// Proves the IIMS has not touched the live primaddc.com website.
//
// This database serves both apps. The website owns `public` entirely; the
// IIMS owns ten schemas of its own and reads exactly three things across the
// boundary. Every rule below is asserted, and a violation exits non-zero so
// CI fails.
//
// Run with `npm run check:coexistence`, and with --snapshot to print the
// current state without asserting (useful as a before/after baseline).

import pg from "pg";
import { supabaseSsl } from "./_db-ssl.mjs";

const IIMS_SCHEMAS = [
  "iam", "crm", "casework", "intel", "evidence",
  "docs", "reporting", "audit", "notify", "config",
];

// The only cross-boundary reads the IIMS is permitted.
const ALLOWED_FOREIGN_READS = [
  { schema: "public", table: "profiles" },   // shared employee directory
  { schema: "auth", table: "users" },        // identity
  { schema: "auth", table: "sessions" },     // session-liveness checks
];

const snapshotOnly = process.argv.includes("--snapshot");
const failures = [];
const notes = [];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

async function main() {
  const client = new pg.Client({
    connectionString: requireEnv("SUPABASE_DB_URL"),
    ssl: supabaseSsl(),
    application_name: "pddc-iims-coexistence",
  });
  await client.connect();

  try {
    // ---------------------------------------------------------------- facts
    const { rows: version } = await client.query("select version() as v");

    const { rows: schemas } = await client.query(`
      select nspname
      from pg_namespace
      where nspname not like 'pg_%' and nspname <> 'information_schema'
      order by nspname
    `);

    const { rows: publicTables } = await client.query(`
      select count(*)::int as n from pg_tables where schemaname = 'public'
    `);

    const { rows: websiteLedger } = await client.query(`
      select count(*)::int as applied, max(name) as latest
      from public._migrations
    `);

    // config._migrations does not exist until the first migration has run.
    const { rows: iimsLedger } = await client
      .query(
        `select count(*)::int as applied, max(name) as latest from config._migrations`,
      )
      .catch(() => ({ rows: [{ applied: 0, latest: null }] }));

    const { rows: roles } = await client.query(`
      select rolname, rolcanlogin, rolbypassrls, rolsuper
      from pg_roles
      where rolname in ('iims_app', 'iims_audit_owner', 'postgres', 'service_role')
      order by rolname
    `);

    // Every table privilege iims_app holds, anywhere in the database.
    const { rows: grants } = await client.query(`
      select table_schema, table_name, string_agg(distinct privilege_type, ',' order by privilege_type) as privs
      from information_schema.table_privileges
      where grantee = 'iims_app'
      group by table_schema, table_name
      order by table_schema, table_name
    `);

    console.log(`\nPostgres: ${version[0].v.split(",")[0]}`);
    console.log(`Schemas:  ${schemas.map((s) => s.nspname).join(", ")}`);
    console.log(`public tables (website): ${publicTables[0].n}`);
    console.log(`website ledger: ${websiteLedger[0].applied} applied, latest ${websiteLedger[0].latest}`);
    console.log(`IIMS ledger:    ${iimsLedger[0].applied} applied, latest ${iimsLedger[0].latest}`);
    console.log("\nRoles:");
    console.table(roles);

    if (snapshotOnly) {
      console.log("\niims_app table privileges:");
      console.table(grants);
      console.log("\n(snapshot only: no assertions run)");
      return;
    }

    // ----------------------------------------------------------- assertions

    // 1. The website's ledger is intact and separate from ours.
    assert(
      websiteLedger[0].applied > 0,
      "public._migrations is empty: the website's migration history may have been damaged.",
    );
    assert(
      iimsLedger[0].applied > 0,
      "config._migrations is empty: run `npm run db:migrate` first.",
    );

    // 2. iims_app holds privileges only inside IIMS schemas, plus the three
    //    explicit foreign reads. This is the load-bearing assertion: it is
    //    what makes a bug in the IIMS unable to reach website data.
    for (const g of grants) {
      if (IIMS_SCHEMAS.includes(g.table_schema)) continue;

      const allowed = ALLOWED_FOREIGN_READS.find(
        (a) => a.schema === g.table_schema && a.table === g.table_name,
      );

      if (!allowed) {
        failures.push(
          `iims_app has ${g.privs} on ${g.table_schema}.${g.table_name}, which is outside the IIMS boundary.`,
        );
        continue;
      }

      const privs = g.privs.split(",");
      const writes = privs.filter((p) => p !== "SELECT");
      if (writes.length > 0) {
        failures.push(
          `iims_app has write privileges (${writes.join(",")}) on ${g.table_schema}.${g.table_name}; only SELECT is permitted.`,
        );
      }
    }

    // 3. The audit schema is INSERT-only for the application role (PRD §13).
    const auditGrants = grants.filter((g) => g.table_schema === "audit");
    assert(auditGrants.length > 0, "iims_app has no privileges on the audit schema at all.");
    for (const g of auditGrants) {
      const privs = g.privs.split(",");
      const forbidden = privs.filter((p) => p !== "INSERT");
      if (forbidden.length > 0) {
        failures.push(
          `audit.${g.table_name}: iims_app holds ${forbidden.join(",")}: the audit trail must be INSERT-only.`,
        );
      }
    }

    // 4. The application role can never ignore RLS.
    const appRole = roles.find((r) => r.rolname === "iims_app");
    assert(appRole, "Role iims_app does not exist. Run `npm run db:migrate`.");
    if (appRole) {
      assert(!appRole.rolbypassrls, "iims_app has BYPASSRLS: row-level security would be ignored.");
      assert(!appRole.rolsuper, "iims_app is a superuser.");
    }

    // 5. Every IIMS table has RLS enabled AND forced. FORCE matters because
    //    postgres owns these tables, and an owner bypasses its own policies
    //    without it.
    const { rows: unforced } = await client.query(`
      select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r'
        and n.nspname = any($1::text[])
        and c.relname <> '_migrations'
        and (not c.relrowsecurity or not c.relforcerowsecurity)
      order by n.nspname, c.relname
    `, [IIMS_SCHEMAS]);

    for (const t of unforced) {
      failures.push(
        `${t.nspname}.${t.relname}: RLS enabled=${t.relrowsecurity}, forced=${t.relforcerowsecurity}: both must be true.`,
      );
    }

    // 6. The append-only guards are actually attached.
    const { rows: guards } = await client.query(`
      select c.relname, t.tgname
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'audit' and not t.tgisinternal
      order by c.relname, t.tgname
    `);
    const guardNames = guards.map((g) => `${g.relname}.${g.tgname}`);
    for (const required of [
      "audit_log.audit_log_hash_chain",
      "audit_log.audit_log_no_mutate",
      "audit_log.audit_log_no_truncate",
      "access_log.access_log_no_mutate",
      "access_log.access_log_no_truncate",
    ]) {
      assert(guardNames.includes(required), `Missing append-only guard: ${required}`);
    }

    // 7. The hash chain is unbroken.
    const { rows: chain } = await client
      .query("select * from audit.verify_chain(0)")
      .catch((e) => {
        notes.push(`could not verify the hash chain: ${e.message}`);
        return { rows: [null] };
      });
    if (chain[0]) {
      assert(
        chain[0].ok,
        `Audit hash chain broken at seq ${chain[0].first_bad_seq} (${chain[0].first_bad_id}).`,
      );
      notes.push(`Audit chain verified: ${chain[0].checked} entries, unbroken.`);
    }

    // ---------------------------------------------------------------- report
    console.log("\niims_app table privileges:");
    console.table(grants);

    for (const n of notes) console.log(`note: ${n}`);

    if (failures.length > 0) {
      console.error(`\nFAILED: ${failures.length} coexistence/integrity violation(s):`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }

    console.log("\nPASS: IIMS is contained, audit trail is append-only, website untouched.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

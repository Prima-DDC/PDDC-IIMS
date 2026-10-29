// Dry-run validator: applies every pending migration inside ONE transaction
// and then always ROLLS BACK, so nothing is persisted.
//
// This exists because the IIMS shares its database with the live primaddc.com
// website. Being able to prove a migration set is syntactically valid, that
// the extensions it needs exist, and that it creates only IIMS objects: all
// without writing to production: is worth having as its own step.
//
// Exit 0 means the migrations would apply cleanly. It does NOT apply them:
// use `npm run db:migrate` for that.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { supabaseSsl } from "./_db-ssl.mjs";

const MIGRATIONS_DIR = path.resolve("supabase/migrations");
const IIMS_SCHEMAS = [
  "iam", "crm", "casework", "intel", "evidence",
  "docs", "reporting", "audit", "notify", "config",
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const client = new pg.Client({
    connectionString: requireEnv("SUPABASE_DB_URL"),
    ssl: supabaseSsl(),
    application_name: "pddc-iims-validate",
  });
  await client.connect();

  let failed = false;

  try {
    await client.query("begin");

    // Record what the website owns, so we can prove we did not disturb it.
    const { rows: before } = await client.query(
      `select count(*)::int as n from pg_tables where schemaname = 'public'`,
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // Probe for existence rather than catching the failure: inside a
    // transaction, a failed statement aborts everything that follows, so a
    // JS-level .catch() would leave the transaction unusable.
    const { rows: ledgerExists } = await client.query(
      `select exists (
         select 1 from pg_tables where schemaname = 'config' and tablename = '_migrations'
       ) as present`,
    );
    const applied = new Set();
    if (ledgerExists[0].present) {
      const { rows } = await client.query("select name from config._migrations");
      for (const r of rows) applied.add(r.name);
    }

    console.log(`Validating ${files.length} migration file(s) in a transaction that will be rolled back.\n`);

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip    ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`  apply   ${file} ... `);
      try {
        await client.query(sql);
        console.log("ok");
      } catch (error) {
        console.log("FAILED");
        console.error(`\n  ${error.message}`);
        if (error.hint) console.error(`  hint: ${error.hint}`);
        if (error.position) {
          const pos = Number(error.position);
          console.error("  --- near ---");
          console.error(
            sql
              .slice(Math.max(0, pos - 160), pos + 160)
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n"),
          );
        }
        failed = true;
        break;
      }
    }

    if (!failed) {
      // ---- post-conditions, evaluated inside the same transaction ---------
      const { rows: after } = await client.query(
        `select count(*)::int as n from pg_tables where schemaname = 'public'`,
      );
      const { rows: created } = await client.query(
        `select nspname from pg_namespace where nspname = any($1::text[]) order by nspname`,
        [IIMS_SCHEMAS],
      );
      const { rows: tables } = await client.query(
        `select n.nspname, count(*)::int as tables
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind = 'r' and n.nspname = any($1::text[])
         group by n.nspname order by n.nspname`,
        [IIMS_SCHEMAS],
      );
      const { rows: roles } = await client.query(
        `select rolname, rolcanlogin, rolbypassrls from pg_roles
         where rolname in ('iims_app','iims_audit_owner') order by rolname`,
      );

      console.log(`\nIIMS schemas present: ${created.map((r) => r.nspname).join(", ")}`);
      console.log("Tables created:");
      console.table(tables);
      console.log("Roles created:");
      console.table(roles);

      if (after[0].n !== before[0].n) {
        console.error(
          `\nREFUSED: public table count changed ${before[0].n} -> ${after[0].n}. ` +
            "IIMS migrations must not create or drop anything in the website's schema.",
        );
        failed = true;
      } else {
        console.log(`\npublic schema untouched (${before[0].n} tables before and after).`);
      }

      // Smoke-test the hash chain end to end, still inside the transaction.
      try {
        await client.query(`select set_config('iims.user_id', extensions.gen_random_uuid()::text, true)`);
        await client.query(
          `insert into audit.audit_log (action, record_type, record_id, actor_email)
           values ('validate.smoke', 'validation', '1', 'validator@local')`,
        );
        await client.query(
          `insert into audit.audit_log (action, record_type, record_id, actor_email)
           values ('validate.smoke', 'validation', '2', 'validator@local')`,
        );
        const { rows: chain } = await client.query("select * from audit.verify_chain(0)");
        console.log(`hash chain smoke test: ${chain[0].checked} entries, ok=${chain[0].ok}`);
        if (!chain[0].ok) {
          console.error("REFUSED: the hash chain did not verify on freshly inserted rows.");
          failed = true;
        }

        // The append-only guards must actually bite.
        for (const [label, sql] of [
          ["UPDATE", "update audit.audit_log set action = 'tampered'"],
          ["DELETE", "delete from audit.audit_log"],
        ]) {
          try {
            await client.query("savepoint guard");
            await client.query(sql);
            await client.query("rollback to savepoint guard");
            console.error(`REFUSED: ${label} on audit.audit_log succeeded; it must be rejected.`);
            failed = true;
          } catch {
            await client.query("rollback to savepoint guard");
            console.log(`append-only guard: ${label} correctly rejected.`);
          }
        }
      } catch (error) {
        console.error(`\nREFUSED: audit smoke test errored: ${error.message}`);
        failed = true;
      }
    }
  } finally {
    // Always. This script never persists anything.
    await client.query("rollback").catch(() => {});
    await client.end();
    console.log("\nrolled back: the database was not modified.");
  }

  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Applies supabase/migrations/*.sql in filename order against SUPABASE_DB_URL,
// tracking applied files in config._migrations. Idempotent.
//
// COEXISTENCE: the primaddc.com website's own runner tracks its history in
// public._migrations. This one must never touch that table: two runners
// sharing one ledger would corrupt both histories.
//
// Runs as the `postgres` role over the SESSION-mode pooler (port 5432),
// because DDL needs a stable session. Nothing at runtime uses this role.
//
// TLS is verified against the public CA chain. If verification ever fails,
// pin Supabase's CA certificate via PGSSLROOTCERT: never disable it.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { supabaseSsl } from "./_db-ssl.mjs";

const MIGRATIONS_DIR = path.resolve("supabase/migrations");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env.local and fill it in.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const connectionString = requireEnv("SUPABASE_DB_URL");

  const client = new pg.Client({
    connectionString,
    ssl: supabaseSsl(),
    application_name: "pddc-iims-migrate",
  });
  await client.connect();

  try {
    // The ledger lives in our own schema, so bootstrap it before anything else.
    await client.query("create schema if not exists config");
    await client.query(
      `create table if not exists config._migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );

    const { rows } = await client.query("select name from config._migrations");
    const applied = new Set(rows.map((r) => r.name));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`applying ${file} ... `);

      // One transaction per migration: a failure leaves no partial schema.
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into config._migrations (name) values ($1)", [file]);
        await client.query("commit");
        console.log("ok");
        count += 1;
      } catch (error) {
        await client.query("rollback");
        console.log("FAILED");
        console.error(`\n${file}: ${error.message}\n`);
        if (error.position) {
          // Point at the offending statement; SQL errors alone are cryptic.
          const pos = Number(error.position);
          console.error("--- near ---");
          console.error(sql.slice(Math.max(0, pos - 200), pos + 200));
          console.error("------------");
        }
        process.exit(1);
      }
    }

    console.log(count === 0 ? "migrations up to date" : `applied ${count} migration(s)`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

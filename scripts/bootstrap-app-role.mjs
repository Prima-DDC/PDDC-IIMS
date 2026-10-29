// Grants LOGIN and sets the password for the restricted iims_app role, from
// IIMS_APP_DB_PASSWORD. Also usable to rotate that password.
//
// Why this is a separate script rather than part of migration 0002: migrations
// are committed to git, and a role password must never appear in one. 0002
// creates the role NOLOGIN with its grants; this grants it a credential.
//
// Supabase note: a custom role's password is yours to manage. Resetting the
// project database password in the dashboard does NOT rotate it.

import pg from "pg";
import { supabaseSsl } from "./_db-ssl.mjs";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const connectionString = requireEnv("SUPABASE_DB_URL");
  const password = requireEnv("IIMS_APP_DB_PASSWORD");

  if (password.length < 24) {
    console.error("IIMS_APP_DB_PASSWORD must be at least 24 characters.");
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString,
    ssl: supabaseSsl(),
    application_name: "pddc-iims-bootstrap-role",
  });
  await client.connect();

  try {
    const { rows } = await client.query(
      "select 1 from pg_roles where rolname = 'iims_app'",
    );
    if (rows.length === 0) {
      console.error("Role iims_app does not exist. Run `npm run db:migrate` first.");
      process.exit(1);
    }

    // Parameters are not allowed in ALTER ROLE, so the password is quoted
    // with Postgres's own literal quoting rather than interpolated raw.
    const quoted = await client.query("select quote_literal($1) as q", [password]);
    await client.query(`alter role iims_app login password ${quoted.rows[0].q}`);

    // The dangerous attributes are ASSERTED, not set: on Supabase only a
    // superuser may alter SUPERUSER or BYPASSRLS, and `postgres` is not one.
    // The role is created without them (migration 0002), so the job here is to
    // prove that is still true rather than to try to enforce it.
    const { rows: attrs } = await client.query(
      `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
       from pg_roles where rolname = 'iims_app'`,
    );
    const bad = Object.entries(attrs[0]).filter(([, v]) => v === true);
    if (bad.length > 0) {
      console.error(
        `REFUSED: iims_app holds privileged attribute(s): ${bad
          .map(([k]) => k)
          .join(", ")}.\n` +
          "The application role must never be able to ignore row-level security.",
      );
      process.exit(1);
    }

    console.log("iims_app: LOGIN granted and password set.");
    console.log(
      "verified not superuser, not bypassrls, no createrole/createdb/replication.",
    );
    console.log("Connect via IIMS_APP_DB_URL as iims_app.<project-ref>");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

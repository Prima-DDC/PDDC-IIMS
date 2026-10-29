import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Puts the end-to-end fixtures back to the state the seed creates them in.
 *
 * Two things drift, and both made the suite runnable exactly once per
 * re-seed, which is not a property a test suite should have.
 *
 * The enrolment test signs in as `pddc-e2e-enrol` and enrols a factor for
 * real, which is the point of it: the enrolment flow is the one path a seeded
 * factor cannot exercise. The consequence is that the account then has a
 * factor whose secret exists only in that run's memory, so the second run of
 * the suite cannot sign in as it and the test fails with "has an authenticator
 * from an earlier run whose secret is not known here".
 *
 * Re-seeding before every run would fix that too, but it rotates five
 * passwords and makes six admin API calls to put one row back, so this does
 * the narrow thing instead.
 *
 * The second is the suspended fixture's Supabase ban. The seed deliberately
 * leaves it unbanned so that `iam.users.status = 'suspended'` is what blocks
 * it, which is the thing worth testing: the platform's own per-request check
 * rather than Supabase refusing the password. The administration test then
 * suspends it through the interface, which does apply a ban, so on the next
 * run the password is refused at the door and the account never reaches the
 * screen the test is about.
 *
 * Both are deliberately specific: named accounts, by their full reserved-TLD
 * addresses. Nothing else is touched even if this runs against the wrong
 * database, and each step is a no-op when the account does not exist.
 */

const ENROL_EMAIL = "pddc-e2e-enrol@example.invalid";
const SUSPENDED_EMAIL = "pddc-e2e-suspended@example.invalid";

function loadEnv(file: string) {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

export default async function globalSetup() {
  loadEnv(".env.local");

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    // The suite will fail on its own with a clearer message than this could.
    return;
  }

  const client = new pg.Client({
    connectionString,
    ssl: {
      ca: readFileSync(path.resolve("certs/supabase-prod-ca.crt")),
      rejectUnauthorized: true,
    },
    application_name: "pddc-iims-e2e-global-setup",
  });

  try {
    await client.connect();

    const { rows } = await client.query<{ id: string }>(
      "select id from auth.users where lower(email) = $1",
      [ENROL_EMAIL],
    );
    if (rows.length === 0) return;

    const id = rows[0].id;
    const { rowCount } = await client.query(
      "delete from auth.mfa_factors where user_id = $1",
      [id],
    );
    await client.query(
      "update iam.users set mfa_enrolled_at = null where id = $1",
      [id],
    );

    if (rowCount) {
      console.log(
        `global setup: cleared ${rowCount} authenticator(s) from ${ENROL_EMAIL}, ` +
          "so the enrolment flow runs for real again.",
      );
    }

    // banned_until is written by Supabase Auth's admin API, which has no
    // "unban one user" call that does not also touch other fields, so it is
    // cleared in the column directly. The row belongs to a reserved-TLD test
    // account that can never receive mail.
    const { rowCount: unbanned } = await client.query(
      `update auth.users set banned_until = null
       where lower(email) = $1 and banned_until is not null`,
      [SUSPENDED_EMAIL],
    );
    if (unbanned) {
      console.log(
        `global setup: lifted the Supabase ban on ${SUSPENDED_EMAIL}, so the ` +
          "platform's own suspension check is what blocks it.",
      );
    }
  } catch (error) {
    // Not fatal: the suite reports the consequence more clearly than a crash
    // here would, and a transient connection failure should not stop a run.
    console.warn(
      `global setup could not reset the fixtures: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

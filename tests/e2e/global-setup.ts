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

/**
 * Refuses to run against a server that predates the current code.
 *
 * `reuseExistingServer` is on outside CI, which is the right default: a
 * forty-minute suite should not restart the server eight times. The cost is
 * the failure this exists to catch. A server started before a rebuild keeps
 * serving while `.next` is replaced underneath it, and what comes out is
 * neither the old build nor the new one: pages render without their scripts,
 * and the suite fails on `fill()` timing out against a form that is there in
 * the HTML.
 *
 * That cost a full run of this suite, and the failure named a login form
 * rather than a stale server, which is why it took so long to see. So the
 * check is one request: every response from this application carries a
 * `Content-Security-Policy` built in the proxy, and a server without that
 * header is older than the proxy that sets it.
 *
 * It is a proxy for "is this the current build" rather than a proof of one,
 * and that is the honest description. If the CSP is ever removed, this check
 * goes with it, and whoever removes it should replace it with whatever the
 * current equivalent is: a cheap request that only the current server can
 * answer correctly.
 */
async function refuseAStaleServer(baseUrl: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/login`, { redirect: "manual" });
  } catch {
    // Nothing is listening yet, which is the normal case: Playwright starts
    // the server after global setup.
    return;
  }

  if (response.headers.get("content-security-policy")) return;

  throw new Error(
    [
      `The server already running at ${baseUrl} is not serving the current`,
      "code: its responses carry no Content-Security-Policy, and the proxy in",
      "this build sets one on every request.",
      "",
      "It is almost certainly a server started before a rebuild, which keeps",
      "serving while .next is replaced underneath it. The suite would fail",
      "with timeouts that name forms rather than the cause.",
      "",
      "Stop it and run again. Playwright will start a fresh one.",
    ].join("\n"),
  );
}

export default async function globalSetup() {
  loadEnv(".env.local");

  await refuseAStaleServer(
    process.env.E2E_BASE_URL ??
      `http://127.0.0.1:${process.env.E2E_PORT ?? 3100}`,
  );

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

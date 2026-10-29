/**
 * Creates the accounts the end-to-end tests sign in as, and removes them
 * again afterwards.
 *
 *   npm run seed:e2e          create
 *   npm run seed:e2e -- clean remove
 *
 * These are real accounts in the shared Supabase project, so they are:
 *   - clearly named (pddc-e2e-*@example.invalid, a reserved TLD that can
 *     never receive mail),
 *   - refused outright unless E2E_ALLOW_SEED=1, so this cannot be run by
 *     accident against production,
 *   - fully removed by the clean step, including their auth.users rows.
 *
 * Passwords are generated, printed once and written to .env.e2e, which is
 * gitignored along with every other .env file.
 */

import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { supabaseSsl } from "./_db-ssl.mjs";

const PREFIX = "pddc-e2e";
const DOMAIN = "example.invalid";

interface Spec {
  key: string;
  email: string;
  fullName: string;
  /** Omit to create an auth account with NO iam.users row, for /no-access. */
  iims?: { clearance: string; status: string; roles: string[] };
  /**
   * Seed a verified TOTP factor with a known secret.
   *
   * Enrolling through the browser works, but the secret only exists in that
   * run's memory, so a Playwright worker restart loses it and every later
   * sign-in fails. Seeding the factor makes two-factor sign-in deterministic.
   * One account deliberately omits this so the enrolment flow is still
   * exercised for real.
   */
  seedMfa?: boolean;
}

const SPECS: Spec[] = [
  {
    key: "ADMIN",
    email: `${PREFIX}-admin@${DOMAIN}`,
    fullName: "E2E Administrator",
    iims: { clearance: "STRICTLY_RESTRICTED", status: "active", roles: ["administrator"] },
    seedMfa: true,
  },
  {
    key: "INVESTIGATOR",
    email: `${PREFIX}-investigator@${DOMAIN}`,
    fullName: "E2E Investigator",
    iims: { clearance: "CONFIDENTIAL", status: "active", roles: ["investigator"] },
    seedMfa: true,
  },
  {
    key: "SUSPENDED",
    email: `${PREFIX}-suspended@${DOMAIN}`,
    fullName: "E2E Suspended",
    iims: { clearance: "INTERNAL", status: "suspended", roles: ["investigator"] },
    seedMfa: true,
  },
  {
    // Exists in the shared directory but has no IIMS record, which is the
    // common real-world case: a website account is not platform access.
    key: "NOACCESS",
    email: `${PREFIX}-noaccess@${DOMAIN}`,
    fullName: "E2E No Access",
  },
  {
    // An operations manager, which is the role PRD 16 gives client and
    // engagement rights to. Needed as a SECOND identity: the engagement
    // approval gate refuses self-approval, so proving approval works at all
    // takes two people.
    key: "MANAGER",
    email: `${PREFIX}-manager@${DOMAIN}`,
    fullName: "E2E Operations Manager",
    iims: {
      clearance: "RESTRICTED",
      status: "active",
      roles: ["operations_manager"],
    },
    seedMfa: true,
  },
  {
    // Has access but no authenticator, so the enrolment flow is tested.
    key: "ENROL",
    email: `${PREFIX}-enrol@${DOMAIN}`,
    fullName: "E2E Enrolment",
    iims: { clearance: "INTERNAL", status: "active", roles: ["investigator"] },
  },
];

/** A stable base32 secret per account, so codes are reproducible. */
function totpSecretFor(key: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += alphabet[(key.charCodeAt(i % key.length) + i * 7) % alphabet.length];
  }
  return out;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

/**
 * Removes the records the end-to-end tests create, beyond the accounts.
 *
 * A test that creates a role and deletes it at the end leaves the role behind
 * when it fails in between, and those accumulate in the live catalogue: eight
 * of them had built up before this existed. Everything removed here matches a
 * pattern only the tests produce, and each deletion is reported so an
 * unexpected match is visible rather than silent.
 *
 * Roles with members are left alone and reported. A fixture role should never
 * have any, so one that does is a real assignment that happens to match the
 * pattern, and guessing would be worse than stopping.
 */
async function cleanFixtureRecords(db: pg.Client): Promise<void> {
  const { rows: roles } = await db.query<{ key: string; members: string }>(
    `select r.key,
            (select count(*) from iam.user_roles ur where ur.role_id = r.id) as members
     from iam.roles r
     where r.key like 'e2e_role_%' or r.key like 'probe_role_%'
     order by r.key`,
  );

  for (const role of roles) {
    if (Number(role.members) > 0) {
      console.log(`  kept role ${role.key}: it has ${role.members} member(s)`);
      continue;
    }
    // role_permissions, role_features and role_versions cascade.
    await db.query("delete from iam.roles where key = $1", [role.key]);
    console.log(`  removed role ${role.key}`);
  }

  // CRM fixtures. Conflict checks and matches cascade from the client, and a
  // case would block the engagement, which is why cases are removed first.
  // The casework schema may not exist yet, so its presence is checked rather
  // than assumed: this script has to work against a database at any migration.
  const { rows: hasCasework } = await db.query<{ present: boolean }>(
    "select to_regclass('casework.cases') is not null as present",
  );

  const patterns = ["E2E %", "Probe %", "Integration Test %"];
  for (const pattern of patterns) {
    const cases = hasCasework[0].present
      ? (
          await db.query(
            `delete from casework.cases c
             using crm.clients cl
             where c.client_id = cl.id and cl.organisation_name like $1`,
            [pattern],
          )
        ).rowCount
      : 0;
    const { rowCount: engagements } = await db.query(
      `delete from crm.engagements e
       using crm.clients cl
       where e.client_id = cl.id and cl.organisation_name like $1`,
      [pattern],
    );
    const { rowCount: enquiries } = await db.query(
      `delete from crm.enquiries q
       where q.subject like $1 or q.prospect_name like $1`,
      [pattern],
    );
    const { rowCount: clients } = await db.query(
      "delete from crm.clients where organisation_name like $1",
      [pattern],
    );
    if (cases || engagements || enquiries || clients) {
      console.log(
        `  removed "${pattern}": ${clients ?? 0} client(s), ` +
          `${engagements ?? 0} engagement(s), ${cases ?? 0} case(s), ` +
          `${enquiries ?? 0} enquiry(ies)`,
      );
    }
  }

  // Departments and offices the organisation test creates.
  for (const table of ["departments", "offices"] as const) {
    const { rowCount } = await db.query(
      `delete from iam.${table} where name like 'E2E %'`,
    );
    if (rowCount) console.log(`  removed ${rowCount} ${table} row(s)`);
  }

  console.log("Fixture records cleaned.");
}

async function main() {
  const clean = process.argv.includes("clean");

  if (process.env.E2E_ALLOW_SEED !== "1") {
    console.error(
      "Refusing to run. These are real accounts in a shared project.\n" +
        "Set E2E_ALLOW_SEED=1 to confirm you intend to create or remove them.",
    );
    process.exit(1);
  }

  const admin = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const db = new pg.Client({
    connectionString: requireEnv("SUPABASE_DB_URL"),
    ssl: supabaseSsl(),
    application_name: "pddc-iims-seed-e2e",
  });
  await db.connect();

  try {
    if (clean) {
      const { rows } = await db.query<{ id: string; email: string }>(
        `select id, email from auth.users where email like $1`,
        [`${PREFIX}-%@${DOMAIN}`],
      );

      for (const row of rows) {
        // Deleting the auth user cascades to iam.users and public.profiles.
        const { error } = await admin.auth.admin.deleteUser(row.id);
        console.log(
          error ? `  failed to remove ${row.email}: ${error.message}` : `  removed ${row.email}`,
        );
      }
      console.log(`Cleaned ${rows.length} end-to-end account(s).`);

      // The accounts are not the only residue. A run that fails part way
      // through leaves behind whatever it had created by then, in a database
      // shared with the live website, so the clean step removes those too.
      // Each pattern is one the tests generate and nothing else could.
      await cleanFixtureRecords(db);
      return;
    }

    const env: string[] = [
      "# Generated by scripts/seed-e2e-users.ts. Gitignored.",
      "# Accounts in a reserved TLD that cannot receive mail.",
      "",
    ];

    for (const spec of SPECS) {
      const password = `E2e-${randomBytes(18).toString("base64url")}!`;

      const { rows: existing } = await db.query<{ id: string }>(
        "select id from auth.users where lower(email) = $1",
        [spec.email],
      );

      let userId: string;

      if (existing.length > 0) {
        userId = existing[0].id;
        const { error } = await admin.auth.admin.updateUserById(userId, {
          password,
          email_confirm: true,
          ban_duration: "none",
        });
        if (error) throw new Error(`${spec.email}: ${error.message}`);
        console.log(`  reset ${spec.email}`);
      } else {
        const { data, error } = await admin.auth.admin.createUser({
          email: spec.email,
          password,
          email_confirm: true,
          user_metadata: { full_name: spec.fullName },
        });
        if (error || !data.user) {
          throw new Error(`${spec.email}: ${error?.message ?? "no user returned"}`);
        }
        userId = data.user.id;
        console.log(`  created ${spec.email}`);
      }

      // The website's trigger creates public.profiles; make sure the name is
      // set so the directory screens have something to show.
      await db.query(
        `update public.profiles set full_name = $2 where id = $1 and (full_name is null or full_name = '')`,
        [userId, spec.fullName],
      );

      if (spec.iims) {
        await db.query(
          `insert into iam.users (id, clearance, status, employee_id, job_title)
           values ($1, $2, $3, $4, 'End-to-end test account')
           on conflict (id) do update
           set clearance = excluded.clearance,
               status = excluded.status,
               deleted_at = null,
               locked_until = null,
               failed_login_count = 0`,
          [userId, spec.iims.clearance, spec.iims.status, `E2E-${spec.key}`],
        );

        await db.query("delete from iam.user_roles where user_id = $1", [userId]);

        for (const key of [...spec.iims.roles, "employee"]) {
          await db.query(
            `insert into iam.user_roles (user_id, role_id, is_primary, reason)
             select $1, r.id, $3, 'end-to-end test seed'
             from iam.roles r where r.key = $2
             on conflict (user_id, role_id, scope_type, scope_id) do nothing`,
            [userId, key, key === spec.iims.roles[0]],
          );
        }
      } else {
        // Deliberately no iam.users row.
        await db.query("delete from iam.users where id = $1", [userId]);
      }

      // Replace any factor from a previous run with one whose secret we know.
      await db.query("delete from auth.mfa_factors where user_id = $1", [userId]);

      let secret: string | null = null;
      if (spec.seedMfa) {
        secret = totpSecretFor(spec.key);
        await db.query(
          `insert into auth.mfa_factors
             (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
           values (extensions.gen_random_uuid(), $1, 'E2E seeded', 'totp', 'verified', $2, now(), now())`,
          [userId, secret],
        );
        await db.query(
          "update iam.users set mfa_enrolled_at = now() where id = $1",
          [userId],
        );
      } else {
        await db.query(
          "update iam.users set mfa_enrolled_at = null where id = $1",
          [userId],
        );
      }

      env.push(`E2E_${spec.key}_EMAIL=${spec.email}`);
      env.push(`E2E_${spec.key}_PASSWORD=${password}`);
      if (secret) env.push(`E2E_${spec.key}_TOTP=${secret}`);
      env.push("");
    }

    writeFileSync(".env.e2e", `${env.join("\n")}\n`, "utf8");
    console.log("");
    console.log("Wrote .env.e2e with the generated credentials.");
    console.log("Run the suite with: npm run test:e2e");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * Grants IIMS access to every employee who has set up their portal account.
 *
 *   npm run grant-access -- --dry-run     # show what would change
 *   npm run grant-access                  # do it
 *
 * Why this script exists, and why it is not a migration: PRD 3.2 is explicit
 * that a primaddc.com account grants nothing in the IIMS and that an
 * administrator provisions access deliberately. That is a decision somebody
 * takes about real people, so it belongs in a tool an administrator runs and
 * can see the output of, not in a migration that runs silently on deploy.
 *
 * WHO QUALIFIES: "accepted the invite and set up" is read as an account whose
 * email is confirmed AND which has signed in at least once. An invited
 * account that was never opened has not been set up by anybody, and handing
 * it investigative access would be provisioning a mailbox rather than a
 * person.
 *
 * WHAT THEY GET:
 *
 *   - The `employee` baseline role, which is a working platform on its own:
 *     their dashboard, notifications, profile, their own tasks and their own
 *     time.
 *   - The IIMS counterpart of their portal role, where one exists. The
 *     mapping below is one-to-one and not invented: the IIMS role catalogue
 *     already contains a role of each name.
 *   - Clearance INTERNAL, which `iam.classification_levels` describes as
 *     "PDDC staff generally".
 *
 * WHAT THEY DO NOT GET, deliberately: clearance above INTERNAL. Clearance is
 * the need-to-know half of PRD 3.2 and it is per person, not per job title: a
 * manager who has no business reading a particular case's RESTRICTED material
 * should not be able to, and deciding that for twelve real people from a
 * column in another application's table would be guessing. An administrator
 * raises it per person in Administration > Users, where the change is
 * recorded against their name.
 *
 * The exception is the portal's own administrators, who get STRICTLY_RESTRICTED
 * because PRD 16 says an administrator's access is "automatic and always
 * logged", and an administrator who cannot see what they administer cannot do
 * the job.
 *
 * SAFE TO RE-RUN: every write is idempotent, an existing IIMS record is left
 * alone rather than reset, and the end-to-end test fixtures are skipped by
 * name so that re-running this never breaks the suite. In particular there is
 * a fixture that must NOT have access and one that must stay suspended.
 */

import pg from "pg";
import { supabaseSsl } from "./_db-ssl.mjs";

/** Portal role to IIMS role. Every value exists in `iam.roles`. */
const ROLE_MAP: Record<string, string | null> = {
  admin: "administrator",
  ceo: "ceo",
  manager: "manager",
  hr: "hr_manager",
  finance: "finance",
  employee: null, // the baseline is all they get
};

/**
 * Accounts this script never touches.
 *
 * The end-to-end suite depends on the precise state of each: one must have no
 * IIMS record at all so that the "no access" screen can be tested, and one
 * must stay suspended so that suspension can be. Provisioning them would
 * turn two passing tests into confusing failures.
 */
const isTestFixture = (email: string) =>
  email.endsWith("@example.invalid") || email.includes("pddc-e2e-");

type Candidate = {
  id: string;
  email: string;
  full_name: string | null;
  job_title: string | null;
  portal_role: string | null;
  has_iims: boolean;
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error("Missing SUPABASE_DB_URL. See .env.example.");
    process.exit(1);
  }

  const db = new pg.Client({
    connectionString: url,
    ssl: supabaseSsl(),
    application_name: "pddc-iims-grant-access",
  });
  await db.connect();

  try {
    const { rows: candidates } = await db.query<Candidate>(`
      select pr.id,
             pr.email,
             pr.full_name,
             pr.job_title,
             pr.role as portal_role,
             exists (
               select 1 from iam.users u
               where u.id = pr.id and u.deleted_at is null
             ) as has_iims
      from public.profiles pr
      join auth.users au on au.id = pr.id
      where au.email_confirmed_at is not null
        and au.last_sign_in_at is not null
      order by pr.email
    `);

    const eligible = candidates.filter((c) => !isTestFixture(c.email));
    const skipped = candidates.filter((c) => isTestFixture(c.email));

    console.log(
      `${candidates.length} portal accounts are confirmed and have signed in.`,
    );
    console.log(`${skipped.length} are end-to-end fixtures and are left alone.`);
    console.log(`${eligible.length} are employees.\n`);

    const granted: string[] = [];
    const already: string[] = [];

    for (const person of eligible) {
      const portalRole = (person.portal_role ?? "employee").toLowerCase();
      const mapped = ROLE_MAP[portalRole];
      const isAdmin = mapped === "administrator";
      const clearance = isAdmin ? "STRICTLY_RESTRICTED" : "INTERNAL";

      if (!(portalRole in ROLE_MAP)) {
        console.log(
          `  ?  ${person.email}: portal role "${portalRole}" has no IIMS counterpart, so they get the baseline only.`,
        );
      }

      if (person.has_iims) {
        already.push(`${person.email} (${portalRole})`);
        continue;
      }

      if (dryRun) {
        granted.push(
          `${person.email} -> employee${mapped ? ` + ${mapped}` : ""}, ${clearance}`,
        );
        continue;
      }

      await db.query("begin");
      try {
        // An existing soft-deleted record is revived rather than duplicated;
        // an existing live one was filtered out above, so this never
        // downgrades somebody an administrator has already set up.
        await db.query(
          `insert into iam.users (id, clearance, status, job_title)
           values ($1, $2, 'active', $3)
           on conflict (id) do update
           set status = 'active',
               deleted_at = null,
               clearance = excluded.clearance`,
          [person.id, clearance, person.job_title],
        );

        const keys = mapped ? ["employee", mapped] : ["employee"];
        const { rows: roles } = await db.query<{ id: string; key: string }>(
          "select id, key from iam.roles where key = any($1::text[])",
          [keys],
        );

        for (const role of roles) {
          await db.query(
            `insert into iam.user_roles (user_id, role_id, is_primary, reason)
             values ($1, $2, $3, 'active employee portal account, provisioned in bulk')
             on conflict (user_id, role_id, scope_type, scope_id) do nothing`,
            [person.id, role.id, role.key !== "employee" || keys.length === 1],
          );
        }

        await db.query("commit");
        granted.push(
          `${person.email} -> ${roles.map((r) => r.key).join(" + ")}, ${clearance}`,
        );
      } catch (error) {
        await db.query("rollback");
        throw error;
      }
    }

    if (already.length > 0) {
      console.log("Already had IIMS access, left exactly as they were:");
      for (const line of already) console.log(`  = ${line}`);
      console.log("");
    }

    console.log(
      dryRun
        ? `Would grant access to ${granted.length}:`
        : `Granted access to ${granted.length}:`,
    );
    for (const line of granted) console.log(`  + ${line}`);

    console.log("");
    console.log("Every one of them still has to pass two-factor at first");
    console.log("sign-in, which is enrolled then if it is not already.");
    console.log("");
    console.log("Clearance is INTERNAL for everybody except the portal's own");
    console.log("administrators. Raise it per person in Administration > Users;");
    console.log("it is need-to-know and not something a job title decides.");

    if (dryRun) {
      console.log("");
      console.log("Dry run: nothing was written.");
    }
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

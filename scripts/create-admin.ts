/**
 * Creates (or repairs) the first administrator.
 *
 * Run once after the migrations:
 *   npm run create-admin -- you@primaddc.com "Your Name"
 *
 * What it does, and why each step is needed:
 *
 *   1. Creates the Supabase Auth user if they do not exist, or reuses the
 *      existing one. This is the SHARED identity with primaddc.com, so an
 *      existing staff account is reused rather than duplicated.
 *   2. Creates the iam.users record, which is what actually grants IIMS
 *      access, at STRICTLY_RESTRICTED clearance.
 *   3. Assigns the Administrator role plus the baseline Employee role.
 *
 * It does NOT set a password when reusing an existing account: that person
 * already has one. For a new account it sends an invitation, so no password
 * is ever typed into a terminal or stored in a script.
 */

import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { supabaseSsl } from "./_db-ssl.mjs";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const fullName = process.argv[3]?.trim();

  if (!email || !email.includes("@")) {
    console.error('Usage: npm run create-admin -- you@primaddc.com "Your Name"');
    process.exit(1);
  }

  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const db = new pg.Client({
    connectionString: requireEnv("SUPABASE_DB_URL"),
    ssl: supabaseSsl(),
    application_name: "pddc-iims-create-admin",
  });
  await db.connect();

  try {
    // ---------------------------------------------------- 1. the identity
    const { rows: found } = await db.query<{ id: string }>(
      "select id from auth.users where lower(email) = $1",
      [email],
    );

    let userId: string;
    let invited = false;

    if (found.length > 0) {
      userId = found[0].id;
      console.log(`Found an existing PDDC account for ${email}.`);
      console.log("Their current password and MFA enrolment are left untouched.");
    } else {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${appUrl}/login`,
        data: fullName ? { full_name: fullName } : undefined,
      });
      if (error || !data.user) {
        console.error(`Could not invite ${email}: ${error?.message ?? "no user returned"}`);
        process.exit(1);
      }
      userId = data.user.id;
      invited = true;
      console.log(`Invitation sent to ${email}.`);
    }

    // ------------------------------------------------- 2. the IIMS record
    await db.query("begin");

    await db.query(
      `insert into iam.users (id, clearance, status, job_title)
       values ($1, 'STRICTLY_RESTRICTED', $2, 'Administrator')
       on conflict (id) do update
       set clearance = 'STRICTLY_RESTRICTED',
           status = excluded.status,
           deleted_at = null`,
      [userId, invited ? "invited" : "active"],
    );

    // -------------------------------------------------------- 3. the roles
    const { rows: roles } = await db.query<{ id: string; key: string }>(
      "select id, key from iam.roles where key in ('administrator', 'employee')",
    );
    if (roles.length === 0) {
      console.error("No roles found. Run `npm run db:migrate` first.");
      await db.query("rollback");
      process.exit(1);
    }

    for (const role of roles) {
      await db.query(
        `insert into iam.user_roles (user_id, role_id, is_primary, reason)
         values ($1, $2, $3, 'first administrator, created by script')
         on conflict (user_id, role_id, scope_type, scope_id) do nothing`,
        [userId, role.id, role.key === "administrator"],
      );
    }

    await db.query("commit");

    // ------------------------------------------------------------- report
    const { rows: check } = await db.query<{
      status: string;
      clearance: string;
      is_admin: boolean;
      roles: string;
    }>(
      `select u.status, u.clearance, iam.is_administrator(u.id) as is_admin,
              string_agg(r.name, ', ' order by r.name) as roles
       from iam.users u
       left join iam.user_roles ur on ur.user_id = u.id
       left join iam.roles r on r.id = ur.role_id
       where u.id = $1
       group by u.status, u.clearance, u.id`,
      [userId],
    );

    console.log("");
    console.log("Administrator ready:");
    console.log(`  email      ${email}`);
    console.log(`  user id    ${userId}`);
    console.log(`  status     ${check[0]?.status}`);
    console.log(`  clearance  ${check[0]?.clearance}`);
    console.log(`  roles      ${check[0]?.roles}`);
    console.log(`  is admin   ${check[0]?.is_admin}`);
    console.log("");

    if (invited) {
      console.log("Next: open the invitation email, set a password, then enrol an");
      console.log("authenticator at first sign-in. The account activates once you");
      console.log("sign in successfully.");
    } else {
      console.log("Next: sign in at /login with the existing PDDC credentials.");
      console.log("Two-factor authentication is required and will be set up on");
      console.log("first sign-in if it is not already enrolled.");
    }
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

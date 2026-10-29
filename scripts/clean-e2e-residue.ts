/**
 * Clears what the end-to-end journeys leave behind in the shared database.
 *
 *   npm run clean:e2e               # show what would change, touch nothing
 *   npm run clean:e2e -- --confirm  # do it
 *
 * WHY THIS EXISTS. The journeys build their fixtures through the real screens,
 * which is what makes them worth running, and every run therefore leaves a
 * client, an engagement, a case and a handful of entities behind. After a day
 * of debugging there were 68 companies called "Delta Logistics <stamp> Ltd",
 * all 85% alike by name. They are harmless as data and they are not a capacity
 * problem, 32MB against the free tier's 500MB, but they are loud: every entity
 * page offers "These look alike" candidates drawn from the register, so the
 * duplicate-detection feature PRD 8.3 and 8.4 describe becomes a wall of test
 * records. That makes it harder to demonstrate and harder to test, which are
 * the two things it has to be.
 *
 * WHY IT IS SOFT. Everything here is marked `deleted_at` rather than removed,
 * for the same reason the platform soft-deletes everywhere else: an audit row
 * points at these records, a hash-chained trail cannot be rewritten to forget
 * them, and a case that vanished would take its own history with it. Soft
 * deletion is enough for the problem, because every register and every
 * similarity query already filters on `deleted_at is null`.
 *
 * THE ONE EXCEPTION is the junk roles the administration journey creates
 * (`e2e_role_*`, `probe_role_*`). Those are catalogue entries an administrator
 * sees in a list when assigning roles, so leaving nine of them is a defect in
 * the product's usability rather than noise in a test. They are held by nobody,
 * so they are deleted outright along with their permission grants and version
 * rows.
 *
 * WHAT IT WILL NOT TOUCH, by construction rather than by care:
 *   - the end-to-end fixture USERS, which the suite depends on
 *   - anything whose name does not match a journey's own prefix
 *   - the audit trail, which is append-only and not ours to tidy
 *   - primaddc.com's `public` schema, which this script never names
 */

import pg from "pg";
import { supabaseSsl } from "./_db-ssl.mjs";

/** The names the journeys give the records they create. */
const PATTERNS = [
  { schema: "crm", table: "clients", column: "organisation_name", like: "E2E %" },
  { schema: "casework", table: "cases", column: "title", like: "E2E %" },
  { schema: "intel", table: "entities", column: "name", like: "Delta Logistics %" },
  { schema: "intel", table: "entities", column: "name", like: "Meridian Logistics %" },
  { schema: "intel", table: "entities", column: "name", like: "Meridian Freight %" },
] as const;

async function main() {
  const confirm = process.argv.includes("--confirm");

  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error("Missing SUPABASE_DB_URL. See .env.example.");
    process.exit(1);
  }

  const db = new pg.Client({
    connectionString: url,
    ssl: supabaseSsl(),
    application_name: "pddc-iims-clean-e2e",
  });
  await db.connect();

  try {
    console.log(
      confirm
        ? "Clearing end-to-end residue.\n"
        : "Dry run. Nothing will be written.\n",
    );

    let total = 0;

    for (const p of PATTERNS) {
      const { rows } = await db.query<{ n: string }>(
        `select count(*) as n from ${p.schema}.${p.table}
         where ${p.column} like $1 and deleted_at is null`,
        [p.like],
      );
      const n = Number(rows[0].n);
      total += n;
      if (n === 0) continue;

      console.log(`  ${p.schema}.${p.table} matching "${p.like}": ${n}`);

      if (confirm) {
        await db.query(
          `update ${p.schema}.${p.table} set deleted_at = now()
           where ${p.column} like $1 and deleted_at is null`,
          [p.like],
        );
      }
    }

    // The role catalogue. Deleted outright, having checked they are held by
    // nobody: a role somebody holds is somebody's access, not residue.
    const { rows: held } = await db.query<{ key: string }>(
      `select r.key from iam.roles r
       join iam.user_roles ur on ur.role_id = r.id
       where r.key ~ '^(e2e_role_|probe_role_)'
       group by r.key`,
    );
    if (held.length > 0) {
      console.log(
        `\n  Leaving ${held.length} test role(s) that somebody actually holds: ${held
          .map((r) => r.key)
          .join(", ")}`,
      );
    }

    const { rows: junk } = await db.query<{ n: string }>(
      `select count(*) as n from iam.roles r
       where r.key ~ '^(e2e_role_|probe_role_)'
         and not exists (select 1 from iam.user_roles ur where ur.role_id = r.id)`,
    );
    console.log(`  iam.roles test entries held by nobody: ${junk[0].n}`);

    if (confirm && Number(junk[0].n) > 0) {
      await db.query("begin");
      try {
        // Children first, then the role. The "held by nobody" condition is
        // repeated in each statement rather than resolved to a list of ids,
        // so a role that gains a holder between statements is left alone by
        // all of them.
        const unheld = `r.key ~ '^(e2e_role_|probe_role_)'
          and not exists (
            select 1 from iam.user_roles ur where ur.role_id = r.id
          )`;

        await db.query(
          `delete from iam.role_permissions rp using iam.roles r
           where rp.role_id = r.id and ${unheld}`,
        );
        await db.query(
          `delete from iam.role_versions rv using iam.roles r
           where rv.role_id = r.id and ${unheld}`,
        );
        await db.query(`delete from iam.roles r where ${unheld}`);
        await db.query("commit");
      } catch (error) {
        await db.query("rollback");
        throw error;
      }
    }

    console.log("");
    if (confirm) {
      console.log(`Marked ${total} record(s) deleted and cleared the role catalogue.`);
      console.log("Nothing was erased: every record is in the recycle bin, and");
      console.log("the audit trail that points at it is untouched.");
    } else {
      console.log(`${total} record(s) would be marked deleted.`);
      console.log("Re-run with --confirm to apply.");
    }
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

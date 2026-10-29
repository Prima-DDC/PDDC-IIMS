import { globSync, readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { SUPABASE_ROOT_CA } from "@/lib/db/supabase-ca";

/**
 * Every permission the code gates on must exist in the catalogue.
 *
 * This test exists because of a bug that nothing else could have caught. The
 * management reports screen and its CSV route both check `reports:export`, a
 * permission that was never seeded. `iam.has_permission` answered false for
 * every role, so the only person who could open PRD 10.4 was an
 * administrator, by virtue of the administrator wildcard. Nothing errored and
 * nothing logged: the feature was simply invisible to the Operations Manager,
 * the Supervisor and the CEO, which is exactly who PRD 11 says reads
 * firm-wide figures.
 *
 * A permission check against a permission that does not exist fails closed,
 * which is the correct default and the reason this was a dead feature rather
 * than a hole. It also means a gate can be written for a permission nobody
 * will ever hold and nothing will say so, which is what this asserts against.
 *
 * Administrator-only actions are deliberately exempt, and they are a real
 * category rather than a loophole. PRD 16's matrix uses X (soft delete) in
 * exactly one cell, "Users and roles" for CEO/Admin, and its hard rules say
 * only the Administrator may remove evidence. Those gates are satisfied by
 * the administrator wildcard ('*','*') and are correct with no catalogue row
 * of their own, so each one is listed here with the reason it is exempt. A
 * new gate has to be either in the catalogue or on this list, and adding it
 * to this list is a decision somebody has to write down.
 *
 * Requires IIMS_APP_DB_URL. Run with:
 *   npx vitest run --mode development tests/integration
 */

const url = process.env.IIMS_APP_DB_URL;

const sql = postgres(url ?? "", {
  prepare: false,
  max: 1,
  ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
  connection: { application_name: "pddc-iims-test" },
  onnotice: () => {},
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/**
 * Gates that are correct with no catalogue row, because PRD 16 gives the
 * action to the Administrator alone and the wildcard already covers it.
 */
const ADMINISTRATOR_ONLY = new Map<string, string>([
  [
    "users:delete",
    "PRD 16: X on 'Users and roles' is CEO/Admin only, and it is the only X in the matrix.",
  ],
  ["users:assign", "Assigning roles is part of the same CEO/Admin cell."],
  [
    "settings:configure",
    "PRD 3.3: the Permission Builder and system settings are the administrator's.",
  ],
  [
    "evidence:delete",
    "PRD 16 hard rule: 'only the Administrator can remove it, as a recoverable soft-delete with reason and second-administrator approval'.",
  ],
  [
    "documents:delete",
    "PRD 16 gives no role X on Documents; removal follows the evidence rule.",
  ],
  ["entities:delete", "PRD 16 gives no role X on Subjects/entities."],
  ["findings:delete", "PRD 16 gives no role X on Findings."],
  ["information:delete", "PRD 16 gives no role X on Sources and information."],
  ["sources:delete", "PRD 16 gives no role X on Sources and information."],
  ["reports:delete", "PRD 16 gives no role X on Reports."],
  ["tasks:delete", "PRD 16 gives no role X on Tasks and activities."],
  [
    "reports:share",
    "S is in PRD 16's legend but in no cell, so sharing stays with the administrator until PDDC says otherwise.",
  ],
]);

/** Every (resource, action) the application gates on. */
function gatesInSource(): Set<string> {
  const files = globSync("src/**/*.{ts,tsx}");
  const found = new Set<string>();

  for (const file of files) {
    const text = readFileSync(file, "utf8");

    // can(actor, "cases", "view") and its throwing siblings.
    for (const m of text.matchAll(
      /(?:can|canAll|requirePermission|assertCan)\(\s*actor\s*,\s*"([a-z_]+)"\s*,\s*"([a-z_]+)"/g,
    )) {
      found.add(`${m[1]}:${m[2]}`);
    }

    // The array form used where several checks are batched into one query.
    for (const m of text.matchAll(
      /\{\s*resource:\s*"([a-z_]+)"\s*,\s*action:\s*"([a-z_]+)"\s*\}/g,
    )) {
      found.add(`${m[1]}:${m[2]}`);
    }
  }

  return found;
}

describe.skipIf(!url)("the permission catalogue covers every gate", () => {
  it("finds the gates at all, so a silent regex failure cannot pass this test", () => {
    const gates = gatesInSource();
    // A canary: if the patterns above stop matching, the set empties and
    // every assertion below passes for the wrong reason.
    expect(gates.size).toBeGreaterThan(50);
    expect(gates).toContain("cases:view");
    expect(gates).toContain("reports:export");
  });

  it("defines every permission the application checks", async () => {
    const rows = await sql<{ resource: string; action: string }[]>`
      select distinct resource, action from iam.permissions
    `;
    const defined = new Set(rows.map((r) => `${r.resource}:${r.action}`));

    const undefinedGates = [...gatesInSource()]
      .filter((gate) => !defined.has(gate))
      .filter((gate) => !ADMINISTRATOR_ONLY.has(gate))
      .sort();

    // Named in the message, because the failure is useless without them.
    expect(
      undefinedGates,
      `These gates name a permission that is not in the catalogue, so they are false for every role except an administrator. Either seed the permission in a migration, or add it to ADMINISTRATOR_ONLY with the PRD reference that makes it administrator-only:\n  ${undefinedGates.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the administrator-only list honest", async () => {
    // A permission that has since been seeded should leave the exemption
    // list, or the list becomes a place where real gaps hide.
    const rows = await sql<{ resource: string; action: string }[]>`
      select distinct resource, action from iam.permissions
    `;
    const defined = new Set(rows.map((r) => `${r.resource}:${r.action}`));

    const stale = [...ADMINISTRATOR_ONLY.keys()]
      .filter((gate) => defined.has(gate))
      .sort();

    expect(
      stale,
      `These are listed as administrator-only but now exist in the catalogue, so remove them from ADMINISTRATOR_ONLY:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("gives the roles PRD 11 names the management reports (PRD 10.4)", async () => {
    // The specific regression this file was written for.
    const rows = await sql<{ key: string }[]>`
      select r.key
      from iam.roles r
      join iam.role_permissions rp on rp.role_id = r.id
      join iam.permissions p on p.id = rp.permission_id
      where p.resource = 'reports' and p.action = 'export'
      group by r.key
      order by r.key
    `;
    const holders = rows.map((r) => r.key);

    expect(holders).toContain("operations_manager");
    expect(holders).toContain("supervisor");
    expect(holders).toContain("ceo");
    // And not the author of the reports: their own are theirs to write, the
    // firm's figures are not theirs to take out in a file.
    expect(holders).not.toContain("investigator");
  });
});

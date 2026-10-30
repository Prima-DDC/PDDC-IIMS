import { afterAll, describe, expect, it } from "vitest";
import { testSql } from "../helpers/sql";

/**
 * PRD 16's permission matrix, transcribed and checked against the seed.
 *
 * PRD 20.2 asks for "automated tests [that] prove each role/classification
 * combination in Section 16". This is that test, and the direction it runs in
 * is the point: the EXPECTATION below is the PRD, typed out cell by cell, and
 * the database is what gets compared against it. Written the other way round,
 * reading the grants and asserting they are what they are, it would pass for
 * ever and prove nothing.
 *
 * It is a sibling of `permission-catalogue.test.ts`, which checks a different
 * thing: that every permission the code gates on exists in the catalogue.
 * That one catches a feature nobody can reach. This one catches a role that
 * can reach a feature PRD 16 did not give it, which is the direction that
 * matters for an access-control review.
 *
 * WHY IT CONNECTS AS `postgres`. It reads `iam.role_permissions`, which is
 * configuration rather than case data, and it makes no claim about what any
 * policy would do at runtime: it compares two lists. The runtime claims are
 * in `app-role-containment.test.ts`, which connects as `iims_app` because
 * there they matter.
 *
 * THE MATRIX DOES NOT FIT ITS OWN LEGEND, in a handful of cells, and those
 * are listed in EXEMPT with the sentence of the PRD that explains each. A
 * test that quietly normalised them away would be hiding the interesting
 * part.
 */

const hasDb = Boolean(process.env.SUPABASE_DB_URL);
const suite = describe.skipIf(!hasDb);

const sql = hasDb ? testSql() : null;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** PRD 16's legend. */
const LETTERS: Record<string, string> = {
  V: "view",
  C: "create",
  E: "edit",
  U: "upload",
  D: "download",
  A: "approve",
  S: "share",
  X: "delete",
};

/** PRD 16's columns, as the role keys the seed uses. */
const ROLES = {
  ceo: "CEO/Admin",
  operations_manager: "Ops Manager",
  supervisor: "Supervisor",
  investigator: "Investigator",
  analyst: "Analyst",
  forensics: "Forensics",
  qa_reviewer: "QA",
  finance: "Finance",
} as const;

type RoleKey = keyof typeof ROLES;

/**
 * PRD 16's rows, as the catalogue's resource keys.
 *
 * Several rows name two resources, because the PRD groups them and the
 * catalogue does not. "Clients and engagements" is one row and two resources,
 * and the matrix's letters apply to both.
 */
const ROWS: ReadonlyArray<{
  label: string;
  resources: readonly string[];
  cells: Partial<Record<RoleKey, string>>;
}> = [
  {
    label: "Users and roles",
    resources: ["users"],
    cells: { ceo: "VCEX", operations_manager: "V" },
  },
  {
    label: "Clients and engagements",
    resources: ["clients", "engagements"],
    cells: {
      ceo: "VCE",
      operations_manager: "VCEA",
      supervisor: "V",
      investigator: "V",
      finance: "V",
    },
  },
  {
    label: "Conflict decisions",
    resources: ["conflicts"],
    cells: { ceo: "V", operations_manager: "VA", supervisor: "V" },
  },
  {
    label: "Cases",
    resources: ["cases"],
    cells: {
      ceo: "V",
      operations_manager: "VCEA",
      supervisor: "VEA",
      investigator: "VE",
      analyst: "V",
      forensics: "V",
      qa_reviewer: "V",
      finance: "V",
    },
  },
  {
    label: "Investigation plans",
    resources: ["plans"],
    cells: {
      ceo: "V",
      operations_manager: "V",
      supervisor: "VA",
      investigator: "VCE",
      analyst: "V",
      qa_reviewer: "V",
    },
  },
  {
    label: "Tasks and activities",
    resources: ["tasks"],
    cells: {
      ceo: "V",
      operations_manager: "VCE",
      supervisor: "VCE",
      investigator: "VCE",
      analyst: "VCE",
      forensics: "VCE",
      qa_reviewer: "V",
    },
  },
  {
    label: "Subjects/entities",
    resources: ["entities"],
    cells: {
      ceo: "V",
      operations_manager: "V",
      supervisor: "VCE",
      investigator: "VCE",
      analyst: "VCE",
      forensics: "V",
      qa_reviewer: "V",
    },
  },
  {
    label: "Sources and information",
    resources: ["sources", "information"],
    cells: {
      ceo: "V",
      operations_manager: "V",
      supervisor: "VCE",
      investigator: "VCE",
      analyst: "VCE",
      forensics: "V",
      qa_reviewer: "V",
    },
  },
  {
    label: "Evidence",
    resources: ["evidence"],
    cells: {
      ceo: "V",
      operations_manager: "V",
      supervisor: "VUD",
      investigator: "VCUD",
      analyst: "VD",
      forensics: "VCEUD",
      qa_reviewer: "VD",
    },
  },
  {
    label: "Custody events",
    resources: ["custody"],
    cells: {
      ceo: "V",
      operations_manager: "V",
      supervisor: "VC",
      investigator: "VC",
      analyst: "VC",
      forensics: "VC",
      qa_reviewer: "V",
    },
  },
  {
    label: "Documents",
    resources: ["documents"],
    cells: {
      ceo: "V",
      operations_manager: "V",
      supervisor: "VCEUD",
      investigator: "VCEUD",
      analyst: "VCUD",
      forensics: "VCUD",
      qa_reviewer: "VD",
    },
  },
  {
    label: "Findings",
    resources: ["findings"],
    cells: {
      ceo: "V",
      operations_manager: "V",
      supervisor: "VA",
      investigator: "VCE",
      analyst: "VCE",
      forensics: "VCE",
      qa_reviewer: "V",
    },
  },
  {
    label: "Reports",
    resources: ["reports"],
    cells: {
      ceo: "VA",
      operations_manager: "V",
      supervisor: "VA",
      investigator: "VCE",
      analyst: "VCE",
      forensics: "VCE",
      qa_reviewer: "VA",
    },
  },
  {
    label: "Financials and time",
    resources: ["financials"],
    cells: {
      ceo: "V",
      operations_manager: "VCE",
      supervisor: "V",
      finance: "VCE",
    },
  },
  {
    label: "Audit logs",
    resources: ["audit"],
    cells: { ceo: "V", supervisor: "V" },
  },
];

/**
 * The cells PRD 16 writes in prose rather than in letters, and what the seed
 * does about each.
 *
 * Every entry names the sentence of the PRD it comes from. A deviation
 * without a reason belongs in the failure list, not here.
 */
const EXEMPT: ReadonlyArray<{
  role: RoleKey;
  resource: string;
  action: string;
  why: string;
}> = [
  {
    role: "operations_manager",
    resource: "clients",
    action: "approve",
    why:
      'PRD 16 groups "Clients and engagements" into one row and gives the ' +
      "Operations Manager V C E A, but only one of the two is ever approved: " +
      "an engagement goes through PRD 4.1's approval before a case can be " +
      "opened against it, and a client is onboarded rather than approved. " +
      "The catalogue has no clients:approve to grant, which is the same " +
      "judgement made when the catalogue was written.",
  },
  {
    role: "investigator",
    resource: "financials",
    action: "view",
    why:
      'PRD 16 writes "Own time" rather than a letter. The seed grants ' +
      "time:view and time:create at own scope and withholds financials, " +
      "which is the narrower reading: an investigator records their hours " +
      "and does not see the case's commercials.",
  },
  {
    role: "analyst",
    resource: "financials",
    action: "view",
    why: 'PRD 16 writes "Own time". Same reading as the investigator.',
  },
  {
    role: "forensics",
    resource: "financials",
    action: "view",
    why: 'PRD 16 writes "Own time". Same reading as the investigator.',
  },
  {
    role: "finance",
    resource: "documents",
    action: "view",
    why:
      'PRD 16 writes "Billing docs only" for Finance on Documents. The ' +
      "resource has no sub-scope for that, and PRD 16's hard rules say " +
      '"Finance sees no investigative content", so the seed withholds ' +
      "documents entirely rather than granting a view it cannot narrow. " +
      "Narrower than the matrix, deliberately.",
  },
];

interface Grant {
  role: string;
  resource: string;
  action: string;
}

suite("PRD 16's permission matrix", () => {
  let granted: Grant[] = [];

  async function load(): Promise<Grant[]> {
    if (granted.length > 0) return granted;
    granted = await sql!<Grant[]>`
      select r.key as role, p.resource, p.action
      from iam.role_permissions rp
      join iam.roles r on r.id = rp.role_id
      join iam.permissions p on p.id = rp.permission_id
      where r.key = any(${Object.keys(ROLES)}::text[])
    `;
    return granted;
  }

  function exempt(role: RoleKey, resource: string, action: string): boolean {
    return EXEMPT.some(
      (entry) =>
        entry.role === role &&
        entry.resource === resource &&
        entry.action === action,
    );
  }

  /**
   * Whether the "CEO/Admin" column is satisfied.
   *
   * It is ONE column covering TWO roles, and the seed splits them
   * deliberately. The `ceo` role is the executive: it views everything and
   * approves reports. The `administrator` role is the platform
   * administrator, and user administration, client creation and conflict
   * screening sit there rather than with the chief executive, which is a
   * better division than the matrix's single column can express. PRD 3.5 and
   * 20.2 require the Administrator to reach every resource including ones
   * added later, which is why that role holds a wildcard rather than a list.
   *
   * So a cell in that column is met if the `ceo` role holds it OR the
   * administrator's wildcard covers it. Asserting it against `ceo` alone
   * would be asserting a reading of the PRD the platform deliberately does
   * not take.
   */
  function ceoColumnSatisfied(held: Set<string>, key: string): boolean {
    return held.has(key) || held.has("administrator|*|*");
  }

  it("grants every cell PRD 16 fills in", async () => {
    const rows = await load();
    const held = new Set(rows.map((g) => `${g.role}|${g.resource}|${g.action}`));

    const [wildcard] = await sql!<{ n: string }[]>`
      select count(*)::text as n
      from iam.role_permissions rp
      join iam.roles r on r.id = rp.role_id
      join iam.permissions p on p.id = rp.permission_id
      where r.key = 'administrator' and p.resource = '*' and p.action = '*'
    `;
    if (Number(wildcard.n) > 0) held.add("administrator|*|*");

    const missing: string[] = [];

    for (const row of ROWS) {
      for (const [role, letters] of Object.entries(row.cells) as Array<
        [RoleKey, string]
      >) {
        for (const letter of letters) {
          const action = LETTERS[letter];
          if (!action) throw new Error(`PRD 16 has no legend for "${letter}"`);

          for (const resource of row.resources) {
            if (exempt(role, resource, action)) continue;

            const key = `${role}|${resource}|${action}`;
            const satisfied =
              role === "ceo" ? ceoColumnSatisfied(held, key) : held.has(key);
            if (satisfied) continue;

            missing.push(
              `${ROLES[role]} has no ${resource}:${action}, which PRD 16 gives it on "${row.label}"`,
            );
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("grants nothing PRD 16 leaves blank", async () => {
    const rows = await load();

    // Only the resources the matrix actually covers. A resource PRD 16 does
    // not mention, such as `profile` or `notifications`, is not an excess
    // grant: it is outside the matrix, and PRD 16 says the matrix is the
    // default starting set rather than the whole catalogue.
    const covered = new Map<string, string>();
    for (const row of ROWS) {
      for (const resource of row.resources) covered.set(resource, row.label);
    }

    const expected = new Set<string>();
    for (const row of ROWS) {
      for (const [role, letters] of Object.entries(row.cells) as Array<
        [RoleKey, string]
      >) {
        for (const letter of letters) {
          for (const resource of row.resources) {
            expected.add(`${role}|${resource}|${LETTERS[letter]}`);
          }
        }
      }
    }

    const excess: string[] = [];

    for (const grant of rows) {
      const label = covered.get(grant.resource);
      if (!label) continue;

      const key = `${grant.role}|${grant.resource}|${grant.action}`;
      if (expected.has(key)) continue;
      if (exempt(grant.role as RoleKey, grant.resource, grant.action)) continue;

      // PRD 16's legend has eight letters, and the catalogue has actions it
      // does not cover. A cell cannot express them, so the matrix cannot be
      // their authority and this test is not the place to assert them:
      //
      //   export    PRD 10.4, "all exportable to CSV/PDF with permission
      //             checks applied". Migration 0044 seeded it.
      //   assign    PRD 5.4. Assignment is what grants access to a case, so
      //             it is its own permission rather than part of `edit`.
      //   close     PRD 5.9's closure gate, which is a two-person act.
      //   archive   PRD 5.10.
      //   merge     PRD 8.4. Migration 0046 ties it to `edit`: a role holding
      //             merge must hold edit, which the merge screen needs.
      //   configure PRD 3.3's Permission Builder and the settings screens.
      //
      // Each is asserted where it belongs instead: `export` and the gates
      // generally in permission-catalogue.test.ts, `close` and `archive` in
      // the reporting suite, `assign` in the case journey.
      if (
        ["export", "assign", "close", "archive", "merge", "configure"].includes(
          grant.action,
        )
      ) {
        continue;
      }

      excess.push(
        `${ROLES[grant.role as RoleKey]} holds ${grant.resource}:${grant.action}, which PRD 16 does not give it on "${label}"`,
      );
    }

    expect(excess).toEqual([]);
  });

  it("caps every clearance ceiling at the role's own clearance or below", async () => {
    // PRD 16's preamble: "All permissions apply only to cases the user is
    // authorised for, within their clearance." A permission whose ceiling is
    // higher than anybody holding it can see is not dangerous, but it is
    // misleading: the Effective Permissions viewer would show a reach the
    // person does not have.
    const rows = await sql!<
      { role: string; resource: string; action: string; ceiling: string }[]
    >`
      select r.key as role, p.resource, p.action, p.classification_ceiling as ceiling
      from iam.role_permissions rp
      join iam.roles r on r.id = rp.role_id
      join iam.permissions p on p.id = rp.permission_id
      where p.classification_ceiling = 'STRICTLY_RESTRICTED'
        and r.key <> 'administrator'
        -- The journeys create and discard roles of their own, and a fixture
        -- left behind by a failed run is not a finding about the seed.
        and r.key not like 'e2e_role_%'
    `;

    // PRD 16's hard rules: "STRICTLY RESTRICTED items require named-user
    // grants for every role except Administrator". So no ordinary role may
    // hold a permission reaching it by role alone.
    expect(
      rows.map((r) => `${r.role} ${r.resource}:${r.action}`),
    ).toEqual([]);
  });

  it("gives the administrator a wildcard rather than a list", async () => {
    // PRD 3.5 and 20.2 both require the Administrator to reach every
    // resource including ones added later. Enumerating them would mean a new
    // resource silently excluded, so the grant is ('*','*').
    const [row] = await sql!<{ n: string }[]>`
      select count(*)::text as n
      from iam.role_permissions rp
      join iam.roles r on r.id = rp.role_id
      join iam.permissions p on p.id = rp.permission_id
      where r.key = 'administrator' and p.resource = '*' and p.action = '*'
    `;
    expect(Number(row.n)).toBe(1);
  });

  it("gives nobody but the administrator a wildcard", async () => {
    const rows = await sql!<{ role: string }[]>`
      select r.key as role
      from iam.role_permissions rp
      join iam.roles r on r.id = rp.role_id
      join iam.permissions p on p.id = rp.permission_id
      where (p.resource = '*' or p.action = '*') and r.key <> 'administrator'
    `;
    expect(rows.map((r) => r.role)).toEqual([]);
  });

  it("lets nobody but the administrator delete, which is PRD 16's X column", async () => {
    // PRD 16 uses X in exactly one cell of the whole matrix, "Users and
    // roles" for CEO/Admin. Everything else is retired, cancelled or soft
    // deleted through its own workflow, and migration 0045 narrowed three
    // grants that did not match this.
    const rows = await sql!<{ role: string; resource: string }[]>`
      select r.key as role, p.resource
      from iam.role_permissions rp
      join iam.roles r on r.id = rp.role_id
      join iam.permissions p on p.id = rp.permission_id
      where p.action = 'delete' and r.key <> 'administrator'
      order by r.key, p.resource
    `;

    // PRD 16's X sits in the CEO/Admin column, and the administrator's
    // wildcard is what satisfies it: a chief executive needs no standing
    // grant to delete a colleague's account. So the expected answer is
    // nothing at all, which is tighter than the matrix and is the reading
    // PRD 14 takes: "the Administrator holds delete on all records".
    expect(
      rows.map((r) => `${r.role} may delete ${r.resource}`),
    ).toEqual([]);
  });
});

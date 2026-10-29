import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { adminClient, asActor, makeUser } from "../helpers/db";

/**
 * Conflict-of-interest screening (PRD 8.3).
 *
 * The PRD names two pairs by hand and requires both to be flagged as
 * potential matches and never auto-merged:
 *
 *   John Mensah            / John K. Mensah
 *   ABC Holdings Ltd       / ABC Holdings Ghana Limited
 *
 * They are the acceptance criterion in PRD 20.2, so they are tested by name
 * rather than by proxy. Everything runs in a rolled-back transaction.
 */

const hasDb = Boolean(process.env.SUPABASE_DB_URL);
const suite = describe.skipIf(!hasDb);

let db: pg.Client;

beforeAll(async () => {
  if (!hasDb) return;
  db = adminClient();
  await db.connect();
});

afterAll(async () => {
  if (!hasDb) return;
  await db.end();
});

beforeEach(async () => {
  if (!hasDb) return;
  await db.query("begin");
});

afterEach(async () => {
  if (!hasDb) return;
  await db.query("rollback");
});

/**
 * Asserts a statement is rejected, and leaves the transaction usable.
 *
 * Postgres aborts the whole transaction on a failed statement, so a test that
 * asserts two rejections in a row sees "current transaction is aborted" for
 * the second one instead of the message it was checking. The savepoint
 * confines the damage to the statement under test.
 */
async function rejected(sql: string, params: unknown[]): Promise<string> {
  await db.query("savepoint attempt");
  try {
    await db.query(sql, params);
  } catch (error) {
    await db.query("rollback to savepoint attempt");
    return (error as Error).message;
  }
  await db.query("release savepoint attempt");
  throw new Error("the statement was accepted, but it should have been rejected");
}

/** Creates a client row and returns its uuid. */
async function seedClient(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into crm.clients (organisation_name, active_status)
     values ($1, 'active') returning id`,
    [name],
  );
  return rows[0].id;
}

/** Creates an entity in the subject register and returns its uuid. */
async function seedEntity(
  name: string,
  aliases: string[] = [],
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into intel.entities (entity_type, name, classification)
     values ('company', $1, 'CONFIDENTIAL') returning id`,
    [name],
  );
  for (const alias of aliases) {
    await db.query(
      `insert into intel.entity_aliases (entity_id, alias, alias_type)
       values ($1, $2, 'trading_name')`,
      [rows[0].id, alias],
    );
  }
  return rows[0].id;
}

async function normalise(name: string): Promise<string | null> {
  const { rows } = await db.query<{ n: string | null }>(
    "select crm.normalise_name($1) as n",
    [name],
  );
  return rows[0].n;
}

interface Match {
  searched_term: string;
  matched_table: string;
  matched_label: string;
  similarity: string;
  phonetic_match: boolean;
  match_reason: string;
}

/** Runs a screening search as an actor who is permitted to. */
async function screen(terms: string[], threshold = 0.3): Promise<Match[]> {
  const manager = await makeUser(db, { roles: ["operations_manager"] });
  return asActor(db, manager, async () => {
    const { rows } = await db.query<Match>(
      "select * from crm.find_conflicts($1::text[], $2, 50)",
      [terms, threshold],
    );
    return rows;
  });
}

suite("name normalisation", () => {
  it("converges company suffixes, so Ltd and Limited agree", async () => {
    expect(await normalise("ABC Holdings Ltd")).toBe(
      await normalise("ABC Holdings Limited"),
    );
  });

  it("converges the PRD's company example once the country word is removed", async () => {
    // "ABC Holdings Ghana Limited" keeps "ghana", which "ABC Holdings Ltd"
    // lacks, so the normalised forms differ by one token. That is what the
    // similarity score is for; they must not be claimed identical.
    const a = await normalise("ABC Holdings Ltd");
    const b = await normalise("ABC Holdings Ghana Limited");
    expect(a).toBe("abc");
    expect(b).toBe("abc ghana");
  });

  it("strips punctuation, so initials with and without a stop agree", async () => {
    expect(await normalise("John K. Mensah")).toBe(await normalise("John K Mensah"));
  });

  it("folds accents", async () => {
    expect(await normalise("Societe Generale")).toBe(await normalise("Société Générale"));
  });

  it("collapses whitespace and case", async () => {
    expect(await normalise("  ABC   HOLDINGS  ")).toBe(await normalise("abc holdings"));
  });

  it("returns null for a name with nothing left after normalising", async () => {
    // "The Company Limited" is entirely filler and suffix.
    expect(await normalise("The Company Limited")).toBeNull();
    expect(await normalise("   ")).toBeNull();
  });
});

suite("the PRD's named examples", () => {
  it("flags John Mensah against John K. Mensah", async () => {
    await seedClient("John Mensah");

    const matches = await screen(["John K. Mensah"]);

    expect(matches).toHaveLength(1);
    expect(matches[0].matched_label).toBe("John Mensah");
    expect(Number(matches[0].similarity)).toBeGreaterThan(0.3);
  });

  it("flags it in the other direction too", async () => {
    await seedClient("John K. Mensah");

    const matches = await screen(["John Mensah"]);

    expect(matches).toHaveLength(1);
    expect(matches[0].matched_label).toBe("John K. Mensah");
  });

  it("flags ABC Holdings Ltd against ABC Holdings Ghana Limited", async () => {
    await seedClient("ABC Holdings Ltd");

    const matches = await screen(["ABC Holdings Ghana Limited"]);

    expect(matches).toHaveLength(1);
    expect(matches[0].matched_label).toBe("ABC Holdings Ltd");
    // "abc" appears within "abc ghana", which is the reason it is reported.
    expect(matches[0].match_reason).toMatch(/within/i);
  });

  it("reports a score and a reason, never a conclusion", async () => {
    await seedClient("ABC Holdings Ltd");
    const matches = await screen(["ABC Holdings Ghana Limited"]);

    // The contract of the function: it returns candidates with evidence. It
    // has no column that asserts sameness, because the system never concludes
    // two records are the same (PRD 8.3).
    expect(Object.keys(matches[0])).toEqual(
      expect.arrayContaining(["similarity", "match_reason", "phonetic_match"]),
    );
    expect(Object.keys(matches[0])).not.toContain("is_same");
  });
});

suite("matching behaviour", () => {
  it("finds an exact match with the highest score", async () => {
    await seedClient("Zenith Insurance Limited");
    const matches = await screen(["Zenith Insurance Ltd"]);

    expect(matches).toHaveLength(1);
    expect(Number(matches[0].similarity)).toBe(1);
    expect(matches[0].match_reason).toMatch(/identical once suffixes/i);
  });

  it("catches a name that only sounds the same", async () => {
    await seedClient("Smyth Associates");
    const matches = await screen(["Smith Associates"]);

    expect(matches.length).toBeGreaterThanOrEqual(1);
    const found = matches.find((m) => m.matched_label === "Smyth Associates");
    expect(found).toBeDefined();
    expect(found!.phonetic_match).toBe(true);
  });

  it("does not flag two genuinely unrelated names", async () => {
    await seedClient("Accra Logistics Limited");
    const matches = await screen(["Kigali Mining Corporation"]);
    expect(matches).toHaveLength(0);
  });

  it("screens several terms in one pass", async () => {
    await seedClient("ABC Holdings Ltd");
    await seedClient("John Mensah");

    const matches = await screen(["ABC Holdings Ghana Limited", "John K. Mensah"]);

    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.matched_label).sort()).toEqual([
      "ABC Holdings Ltd",
      "John Mensah",
    ]);
  });

  it("ignores a soft-deleted client", async () => {
    const id = await seedClient("Dormant Holdings Ltd");
    await db.query("update crm.clients set deleted_at = now() where id = $1", [id]);

    expect(await screen(["Dormant Holdings Limited"])).toHaveLength(0);
  });

  it("ignores a term that normalises to nothing", async () => {
    await seedClient("ABC Holdings Ltd");
    // Entirely filler, so there is nothing to search on and nothing is
    // returned, rather than everything matching an empty string.
    expect(await screen(["The Limited Company"])).toHaveLength(0);
  });

  it("refuses to screen without the conflicts permission", async () => {
    const investigator = await makeUser(db, { roles: ["investigator"] });

    await expect(
      asActor(db, investigator, () =>
        db.query("select * from crm.find_conflicts($1::text[])", [["anything"]]),
      ),
    ).rejects.toThrow(/not permitted to run a conflict check/i);
  });
});

suite("the decision is immutable (PRD 8.3)", () => {
  /**
   * Opens an undecided check.
   *
   * It names a client because conflict_check_has_a_subject requires a check to
   * belong to an enquiry, an engagement or a client: a check about nothing in
   * particular could never be acted on.
   */
  async function openCheck(manager: string): Promise<string> {
    const client = await seedClient("Subject Of The Check Ltd");
    const { rows } = await db.query<{ id: string }>(
      `insert into crm.conflict_checks (client_id, searched_terms, created_by)
       values ($2, array['ABC Holdings Ltd'], $1) returning id`,
      [manager, client],
    );
    return rows[0].id;
  }

  it("records a decision with its reason and decider", async () => {
    const manager = await makeUser(db, { roles: ["operations_manager"] });
    const id = await openCheck(manager);

    await db.query(
      `update crm.conflict_checks
       set decision = 'cleared', decision_reason = 'different entity, confirmed by registry',
           decided_by = $2, decided_at = now(), status = 'cleared'
       where id = $1`,
      [id, manager],
    );

    const { rows } = await db.query<{ decision: string; status: string }>(
      "select decision, status from crm.conflict_checks where id = $1",
      [id],
    );
    expect(rows[0].decision).toBe("cleared");
    expect(rows[0].status).toBe("cleared");
  });

  it("rejects a decision with no reason", async () => {
    const manager = await makeUser(db, { roles: ["operations_manager"] });
    const id = await openCheck(manager);

    expect(
      await rejected(
        `update crm.conflict_checks
         set decision = 'cleared', decided_by = $2, decided_at = now()
         where id = $1`,
        [id, manager],
      ),
    ).toMatch(/conflict_decision_complete/i);
  });

  it("refuses to change a decision once recorded", async () => {
    const manager = await makeUser(db, { roles: ["operations_manager"] });
    const id = await openCheck(manager);

    await db.query(
      `update crm.conflict_checks
       set decision = 'declined', decision_reason = 'acting for the opposing party',
           decided_by = $2, decided_at = now(), status = 'declined'
       where id = $1`,
      [id, manager],
    );

    // Even the table owner cannot quietly turn a declined conflict into a
    // clearance: that is the basis on which a clearance can be relied upon.
    expect(
      await rejected(
        `update crm.conflict_checks set decision = 'cleared' where id = $1`,
        [id],
      ),
    ).toMatch(/cannot be changed/i);
  });

  it("refuses to change the reason or the decider after the fact", async () => {
    const manager = await makeUser(db, { roles: ["operations_manager"] });
    const other = await makeUser(db, { roles: ["operations_manager"] });
    const id = await openCheck(manager);

    await db.query(
      `update crm.conflict_checks
       set decision = 'cleared', decision_reason = 'original reason',
           decided_by = $2, decided_at = now(), status = 'cleared'
       where id = $1`,
      [id, manager],
    );

    expect(
      await rejected(
        "update crm.conflict_checks set decision_reason = 'rewritten' where id = $1",
        [id],
      ),
    ).toMatch(/cannot be changed/i);

    expect(
      await rejected("update crm.conflict_checks set decided_by = $2 where id = $1", [
        id,
        other,
      ]),
    ).toMatch(/cannot be changed/i);
  });

  it("still allows an undecided check to be updated", async () => {
    const manager = await makeUser(db, { roles: ["operations_manager"] });
    const id = await openCheck(manager);

    await expect(
      db.query("update crm.conflict_checks set match_count = 3 where id = $1", [id]),
    ).resolves.toBeTruthy();
  });

  it("refuses to alter a recorded match", async () => {
    const manager = await makeUser(db, { roles: ["operations_manager"] });
    const id = await openCheck(manager);
    const client = await seedClient("ABC Holdings Ltd");

    await db.query(
      `insert into crm.conflict_matches
         (check_id, searched_term, matched_table, matched_id, matched_label,
          similarity, match_reason)
       values ($1, 'ABC Holdings Ghana Limited', 'crm.clients', $2,
               'ABC Holdings Ltd', 0.5, 'similar spelling')`,
      [id, client],
    );

    expect(
      await rejected(
        "update crm.conflict_matches set similarity = 0.1 where check_id = $1",
        [id],
      ),
    ).toMatch(/cannot be altered/i);
  });
});

suite("identifier allocation", () => {
  it("allocates sequential client identifiers in the CLI-YYYY-NNNNNN format", async () => {
    const first = await db.query<{ client_id: string }>(
      `insert into crm.clients (organisation_name) values ('Seq One') returning client_id`,
    );
    const second = await db.query<{ client_id: string }>(
      `insert into crm.clients (organisation_name) values ('Seq Two') returning client_id`,
    );

    const year = new Date().getFullYear();
    expect(first.rows[0].client_id).toMatch(
      new RegExp(`^CLI-${year}-\\d{6}$`),
    );

    const a = Number(first.rows[0].client_id.split("-")[2]);
    const b = Number(second.rows[0].client_id.split("-")[2]);
    expect(b).toBe(a + 1);
  });

  it("gives engagements and enquiries their own series", async () => {
    const { rows: client } = await db.query<{ id: string }>(
      `insert into crm.clients (organisation_name) values ('Series Test') returning id`,
    );
    const { rows: eng } = await db.query<{ engagement_id: string }>(
      `insert into crm.engagements (client_id, title) values ($1, 'Test') returning engagement_id`,
      [client[0].id],
    );
    const { rows: enq } = await db.query<{ enquiry_id: string }>(
      `insert into crm.enquiries (subject, prospect_name) values ('Test', 'Someone') returning enquiry_id`,
    );

    expect(eng[0].engagement_id).toMatch(/^ENG-\d{4}-\d{6}$/);
    expect(enq[0].enquiry_id).toMatch(/^ENQ-\d{4}-\d{6}$/);
  });
});

suite("the subject register (PRD 8.3)", () => {
  it("screens the subject register as well as the client list", async () => {
    // PRD 8.3 wants the subjects searched, not only the clients. Before
    // migration 0038 a company PDDC had investigated before was invisible to
    // a conflict check, which is the one thing a conflict check exists to
    // prevent.
    await seedEntity("Westbrook Minerals Holdings Limited");

    const matches = await screen(["Westbrook Minerals Ltd"]);
    const subjects = matches.filter((m) => m.matched_table === "intel.entities");

    expect(subjects.map((m) => m.matched_label)).toContain(
      "Westbrook Minerals Holdings Limited",
    );
  });

  it("matches on an alias, and names the record rather than the spelling", async () => {
    // The conflict a screening check most needs to catch: a company recorded
    // under a trading name that is not its registered one.
    await seedEntity("Harbour Freight Systems Limited", [
      "Harbour Freight Ghana",
    ]);

    const matches = await screen(["Harbour Freight Ghana Ltd"]);
    const subjects = matches.filter((m) => m.matched_table === "intel.entities");

    expect(subjects).not.toHaveLength(0);
    // The label is the entity, so the reviewer sees the record they have to
    // decide about and not just the string that matched.
    expect(subjects[0].matched_label).toBe("Harbour Freight Systems Limited");
  });

  it("reports one row per subject, however many of its names match", async () => {
    // Two names that both match the search and normalise differently. The
    // register refuses two aliases that normalise to the same string, which
    // is the unique constraint doing its job: "Exporters Co" and "Exporters"
    // are one alias once the corporate furniture is stripped.
    await seedEntity("Tamale Produce Exporters Limited", [
      "Tamale Produce Exports",
    ]);

    const matches = await screen(["Tamale Produce Exporters Ltd"]);
    const rows = matches.filter(
      (m) =>
        m.matched_table === "intel.entities" &&
        m.matched_label === "Tamale Produce Exporters Limited",
    );

    // Both its names matched one record. A reviewer reading two rows would
    // read two conflicts.
    expect(rows).toHaveLength(1);
  });

  it("ignores a merged record, because its survivor is searched instead", async () => {
    const survivor = await seedEntity("Keta Shipping Limited");
    const loser = await seedEntity("Keta Shipping Ghana Limited");
    await db.query(
      `update intel.entities
       set resolution_status = 'merged', merged_into_id = $1
       where id = $2`,
      [survivor, loser],
    );

    const matches = await screen(["Keta Shipping Ltd"]);
    const labels = matches
      .filter((m) => m.matched_table === "intel.entities")
      .map((m) => m.matched_label);

    expect(labels).toContain("Keta Shipping Limited");
    // Showing both would show the reviewer the same conflict twice under two
    // names.
    expect(labels).not.toContain("Keta Shipping Ghana Limited");
  });

  it("ignores a removed subject", async () => {
    const id = await seedEntity("Removed Subject Holdings Limited");
    await db.query("update intel.entities set deleted_at = now() where id = $1", [
      id,
    ]);

    const matches = await screen(["Removed Subject Holdings Ltd"]);
    expect(
      matches.filter((m) => m.matched_label === "Removed Subject Holdings Limited"),
    ).toHaveLength(0);
  });

  it("still names the table every match came from", async () => {
    await seedClient("Dual Source Trading Limited");
    await seedEntity("Dual Source Trading Company Limited");

    const matches = await screen(["Dual Source Trading Ltd"]);
    const tables = new Set(matches.map((m) => m.matched_table));

    // Both halves searched, and each row says which it is, so a check run
    // before the register existed stays readable with the scope it had.
    expect(tables.has("crm.clients")).toBe(true);
    expect(tables.has("intel.entities")).toBe(true);
  });
});

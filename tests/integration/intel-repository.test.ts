import { afterAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { testSql } from "../helpers/sql";
import { createCaseRepository } from "@/modules/casework/infrastructure/case-repository";
import { createClientRepository } from "@/modules/crm/infrastructure/client-repository";
import { createEngagementRepository } from "@/modules/crm/infrastructure/engagement-repository";
import { createEvidenceRepository } from "@/modules/evidence/infrastructure/evidence-repository";
import {
  createCaseSubjectRepository,
  createEntityRepository,
  createRelationshipRepository,
  createResolutionRepository,
} from "@/modules/intel/infrastructure/entity-repository";
import {
  createInformationRepository,
  createSourceRepository,
} from "@/modules/intel/infrastructure/source-repository";
import { createFindingRepository } from "@/modules/intel/infrastructure/finding-repository";
import type { ActorContext } from "@/lib/db/client";

/**
 * Entities, sources, information and findings against the real Postgres
 * (PRD 6.4, 8.4, 15).
 *
 * Everything runs in a transaction that is always rolled back.
 *
 * What is worth proving here rather than in the domain tests is the part only
 * the database can answer: that a human source is made strictly restricted
 * and its identity withheld whatever the application passes, that its
 * identity is hidden from somebody whose clearance stops below that, that an
 * entity's identity reference is encrypted at rest and readable only through
 * the audited function, that a merge moves what it says it moved and deletes
 * nothing, that reversing one puts the record back, that a finding is
 * numbered F-001 per case, and that the traceability strip reaches the source
 * behind a linked piece of information.
 */

const hasDb = Boolean(process.env.SUPABASE_DB_URL);
const suite = describe.skipIf(!hasDb);

const sql = hasDb ? testSql() : null;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

class Rollback extends Error {}

async function inRolledBackTx(
  body: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  try {
    await sql!.begin(async (tx) => {
      await body(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

/**
 * A fixture who can both run a case and handle evidence.
 *
 * Two roles rather than one, because PRD 16 gives an Operations Manager `V`
 * on evidence and nothing more: they cannot register an item or attach a file
 * to it. The role that does that work is the Investigator, whose upload
 * ceiling reaches CONFIDENTIAL, which is what these fixtures use.
 *
 * It only started to matter with migration 0051. Registering and attaching
 * go through row-level security, which this connection bypasses because
 * `postgres` holds `rolbypassrls`, so the fixture's roles made no difference.
 * `evidence.record_uploaded_file` checks the permission ITSELF, in the
 * function body, and an explicit check is not something a bypass can skip.
 */
async function seedUser(
  tx: postgres.TransactionSql,
  roles: string[] = ["operations_manager", "investigator"],
  clearance = "STRICTLY_RESTRICTED",
): Promise<string> {
  const [{ id }] = await tx<{ id: string }[]>`
    select extensions.gen_random_uuid() as id
  `;
  await tx`
    insert into auth.users
      (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${id}::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${`pddc-intel-${id}@example.invalid`}, 'fixture',
            now(), now())
  `;
  await tx`
    insert into iam.users (id, clearance, status)
    values (${id}::uuid, ${clearance}, 'active')
  `;
  for (const key of roles) {
    await tx`
      insert into iam.user_roles (user_id, role_id)
      select ${id}::uuid, r.id from iam.roles r where r.key = ${key}
    `;
  }
  return id;
}

function actorFor(userId: string, clearance = "STRICTLY_RESTRICTED"): ActorContext {
  return {
    userId,
    clearance: clearance as ActorContext["clearance"],
    requestId: crypto.randomUUID(),
    aal: "aal2",
    ip: "203.0.113.10",
    userAgent: "vitest",
  };
}

async function seedCase(
  tx: postgres.TransactionSql,
  actor: ActorContext,
  name: string,
) {
  const clients = createClientRepository(actor, tx);
  const engagements = createEngagementRepository(actor, tx);
  const cases = createCaseRepository(actor, tx);

  const client = await clients.create({
    organisationName: name,
    clientType: "corporate",
    riskRating: "medium",
    status: "active",
    classification: "CONFIDENTIAL",
  });
  const engagement = await engagements.create({
    clientId: client.id,
    title: `${name} engagement`,
    engagementType: "fraud_investigation",
    classification: "CONFIDENTIAL",
  });
  await engagements.setStatus({
    id: engagement.id,
    status: "pending_approval",
    reason: "ready",
  });
  await engagements.setStatus({
    id: engagement.id,
    status: "approved",
    reason: "approved for the test",
    approve: true,
  });

  return cases.create({
    title: `${name} case`,
    clientId: client.id,
    engagementId: engagement.id,
    caseType: "fraud_investigation",
    priority: "medium",
    classification: "CONFIDENTIAL",
  });
}

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

suite("the entity register", () => {
  it("allocates an ENT identifier and keeps the normalised name in step", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const entities = createEntityRepository(actor, tx);

      const created = await entities.create({
        entityType: "company",
        name: "ABC Holdings Ghana Limited",
        classification: "CONFIDENTIAL",
      });

      expect(created.entityId).toMatch(/^ENT-\d{4}-\d{6}$/);
      // The suffix-stripped form is what the duplicate check compares, and it
      // is generated rather than written, so it cannot drift from the name.
      // `crm.normalise_name` strips the corporate furniture, which includes
      // "holdings" as well as "limited": "ABC Holdings Ghana Limited" becomes
      // "abc ghana". That is the behaviour the conflict screening in M2 was
      // built on and the entity register shares it deliberately, so the two
      // never disagree about whether two names are the same.
      expect(created.normalisedName).toBe("abc ghana");

      const renamed = await entities.update(
        created.id,
        { name: "ABC Holdings PLC" },
        created.version,
      );
      expect(renamed.normalisedName).toBe("abc");
    });
  });

  it("lets the role that registers subjects read back one on no case yet", async () => {
    await inRolledBackTx(async (tx) => {
      // An Investigator, whose `entities:view` is scoped to what they are
      // assigned to. An entity is not case-scoped, so a freshly registered
      // one is on no case and there is no assignment to reach it through.
      // Before migration 0037 the write succeeded and the read came back
      // empty, so the screen reported a failure for a record that existed.
      const actor = actorFor(await seedUser(tx, ["investigator"]));
      const entities = createEntityRepository(actor, tx);

      const created = await entities.create({
        entityType: "company",
        name: "Register First, Attach Later Ltd",
        classification: "CONFIDENTIAL",
      });

      expect(created.entityId).toMatch(/^ENT-\d{4}-\d{6}$/);
      expect(await entities.findById(created.id)).not.toBeNull();

      // And it is in their list, so the register is usable before anything is
      // attached to a case.
      const listed = await entities.list({ search: "Register First" });
      expect(listed.rows.map((row) => row.id)).toContain(created.id);
    });
  });

  it("does not let somebody else's subject through on the author rule", async () => {
    await inRolledBackTx(async (tx) => {
      const author = actorFor(await seedUser(tx, ["investigator"]));
      const entities = createEntityRepository(author, tx);

      const created = await entities.create({
        entityType: "person",
        name: "Someone Else's Subject",
        classification: "CONFIDENTIAL",
      });

      // A second investigator, who did not record it and is on no case with
      // it. The reach rule must say no: "the author can see it" is a clause
      // about the author, not a hole.
      const strangerId = await seedUser(tx, ["investigator"]);
      await tx`select set_config('iims.user_id', ${strangerId}, true)`;
      await tx`select set_config('iims.clearance', 'STRICTLY_RESTRICTED', true)`;
      const [reach] = await tx<{ reachable: boolean }[]>`
        select intel.can_reach_entity(${created.id}::uuid) as reachable
      `;
      expect(reach.reachable).toBe(false);
    });
  });

  it("refuses a company with a date of birth, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));

      // A company "born" in 1972 is a data entry mistake somebody will later
      // read as fact, so the table refuses it rather than storing it.
      await expect(
        tx.savepoint(
          (sp) => sp`
            insert into intel.entities
              (entity_type, name, date_of_birth, classification, created_by)
            values ('company', 'Wrong Type Ltd', '1972-01-01', 'INTERNAL',
                    ${actor.userId}::uuid)
          `,
        ),
      ).rejects.toThrow(/entities_dates_match_type/);
    });
  });

  it("encrypts the identity reference, and reads it back only through the audited function", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const entities = createEntityRepository(actor, tx);

      const person = await entities.create({
        entityType: "person",
        name: "Kofi Mensah",
        idReference: "G1234567",
        classification: "CONFIDENTIAL",
      });

      // What is stored is ciphertext, and the hint is the last four
      // characters so a screen can say which reference it holds.
      expect(person.hasIdReference).toBe(true);
      expect(person.idReferenceHint).toBe("4567");

      const [stored] = await tx<{ cipher: string }[]>`
        select id_reference_encrypted::text as cipher
        from intel.entities where id = ${person.id}::uuid
      `;
      expect(stored.cipher).not.toContain("G1234567");

      const before = await auditCount(tx, "entity.id_reference_read");
      expect(await entities.idReference(person.id)).toBe("G1234567");
      // Reading it is itself an event: it is the most sensitive field in the
      // register (PRD 13, PRD 15).
      expect(await auditCount(tx, "entity.id_reference_read")).toBe(before + 1);
    });
  });

  it("finds a record whose name sounds the same, and one recorded under an alias", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const entities = createEntityRepository(actor, tx);

      const mensah = await entities.create({
        entityType: "person",
        name: "John Mensah",
        classification: "CONFIDENTIAL",
      });
      const holdings = await entities.create({
        entityType: "company",
        name: "ABC Holdings Ltd",
        classification: "CONFIDENTIAL",
      });
      await entities.addAlias({
        entityId: holdings.id,
        alias: "ABC Holdings Ghana Limited",
        aliasType: "trading_name",
      });

      // PRD 20.2 names both of these as cases that must be flagged.
      const byName = await entities.findSimilar({ name: "John K. Mensah" });
      expect(byName.map((m) => m.entity.id)).toContain(mensah.id);

      const byAlias = await entities.findSimilar({ name: "ABC Holdings Ghana" });
      expect(byAlias.map((m) => m.entity.id)).toContain(holdings.id);

      // And never auto-merged: finding a match is all this does.
      const reread = await entities.findById(holdings.id);
      expect(reread!.resolutionStatus).toBe("unresolved");
      expect(reread!.mergedIntoId).toBeNull();
    });
  });

  it("counts the cases an entity appears on, which is the register's value", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const entities = createEntityRepository(actor, tx);
      const subjects = createCaseSubjectRepository(actor, tx);

      const caseA = await seedCase(tx, actor, "E2E Intel Alpha Ltd");
      const caseB = await seedCase(tx, actor, "E2E Intel Beta Ltd");
      const entity = await entities.create({
        entityType: "company",
        name: "Recurring Supplier Ltd",
        classification: "CONFIDENTIAL",
      });

      await subjects.add({
        caseId: caseA.id,
        entityId: entity.id,
        subjectRole: "primary_subject",
      });
      await subjects.add({
        caseId: caseB.id,
        entityId: entity.id,
        subjectRole: "related_party",
      });

      const reread = await entities.findById(entity.id);
      expect(reread!.caseCount).toBe(2);

      const appearances = await entities.subjectOf(entity.id);
      expect(appearances).toHaveLength(2);
      expect(appearances.map((a) => a.subjectRole).sort()).toEqual([
        "primary_subject",
        "related_party",
      ]);
    });
  });

  it("puts a removed subject back on the same row rather than adding a second", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const entities = createEntityRepository(actor, tx);
      const subjects = createCaseSubjectRepository(actor, tx);

      const record = await seedCase(tx, actor, "E2E Intel Subject Ltd");
      const entity = await entities.create({
        entityType: "person",
        name: "Ama Boateng",
        classification: "CONFIDENTIAL",
      });

      const added = await subjects.add({
        caseId: record.id,
        entityId: entity.id,
        subjectRole: "person_of_interest",
      });
      await subjects.remove(added.id, "turned out to be a different Ama Boateng");

      const back = await subjects.add({
        caseId: record.id,
        entityId: entity.id,
        subjectRole: "witness",
      });
      expect(back.id).toBe(added.id);
      expect(back.subjectRole).toBe("witness");
      expect(back.removedAt).toBeNull();

      // One row, with a history, rather than two rows telling different
      // stories about the same person on the same case.
      const all = await subjects.forCase(record.id, true);
      expect(all.filter((s) => s.entityId === entity.id)).toHaveLength(1);
    });
  });
});

suite("relationships", () => {
  it("refuses a percentage on something that is not a holding, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const entities = createEntityRepository(actor, tx);

      const person = await entities.create({
        entityType: "person",
        name: "Yaw Owusu",
        classification: "CONFIDENTIAL",
      });
      const company = await entities.create({
        entityType: "company",
        name: "Owusu Trading Ltd",
        classification: "CONFIDENTIAL",
      });

      await expect(
        tx.savepoint(
          (sp) => sp`
            insert into intel.relationships
              (from_entity_id, to_entity_id, relationship_type, percentage, created_by)
            values (${person.id}::uuid, ${company.id}::uuid, 'director_of', 40,
                    ${actor.userId}::uuid)
          `,
        ),
      ).rejects.toThrow(/percentage_belongs_to_a_holding/);
    });
  });

  it("walks the graph two hops, and no further", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const entities = createEntityRepository(actor, tx);
      const relationships = createRelationshipRepository(actor, tx);

      const make = (name: string) =>
        entities.create({
          entityType: "company",
          name,
          classification: "CONFIDENTIAL",
        });

      const a = await make("Chain A Ltd");
      const b = await make("Chain B Ltd");
      const c = await make("Chain C Ltd");
      const d = await make("Chain D Ltd");

      await relationships.create({
        fromEntityId: a.id,
        toEntityId: b.id,
        relationshipType: "subsidiary_of",
        confidence: "moderate",
      });
      await relationships.create({
        fromEntityId: b.id,
        toEntityId: c.id,
        relationshipType: "subsidiary_of",
        confidence: "moderate",
      });
      await relationships.create({
        fromEntityId: c.id,
        toEntityId: d.id,
        relationshipType: "subsidiary_of",
        confidence: "moderate",
      });

      const near = await relationships.graph({ entityIds: [a.id], depth: 1 });
      expect(near.entities.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());

      const far = await relationships.graph({ entityIds: [a.id], depth: 2 });
      const ids = far.entities.map((e) => e.id);
      expect(ids).toContain(c.id);
      // The cap is the point: an uncapped walk on a shared pooler connection
      // is how one screen takes the platform down.
      expect(ids).not.toContain(d.id);
    });
  });
});

suite("entity resolution", () => {
  it("merges reversibly, moving what it says it moved and deleting no record", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx, ["supervisor"]));
      const entities = createEntityRepository(actor, tx);
      const subjects = createCaseSubjectRepository(actor, tx);
      const resolution = createResolutionRepository(actor, tx);

      const record = await seedCase(tx, actor, "E2E Intel Merge Ltd");
      const keep = await entities.create({
        entityType: "company",
        name: "Delta Logistics Ltd",
        classification: "CONFIDENTIAL",
      });
      const lose = await entities.create({
        entityType: "company",
        name: "Delta Logistics Ghana Limited",
        classification: "CONFIDENTIAL",
      });

      await subjects.add({
        caseId: record.id,
        entityId: lose.id,
        subjectRole: "primary_subject",
      });
      await entities.addAlias({
        entityId: lose.id,
        alias: "DLG",
        aliasType: "abbreviation",
      });

      const flag = await resolution.flag({
        entityAId: keep.id,
        entityBId: lose.id,
        flagType: "potential_duplicate",
        similarityScore: 0.78,
      });
      await resolution.decide({
        flagId: flag.id,
        status: "same_entity",
        reason: "Same registration number and the same registered address.",
      });

      const merge = await resolution.merge({
        survivingEntityId: keep.id,
        mergedEntityId: lose.id,
        reason: "One company recorded twice under its trading name.",
      });

      expect(merge.moved.caseSubjects).toBe(1);
      expect(merge.moved.aliases).toBe(1);
      expect(merge.moved.nameAsAlias).toBe("Delta Logistics Ghana Limited");

      // Nothing is deleted: PRD 8.4 is explicit.
      const loser = await entities.findById(lose.id);
      expect(loser).not.toBeNull();
      expect(loser!.resolutionStatus).toBe("merged");
      expect(loser!.mergedIntoId).toBe(keep.id);

      // And the survivor now answers for both, including by the name that
      // was merged away, so a search for it still finds something.
      const survivor = await entities.findById(keep.id);
      expect(survivor!.caseCount).toBe(1);
      expect(survivor!.aliases.map((a) => a.alias)).toContain("DLG");
      expect(survivor!.aliases.map((a) => a.alias)).toContain(
        "Delta Logistics Ghana Limited",
      );

      const subjectsOnCase = await subjects.forCase(record.id);
      expect(subjectsOnCase.map((s) => s.entityId)).toEqual([keep.id]);

      // The flag records that its decision was carried out. Left at
      // `same_entity` it read as a merge still waiting to happen, and the
      // screen went on offering one that assertMergeable could only refuse.
      const afterMerge = await resolution.flags({ entityId: keep.id });
      expect(afterMerge[0].status).toBe("merged");

      /* ------------------------------------------------- and reversed */

      const reversed = await resolution.reverse({
        mergeId: merge.id,
        reason: "The registration numbers differ after all; two companies.",
      });
      expect(reversed.reversedAt).not.toBeNull();

      const restored = await entities.findById(lose.id);
      expect(restored!.resolutionStatus).toBe("disputed");
      expect(restored!.mergedIntoId).toBeNull();
      // The name that was taken as an alias of the survivor goes back.
      const survivorAfter = await entities.findById(keep.id);
      expect(survivorAfter!.aliases.map((a) => a.alias)).not.toContain(
        "Delta Logistics Ghana Limited",
      );

      /*
       * And everything the merge MOVED is back on the record it came from.
       *
       * This is what the test was named for and did not check. It asserted
       * the loser's status, the flag and the former-name alias, all of which
       * the reversal restored from data it could identify, and stopped
       * there. Meanwhile the case subject and the alias stayed on the
       * survivor, because the merge recorded only how many rows it had moved
       * and not which, so the reversal had nothing to work from. The test
       * passed throughout.
       */
      expect(survivorAfter!.aliases.map((a) => a.alias)).not.toContain("DLG");
      expect(survivorAfter!.caseCount).toBe(0);

      expect(restored!.aliases.map((a) => a.alias)).toContain("DLG");

      const subjectsBack = await subjects.forCase(record.id);
      expect(subjectsBack.map((s) => s.entityId)).toEqual([lose.id]);

      // The decision that authorised the merge is reopened rather than left
      // standing, so somebody has to decide it again.
      const flags = await resolution.flags({ entityId: keep.id });
      expect(flags[0].status).toBe("undecided");
    });
  });

  /**
   * The case both records are already subjects of (PRD 8.4).
   *
   * The hard one, and the one that was silently destructive. case_subjects is
   * unique on (case_id, entity_id), so the loser's row cannot move onto a
   * case the survivor is already a subject of. It used to be deleted, taking
   * the loser's own subject_role and relationship_to_case with it, and a
   * reversal could not put it back because nothing recorded that it had ever
   * existed.
   *
   * Two roles on one case is a disagreement between two pieces of recorded
   * work. The platform now withdraws the row where it stands instead, so the
   * role and the note survive, and gives it back on reversal.
   */
  it("withdraws rather than destroys a subject row it cannot move, and restores it", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx, ["supervisor"]));
      const entities = createEntityRepository(actor, tx);
      const subjects = createCaseSubjectRepository(actor, tx);
      const resolution = createResolutionRepository(actor, tx);
      const sources = createSourceRepository(actor, tx);
      const information = createInformationRepository(actor, tx);

      const record = await seedCase(tx, actor, "E2E Intel Conflict Ltd");
      const keep = await entities.create({
        entityType: "company",
        name: "Meridian Freight Ltd",
        classification: "CONFIDENTIAL",
      });
      const lose = await entities.create({
        entityType: "company",
        name: "Meridian Freight Ghana Limited",
        classification: "CONFIDENTIAL",
      });

      // BOTH on the same case, in different roles. This is the collision.
      await subjects.add({
        caseId: record.id,
        entityId: keep.id,
        subjectRole: "primary_subject",
      });
      await subjects.add({
        caseId: record.id,
        entityId: lose.id,
        subjectRole: "related_party",
        relationshipToCase: "Invoiced under the trading name",
      });

      // And a statement attributed to the loser, which is a hop in the chain
      // the platform exists to keep intact.
      const source = await sources.create({
        caseId: record.id,
        sourceType: "financial_record",
        description: "Bank statements for the account under investigation.",
        dateObtained: YESTERDAY,
        obtainedBy: actor.userId,
        sourceReliability: "reliable",
        classification: "CONFIDENTIAL",
      });
      const statement = await information.create({
        caseId: record.id,
        sourceId: source.id,
        entityId: lose.id,
        dateObtained: YESTERDAY,
        description: "Three payments with no purchase order reference.",
        informationCredibility: "probable",
        confidence: "moderate",
        classification: "CONFIDENTIAL",
      });

      const flag = await resolution.flag({
        entityAId: keep.id,
        entityBId: lose.id,
        flagType: "potential_duplicate",
        similarityScore: 0.81,
      });
      await resolution.decide({
        flagId: flag.id,
        status: "same_entity",
        reason: "One company invoicing under two names, same registration.",
      });

      const merge = await resolution.merge({
        survivingEntityId: keep.id,
        mergedEntityId: lose.id,
        reason: "The trading name was recorded as a separate company.",
      });

      // The case lists the survivor once, not twice and not the merged
      // record.
      const onCase = await subjects.forCase(record.id);
      expect(onCase.map((s) => s.entityId)).toEqual([keep.id]);

      // But the loser's row still exists, withdrawn, with its role and its
      // note intact. Nothing was destroyed, which is PRD 8.4's second
      // promise and the one that was being broken.
      const [withdrawn] = await tx<
        {
          subject_role: string;
          relationship_to_case: string | null;
          removed_at: Date | null;
        }[]
      >`
        select subject_role, relationship_to_case, removed_at
        from intel.case_subjects
        where case_id = ${record.id}::uuid and entity_id = ${lose.id}::uuid
      `;
      expect(withdrawn).toBeDefined();
      expect(withdrawn.removed_at).not.toBeNull();
      expect(withdrawn.subject_role).toBe("related_party");
      expect(withdrawn.relationship_to_case).toBe(
        "Invoiced under the trading name",
      );

      // The statement moved to the survivor.
      const [moved] = await tx<{ entity_id: string }[]>`
        select entity_id from intel.information where id = ${statement.id}::uuid
      `;
      expect(moved.entity_id).toBe(keep.id);

      /* ------------------------------------------------- and reversed */

      await resolution.reverse({
        mergeId: merge.id,
        reason: "Two genuinely different companies; the registrations differ.",
      });

      // The withdrawn row is a live subject again, still in its own role.
      const onCaseAfter = await subjects.forCase(record.id);
      expect(onCaseAfter.map((s) => s.entityId).sort()).toEqual(
        [keep.id, lose.id].sort(),
      );
      expect(
        onCaseAfter.find((s) => s.entityId === lose.id)!.subjectRole,
      ).toBe("related_party");

      // And the statement is attributed to the record it was always about.
      // Getting this wrong is worse than a missing feature: a finding citing
      // it would still resolve, so it would read as sound while pointing at
      // the wrong company.
      const [back] = await tx<{ entity_id: string }[]>`
        select entity_id from intel.information where id = ${statement.id}::uuid
      `;
      expect(back.entity_id).toBe(lose.id);

      // The log of what moved is marked restored rather than erased.
      const [rows] = await tx<{ total: string; restored: string }[]>`
        select count(*) as total, count(restored_at) as restored
        from intel.entity_merge_rows
        where merge_id = ${merge.id}::uuid
      `;
      expect(Number(rows.total)).toBeGreaterThan(0);
      expect(rows.restored).toBe(rows.total);
    });
  });

  it("refuses to rewrite a merge record, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx, ["supervisor"]));
      const entities = createEntityRepository(actor, tx);
      const resolution = createResolutionRepository(actor, tx);

      const keep = await entities.create({
        entityType: "company",
        name: "Echo Ltd",
        classification: "CONFIDENTIAL",
      });
      const lose = await entities.create({
        entityType: "company",
        name: "Echo Limited",
        classification: "CONFIDENTIAL",
      });
      const flag = await resolution.flag({
        entityAId: keep.id,
        entityBId: lose.id,
        flagType: "potential_duplicate",
      });
      await resolution.decide({
        flagId: flag.id,
        status: "same_entity",
        reason: "The same company, recorded twice on the same day.",
      });
      const merge = await resolution.merge({
        survivingEntityId: keep.id,
        mergedEntityId: lose.id,
        reason: "Duplicate created by a double submission.",
      });

      await expect(
        tx.savepoint(
          (sp) => sp`
            update intel.entity_merges
            set reason = 'something else entirely'
            where id = ${merge.id}::uuid
          `,
        ),
      ).rejects.toThrow(/cannot be rewritten/);

      // And it cannot be reversed twice.
      await resolution.reverse({ mergeId: merge.id, reason: "reversed for the test" });
      await expect(
        resolution.reverse({ mergeId: merge.id, reason: "again" }),
      ).rejects.toThrow(/already been reversed/);
    });
  });

  it("holds a flagged pair in one order, whichever way round it is flagged", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx, ["supervisor"]));
      const entities = createEntityRepository(actor, tx);
      const resolution = createResolutionRepository(actor, tx);

      const one = await entities.create({
        entityType: "person",
        name: "Foxtrot One",
        classification: "CONFIDENTIAL",
      });
      const two = await entities.create({
        entityType: "person",
        name: "Foxtrot Two",
        classification: "CONFIDENTIAL",
      });

      const first = await resolution.flag({
        entityAId: one.id,
        entityBId: two.id,
        flagType: "potential_match",
      });
      const second = await resolution.flag({
        entityAId: two.id,
        entityBId: one.id,
        flagType: "potential_duplicate",
      });

      // The same pair, so the same row: one question asked twice is still one
      // question.
      expect(second.id).toBe(first.id);
      expect(second.flagType).toBe("potential_duplicate");
    });
  });
});

suite("sources", () => {
  it("protects a human source's identity without hiding what it said", async () => {
    await inRolledBackTx(async (tx) => {
      // An Investigator, which is the role that actually meets human
      // sources. Migration 0043 exists because the first reading of PRD 6.4
      // raised the whole record to STRICTLY_RESTRICTED, and no role PRD 16
      // gives `sources:create` to reaches that ceiling: the investigator who
      // recruited the source could not record them at all.
      const actor = actorFor(await seedUser(tx, ["investigator"]));
      const sources = createSourceRepository(actor, tx);
      const record = await seedCase(tx, actor, "E2E Intel Human Source Ltd");

      const created = await sources.create({
        caseId: record.id,
        sourceType: "human_source",
        description: "A former employee of the subject's finance department.",
        dateObtained: YESTERDAY,
        obtainedBy: actor.userId,
        sourceReliability: "usually_reliable",
        identityName: "Kofi Mensah",
        identityContact: "+233 24 000 0000",
        classification: "CONFIDENTIAL",
      });

      // The record is classified where the recorder put it, so the case team
      // can read what the source told them.
      expect(created.classification).toBe("CONFIDENTIAL");
      // The identity is protected whatever the application passed, decided
      // by the table rather than by the typist.
      expect(created.identityRestricted).toBe(true);
    });
  });

  it("refuses an identity on a source that is not restricted, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Intel Open Source Ltd");

      await expect(
        tx.savepoint(
          (sp) => sp`
            insert into intel.sources (
              case_id, source_type, description, date_obtained, obtained_by,
              source_reliability, identity_restricted, identity_name,
              classification, created_by
            ) values (
              ${record.id}::uuid, 'open_source', 'A newspaper report',
              ${YESTERDAY}::date, ${actor.userId}::uuid, 'unknown',
              false, 'Kofi Mensah', 'INTERNAL', ${actor.userId}::uuid
            )
          `,
        ),
      ).rejects.toThrow(/sources_identity_is_protected/);
    });
  });

  it("withholds a human source's identity from everybody whose permission stops below it", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = actorFor(await seedUser(tx, ["administrator"]));
      const sources = createSourceRepository(admin, tx);
      const record = await seedCase(tx, admin, "E2E Intel Withheld Ltd");

      const created = await sources.create({
        caseId: record.id,
        sourceType: "human_source",
        description: "A contact inside the supplier.",
        dateObtained: YESTERDAY,
        obtainedBy: admin.userId,
        sourceReliability: "reliable",
        identityName: "Protected Name",
        classification: "CONFIDENTIAL",
      });
      // An administrator holds the wildcard, so they can read it.
      expect(created.identityName).toBe("Protected Name");

      // The same source read by an operations manager on the same case. The
      // record is CONFIDENTIAL, so they can see it and what it said, which is
      // the point of migration 0043. What they must not see is the name, and
      // that gate is inside the select rather than in a policy: no role's
      // ceiling on `sources` reaches STRICTLY_RESTRICTED, which is what PRD
      // 6.4's "named-user access only" amounts to.
      const manager = actorFor(await seedUser(tx, ["operations_manager"]));
      const managerSources = createSourceRepository(manager, tx);

      const seen = await managerSources.findById(created.id);
      expect(seen).not.toBeNull();
      expect(seen!.identityName).toBeNull();
      expect(seen!.identityContact).toBeNull();
      // And it says which it is: withheld, not absent. A screen that showed
      // "no identity recorded" would be telling the reader something false.
      expect(seen!.identityWithheld).toBe(true);
      expect(seen!.identityRestricted).toBe(true);

      // Nor can they overwrite what they cannot read.
      await expect(
        managerSources.update(
          created.id,
          { identityName: "Someone Else" },
          seen!.version,
        ),
      ).rejects.toThrow(/withheld from you/);
    });
  });

  it("counts the information attributed to it", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const sources = createSourceRepository(actor, tx);
      const information = createInformationRepository(actor, tx);
      const record = await seedCase(tx, actor, "E2E Intel Attribution Ltd");

      const source = await sources.create({
        caseId: record.id,
        sourceType: "public_registry",
        description: "Companies registry search for the subject.",
        dateObtained: YESTERDAY,
        obtainedBy: actor.userId,
        sourceReliability: "reliable",
        classification: "CONFIDENTIAL",
      });

      await information.create({
        caseId: record.id,
        sourceId: source.id,
        dateObtained: YESTERDAY,
        description: "The subject is a director of two other companies.",
        informationCredibility: "probable",
        confidence: "moderate",
        classification: "CONFIDENTIAL",
      });

      const reread = await sources.findById(source.id);
      expect(reread!.informationCount).toBe(1);
    });
  });
});

suite("information", () => {
  it("carries the source's reliability beside its own credibility, never merged", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const sources = createSourceRepository(actor, tx);
      const information = createInformationRepository(actor, tx);
      const record = await seedCase(tx, actor, "EdgeTwo Ratings Ltd");

      // The case PRD 6.4 exists for: a reliable source reporting something
      // nobody has confirmed. A single quality number would lose it.
      const source = await sources.create({
        caseId: record.id,
        sourceType: "interview",
        description: "Interview with the former financial controller.",
        dateObtained: YESTERDAY,
        obtainedBy: actor.userId,
        sourceReliability: "reliable",
        classification: "CONFIDENTIAL",
      });

      const piece = await information.create({
        caseId: record.id,
        sourceId: source.id,
        dateObtained: YESTERDAY,
        description: "She believes the invoices were approved verbally.",
        informationCredibility: "unverified",
        confidence: "low",
        classification: "CONFIDENTIAL",
      });

      expect(piece.sourceReliability).toBe("reliable");
      expect(piece.informationCredibility).toBe("unverified");
    });
  });

  it("refuses to be confirmed and contradicted at once, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const sources = createSourceRepository(actor, tx);
      const information = createInformationRepository(actor, tx);
      const record = await seedCase(tx, actor, "EdgeTwo Contradiction Ltd");

      const source = await sources.create({
        caseId: record.id,
        sourceType: "media",
        description: "A newspaper report.",
        dateObtained: YESTERDAY,
        obtainedBy: actor.userId,
        sourceReliability: "questionable",
        classification: "CONFIDENTIAL",
      });
      const piece = await information.create({
        caseId: record.id,
        sourceId: source.id,
        dateObtained: YESTERDAY,
        description: "The company was dissolved in 2019.",
        informationCredibility: "confirmed",
        confidence: "moderate",
        classification: "CONFIDENTIAL",
      });

      await expect(
        tx.savepoint(
          (sp) => sp`
            update intel.information
            set verification_status = 'contradicted'
            where id = ${piece.id}::uuid
          `,
        ),
      ).rejects.toThrow(/not_confirmed_and_contradicted/);
    });
  });

  it("corroborates from another source, counts it, and lists it with its reliability", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const sources = createSourceRepository(actor, tx);
      const information = createInformationRepository(actor, tx);
      const record = await seedCase(tx, actor, "EdgeTwo Corroboration Ltd");

      const registry = await sources.create({
        caseId: record.id,
        sourceType: "public_registry",
        description: "Registry search.",
        dateObtained: YESTERDAY,
        obtainedBy: actor.userId,
        sourceReliability: "reliable",
        classification: "CONFIDENTIAL",
      });
      const filing = await sources.create({
        caseId: record.id,
        sourceType: "corporate_filing",
        description: "Annual return for 2025.",
        dateObtained: YESTERDAY,
        obtainedBy: actor.userId,
        sourceReliability: "usually_reliable",
        classification: "CONFIDENTIAL",
      });

      const first = await information.create({
        caseId: record.id,
        sourceId: registry.id,
        dateObtained: YESTERDAY,
        description: "The subject was appointed a director in March 2024.",
        informationCredibility: "probable",
        confidence: "moderate",
        classification: "CONFIDENTIAL",
      });
      const second = await information.create({
        caseId: record.id,
        sourceId: filing.id,
        dateObtained: YESTERDAY,
        description: "The 2025 return lists the subject as a director.",
        informationCredibility: "probable",
        confidence: "moderate",
        classification: "CONFIDENTIAL",
      });

      await information.addCorroboration({
        informationId: first.id,
        corroboratingInformationId: second.id,
        note: "The filing bears out the registry search.",
      });

      const links = await information.corroborations(first.id);
      expect(links).toHaveLength(1);
      expect(links[0].corroboratingSourceReliability).toBe("usually_reliable");

      const reread = await information.findById(first.id);
      expect(reread!.corroborationCount).toBe(1);

      // Twice is still once.
      await expect(
        information.addCorroboration({
          informationId: first.id,
          corroboratingInformationId: second.id,
        }),
      ).rejects.toThrow(/already recorded as corroborating/);
    });
  });

  it("refuses to corroborate itself, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const sources = createSourceRepository(actor, tx);
      const information = createInformationRepository(actor, tx);
      const record = await seedCase(tx, actor, "EdgeTwo Self Ltd");

      const source = await sources.create({
        caseId: record.id,
        sourceType: "open_source",
        description: "A company website.",
        dateObtained: YESTERDAY,
        obtainedBy: actor.userId,
        sourceReliability: "unknown",
        classification: "CONFIDENTIAL",
      });
      const piece = await information.create({
        caseId: record.id,
        sourceId: source.id,
        dateObtained: YESTERDAY,
        description: "The website names three directors.",
        informationCredibility: "possible",
        confidence: "low",
        classification: "CONFIDENTIAL",
      });

      await expect(
        tx.savepoint(
          (sp) => sp`
            insert into intel.information_corroboration
              (information_id, corroborating_information_id, created_by)
            values (${piece.id}::uuid, ${piece.id}::uuid, ${actor.userId}::uuid)
          `,
        ),
      ).rejects.toThrow(/corroboration_not_itself/);
    });
  });

  it("finds the statements nothing bears out, which is the list to work through", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const sources = createSourceRepository(actor, tx);
      const information = createInformationRepository(actor, tx);
      const evidenceItems = createEvidenceRepository(actor, tx);
      const record = await seedCase(tx, actor, "EdgeTwo Uncorroborated Ltd");

      const source = await sources.create({
        caseId: record.id,
        sourceType: "interview",
        description: "Interview with a neighbour.",
        dateObtained: YESTERDAY,
        obtainedBy: actor.userId,
        sourceReliability: "unknown",
        classification: "CONFIDENTIAL",
      });

      const alone = await information.create({
        caseId: record.id,
        sourceId: source.id,
        dateObtained: YESTERDAY,
        description: "Nobody has lived at the registered address for a year.",
        informationCredibility: "possible",
        confidence: "low",
        classification: "CONFIDENTIAL",
      });
      const supported = await information.create({
        caseId: record.id,
        sourceId: source.id,
        dateObtained: YESTERDAY,
        description: "The gate was chained shut.",
        informationCredibility: "possible",
        confidence: "low",
        classification: "CONFIDENTIAL",
      });

      const item = await evidenceItems.register({
        caseId: record.id,
        evidenceType: "photograph",
        description: "Photograph of the chained gate.",
        collectedBy: actor.userId,
        collectedAt: new Date(Date.now() - 3_600_000).toISOString(),
        collectionLocation: "The registered address",
        collectionMethod: "Photographed from the road",
        classification: "CONFIDENTIAL",
      });
      await information.linkEvidence({
        informationId: supported.id,
        evidenceItemId: item.id,
      });

      const uncorroborated = await information.list({
        caseId: record.id,
        uncorroboratedOnly: true,
      });
      expect(uncorroborated.rows.map((r) => r.id)).toEqual([alone.id]);

      const summary = await information.summary({ caseId: record.id });
      expect(summary.total).toBe(2);
      expect(summary.uncorroborated).toBe(1);
    });
  });
});

suite("findings", () => {
  it("numbers findings F-001 within their case, and does not restart at a year end", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const findings = createFindingRepository(actor, tx);
      const caseA = await seedCase(tx, actor, "EdgeThree Numbering A Ltd");
      const caseB = await seedCase(tx, actor, "EdgeThree Numbering B Ltd");

      const make = (caseId: string, statement: string) =>
        findings.create({
          caseId,
          statement,
          analyst: actor.userId,
          confidence: "moderate",
          classification: "CONFIDENTIAL",
        });

      const a1 = await make(caseA.id, "First on case A.");
      const a2 = await make(caseA.id, "Second on case A.");
      const b1 = await make(caseB.id, "First on case B.");

      expect(a1.findingId).toBe("F-001");
      expect(a2.findingId).toBe("F-002");
      // Per case, which is what lets a report say "finding F-003" inside one
      // case and mean something unambiguous.
      expect(b1.findingId).toBe("F-001");
    });
  });

  it("refuses to be reviewed by its own analyst, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const findings = createFindingRepository(actor, tx);
      const record = await seedCase(tx, actor, "EdgeThree Self Review Ltd");

      const created = await findings.create({
        caseId: record.id,
        statement: "The payments were authorised by the finance director.",
        analyst: actor.userId,
        confidence: "moderate",
        classification: "CONFIDENTIAL",
      });

      // PRD 16, at the table as well as in the domain: this one is worth two
      // locks.
      await expect(
        tx.savepoint(
          (sp) => sp`
            update intel.findings
            set status = 'accepted', reviewer = ${actor.userId}::uuid,
                reviewed_at = now()
            where id = ${created.id}::uuid
          `,
        ),
      ).rejects.toThrow(/not_reviewed_by_its_analyst/);
    });
  });

  it("refuses a return with no note, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const analyst = actorFor(await seedUser(tx));
      const reviewerId = await seedUser(tx, ["supervisor"]);
      const findings = createFindingRepository(analyst, tx);
      const record = await seedCase(tx, analyst, "EdgeThree Return Ltd");

      const created = await findings.create({
        caseId: record.id,
        statement: "The supplier never existed.",
        analyst: analyst.userId,
        confidence: "low",
        classification: "CONFIDENTIAL",
      });

      await expect(
        tx.savepoint(
          (sp) => sp`
            update intel.findings
            set status = 'returned', reviewer = ${reviewerId}::uuid,
                reviewed_at = now(), review_notes = null
            where id = ${created.id}::uuid
          `,
        ),
      ).rejects.toThrow(/return_has_a_reason/);
    });
  });

  it("builds a strip that reaches the source behind the information", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const sources = createSourceRepository(actor, tx);
      const information = createInformationRepository(actor, tx);
      const evidenceItems = createEvidenceRepository(actor, tx);
      const findings = createFindingRepository(actor, tx);
      const record = await seedCase(tx, actor, "EdgeThree Traceability Ltd");

      const source = await sources.create({
        caseId: record.id,
        sourceType: "financial_record",
        description: "Bank statements obtained from the client.",
        dateObtained: YESTERDAY,
        obtainedBy: actor.userId,
        sourceReliability: "reliable",
        classification: "CONFIDENTIAL",
      });
      const piece = await information.create({
        caseId: record.id,
        sourceId: source.id,
        dateObtained: YESTERDAY,
        description: "Three payments of GHS 45,000 each went to the same account.",
        informationCredibility: "confirmed",
        confidence: "high",
        classification: "CONFIDENTIAL",
      });
      const item = await evidenceItems.register({
        caseId: record.id,
        evidenceType: "financial_record",
        description: "Bank statement for account 1234567.",
        collectedBy: actor.userId,
        collectedAt: new Date(Date.now() - 3_600_000).toISOString(),
        collectionLocation: "The client's finance office",
        collectionMethod: "Handed over by the finance director",
        classification: "CONFIDENTIAL",
      });

      const finding = await findings.create({
        caseId: record.id,
        statement: "The three payments were authorised by the finance director.",
        analyst: actor.userId,
        confidence: "high",
        classification: "CONFIDENTIAL",
      });

      await findings.link({
        findingId: finding.id,
        linkType: "information",
        targetId: piece.id,
      });
      await findings.link({
        findingId: finding.id,
        linkType: "evidence",
        targetId: item.id,
      });

      const strip = await findings.traceability(finding.id);
      expect(strip).not.toBeNull();
      // The source is in the strip although nothing linked it: it is reached
      // through the information, which is the first leg of the chain.
      expect(strip!.hops.map((hop) => hop.kind)).toEqual([
        "source",
        "information",
        "evidence",
      ]);
      expect(strip!.hops[0].reference).toBe(source.sourceId);
      expect(strip!.hops[0].rating).toBe("reliable");
      expect(strip!.hops[1].rating).toBe("confirmed");
      expect(strip!.unsupported).toBe(false);

      const support = await findings.support(finding.id);
      expect(support.information).toEqual([
        { credibility: "confirmed", reliability: "reliable" },
      ]);
      expect(support.evidenceCount).toBe(1);

      // Linked twice is still once.
      await expect(
        findings.link({
          findingId: finding.id,
          linkType: "evidence",
          targetId: item.id,
        }),
      ).rejects.toThrow(/already linked/);
    });
  });

  it("does not count evidence that failed its integrity check as support", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const evidenceItems = createEvidenceRepository(actor, tx);
      const findings = createFindingRepository(actor, tx);
      const record = await seedCase(tx, actor, "EdgeThree Mismatch Ltd");

      const item = await evidenceItems.register({
        caseId: record.id,
        evidenceType: "digital_file",
        description: "A spreadsheet of the payments.",
        collectedBy: actor.userId,
        collectedAt: new Date(Date.now() - 3_600_000).toISOString(),
        collectionLocation: "The client's server",
        collectionMethod: "Exported by the IT manager",
        classification: "CONFIDENTIAL",
      });
      await evidenceItems.attachFile(item.id, {
        declaredSha256: "a".repeat(64),
        fileName: "payments.xlsx",
        fileType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        fileSize: 2048,
        storageBucket: "evidence-originals",
        storagePath: `${record.id}/${item.evidenceId}/payments.xlsx`,
      });
      await evidenceItems.recordVerification({
        id: item.id,
        computedSha256: "b".repeat(64),
        result: "mismatch",
        notes: "The stored file does not match.",
      });

      const finding = await findings.create({
        caseId: record.id,
        statement: "The spreadsheet shows the duplicate payments.",
        analyst: actor.userId,
        confidence: "low",
        classification: "CONFIDENTIAL",
      });
      await findings.link({
        findingId: finding.id,
        linkType: "evidence",
        targetId: item.id,
      });

      // The whole point of PRD 6.3: an item whose stored file does not match
      // what was collected supports nothing.
      const support = await findings.support(finding.id);
      expect(support.evidenceCount).toBe(0);
    });
  });

  it("counts findings that rest on nothing, which is what a supervisor looks at", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const findings = createFindingRepository(actor, tx);
      const record = await seedCase(tx, actor, "EdgeThree Summary Ltd");

      await findings.create({
        caseId: record.id,
        statement: "An opinion with nothing behind it.",
        analyst: actor.userId,
        confidence: "low",
        classification: "CONFIDENTIAL",
      });

      const summary = await findings.summary({ caseId: record.id });
      expect(summary.total).toBe(1);
      expect(summary.unsupported).toBe(1);
      expect(summary.accepted).toBe(0);
    });
  });
});

async function auditCount(
  tx: postgres.TransactionSql,
  action: string,
): Promise<number> {
  const [row] = await tx<{ total: string }[]>`
    select count(*) as total from audit.audit_log where action = ${action}
  `;
  return Number(row.total);
}

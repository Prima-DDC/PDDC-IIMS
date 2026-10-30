import { afterAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { testSql } from "../helpers/sql";
import { createCaseRepository } from "@/modules/casework/infrastructure/case-repository";
import { createClientRepository } from "@/modules/crm/infrastructure/client-repository";
import { createEngagementRepository } from "@/modules/crm/infrastructure/engagement-repository";
import {
  createCustodyRepository,
  createEvidenceRepository,
} from "@/modules/evidence/infrastructure/evidence-repository";
import { createDocumentRepository } from "@/modules/evidence/infrastructure/document-repository";
import { nextVersionLabel } from "@/modules/evidence/domain/policies";
import type { ActorContext } from "@/lib/db/client";

/**
 * Evidence, chain of custody and documents against the real Postgres
 * (PRD 6, 7).
 *
 * Everything runs in a transaction that is always rolled back.
 *
 * What is worth proving here rather than in the domain tests is the part only
 * the database can answer: that the EV identifier is numbered per case, that
 * the custody ledger genuinely refuses to be edited by the table owner
 * itself, that its hash chain holds and can be shown to hold, that an
 * approved document version is locked against alteration, and that a case
 * gets its twelve folders the moment it is created.
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
 * Two roles rather than one, and the reason is PRD 16 rather than
 * convenience: an Operations Manager has `V` on evidence and nothing more,
 * so they cannot register an item or attach a file to it. The role that does
 * that work is the Investigator.
 *
 * It only started to matter with migration 0051. Registering an item and
 * attaching a file go through row-level security, which this connection
 * bypasses because `postgres` holds `rolbypassrls`, so the fixture's roles
 * made no difference to them. `evidence.record_uploaded_file` checks
 * `evidence:upload` ITSELF, in the function body, and an explicit check is
 * not something a bypass can skip. The test was asserting repository
 * behaviour with a fixture that would have been refused in the product, and
 * only the one explicit check noticed.
 */
async function seedUser(
  tx: postgres.TransactionSql,
  roles: string[] = ["operations_manager", "investigator"],
): Promise<string> {
  const [{ id }] = await tx<{ id: string }[]>`
    select extensions.gen_random_uuid() as id
  `;
  await tx`
    insert into auth.users
      (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${id}::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${`pddc-ev-${id}@example.invalid`}, 'fixture', now(), now())
  `;
  await tx`
    insert into iam.users (id, clearance, status)
    values (${id}::uuid, 'STRICTLY_RESTRICTED', 'active')
  `;
  for (const key of roles) {
    await tx`
      insert into iam.user_roles (user_id, role_id)
      select ${id}::uuid, r.id from iam.roles r where r.key = ${key}
    `;
  }
  return id;
}

function actorFor(userId: string): ActorContext {
  return {
    userId,
    clearance: "STRICTLY_RESTRICTED",
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

async function auditCount(
  tx: postgres.TransactionSql,
  recordId: string,
  action?: string,
): Promise<number> {
  const rows = await tx<{ n: string }[]>`
    select count(*) as n from audit.audit_log
    where record_id = ${recordId}
      and (${action ?? null}::text is null or action = ${action ?? null})
  `;
  return Number(rows[0].n);
}

const COLLECTED = {
  evidenceType: "document" as const,
  description: "Bank statement for account 1234567, January to June, 14 pages.",
  collectedAt: new Date("2026-10-01T09:30:00.000Z").toISOString(),
  collectionLocation: "The client's registry office, Accra",
  collectionMethod: "Handed over by the finance director and bagged on site",
  classification: "CONFIDENTIAL" as const,
};

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/* ------------------------------------------------------------- evidence */

suite("the evidence register", () => {
  it("numbers items per case, in the PRD 6 format", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Evidence Co Ltd");
      const items = createEvidenceRepository(actor, tx);

      const first = await items.register({
        caseId: record.id,
        collectedBy: user,
        ...COLLECTED,
      });
      const second = await items.register({
        caseId: record.id,
        collectedBy: user,
        ...COLLECTED,
        description: "A second item from the same visit.",
      });

      // EV-YYYY-CCCCCC-NNN, where CCCCCC is the case number itself rather
      // than a second counter that could disagree with it.
      const caseNumber = record.caseId.split("-")[2];
      expect(first.evidenceId).toMatch(
        new RegExp(`^EV-\\d{4}-${caseNumber}-\\d{3}$`),
      );
      expect(first.evidenceId.endsWith("-001")).toBe(true);
      expect(second.evidenceId.endsWith("-002")).toBe(true);

      expect(first.status).toBe("registered");
      expect(first.copyStatus).toBe("original");
      expect(first.integrityStatus).toBe("no_file");
      expect(first.currentCustodian).toBe(user);
      expect(await auditCount(tx, first.id, "evidence.registered")).toBe(1);
    });
  });

  it("records the first custody event with the item", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Evidence Custody Ltd");
      const items = createEvidenceRepository(actor, tx);
      const custody = createCustodyRepository(actor, tx);

      const item = await items.register({
        caseId: record.id,
        collectedBy: user,
        ...COLLECTED,
      });

      // A chain that starts later has a gap at the point that matters most.
      const events = await custody.events(item.id);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("registered");
      expect(events[0].receivedBy).toBe(user);
      expect(events[0].prevHash).toMatch(/^[0-9a-f]{64}$/);
      expect(events[0].rowHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("refuses an item with a file but no hash", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Evidence File Ltd");
      const items = createEvidenceRepository(actor, tx);
      const item = await items.register({
        caseId: record.id,
        collectedBy: user,
        ...COLLECTED,
      });

      // The constraint, not the application: an item with a file and no hash
      // could never be verified, which is the one thing PRD 6.3 asks for.
      await expect(
        tx`
          update evidence.evidence_items
          set file_name = 'statement.pdf', storage_path = 'x/y.pdf',
              integrity_status = 'hash_unverified'
          where id = ${item.id}::uuid
        `,
      ).rejects.toThrow(/evidence_file_is_complete/);
    });
  });

  it("takes the declared hash on upload, then the server's own on verification", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Evidence Hash Ltd");
      const items = createEvidenceRepository(actor, tx);

      const item = await items.register({
        caseId: record.id,
        collectedBy: user,
        ...COLLECTED,
      });

      const attached = await items.attachFile(item.id, {
        declaredSha256: HASH_A,
        fileName: "statement.pdf",
        fileType: "application/pdf",
        fileSize: 184_320,
        storageBucket: "evidence-originals",
        storagePath: `${record.id}/${item.evidenceId}/statement.pdf`,
      });

      // Declared is not verified, and the screens say so.
      expect(attached.integrityStatus).toBe("hash_unverified");
      expect(attached.declaredSha256).toBe(HASH_A);
      expect(attached.computedSha256).toBeNull();
      expect(attached.verifiedAt).toBeNull();

      const verified = await items.recordVerification({
        id: item.id,
        computedSha256: HASH_A,
        result: "match",
      });
      expect(verified.integrityStatus).toBe("verified");
      expect(verified.verifiedAt).not.toBeNull();

      const checks = await items.integrityChecks(item.id);
      expect(checks).toHaveLength(1);
      expect(checks[0].result).toBe("match");
      expect(await auditCount(tx, item.id, "evidence.verified")).toBe(1);
    });
  });

  it("records a mismatch permanently, and keeps both hashes", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Evidence Mismatch Ltd");
      const items = createEvidenceRepository(actor, tx);

      const item = await items.register({
        caseId: record.id,
        collectedBy: user,
        ...COLLECTED,
      });
      await items.attachFile(item.id, {
        declaredSha256: HASH_A,
        fileName: "statement.pdf",
        fileType: "application/pdf",
        fileSize: 184_320,
        storageBucket: "evidence-originals",
        storagePath: `${record.id}/${item.evidenceId}/statement.pdf`,
      });

      const mismatched = await items.recordVerification({
        id: item.id,
        computedSha256: HASH_B,
        result: "mismatch",
        notes: "The stored object differs from what was collected.",
      });

      expect(mismatched.integrityStatus).toBe("mismatch");
      expect(mismatched.declaredSha256).toBe(HASH_A);
      expect(mismatched.computedSha256).toBe(HASH_B);
      expect(await auditCount(tx, item.id, "evidence.integrity_mismatch")).toBe(1);

      // And the check cannot be tidied away afterwards.
      const checks = await items.integrityChecks(item.id);
      await expect(
        tx`
          update evidence.integrity_checks set result = 'match'
          where id = ${checks[0].id}::uuid
        `,
      ).rejects.toThrow(/append-only/);
    });
  });

  it("refuses a second file on an original", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Evidence Writeonce Ltd");
      const items = createEvidenceRepository(actor, tx);

      const item = await items.register({
        caseId: record.id,
        collectedBy: user,
        ...COLLECTED,
      });
      const file = {
        declaredSha256: HASH_A,
        fileName: "statement.pdf",
        fileType: "application/pdf",
        fileSize: 1024,
        storageBucket: "evidence-originals",
        storagePath: `${record.id}/${item.evidenceId}/statement.pdf`,
      };
      await items.attachFile(item.id, file);

      await expect(items.attachFile(item.id, file)).rejects.toThrow(
        /write-once/,
      );
    });
  });

  it("links a working copy to its original, and counts them", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Evidence Copies Ltd");
      const items = createEvidenceRepository(actor, tx);

      const original = await items.register({
        caseId: record.id,
        collectedBy: user,
        ...COLLECTED,
      });
      const copy = await items.register({
        caseId: record.id,
        collectedBy: user,
        ...COLLECTED,
        description: "Working copy for the forensic accountant.",
        copyStatus: "working_copy",
        originalEvidenceId: original.id,
      });

      expect(copy.copyStatus).toBe("working_copy");
      expect(copy.originalEvidenceId).toBe(original.id);
      expect(copy.originalEvidenceReference).toBe(original.evidenceId);

      const reread = await items.findById(original.id);
      expect(reread!.workingCopyCount).toBe(1);

      // Taking a copy is its own kind of custody event.
      const events = await createCustodyRepository(actor, tx).events(copy.id);
      expect(events[0].eventType).toBe("copied");
    });
  });

  it("refuses a working copy with no original, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Evidence Orphan Ltd");

      await expect(
        tx`
          insert into evidence.evidence_items (
            evidence_id, case_id, evidence_type, description, collected_by,
            collected_at, collection_location, collection_method, copy_status,
            classification
          ) values (
            evidence.next_evidence_id(${record.id}::uuid), ${record.id}::uuid,
            'document', 'An orphan copy', ${user}::uuid, now(),
            'nowhere', 'somehow', 'working_copy', 'CONFIDENTIAL'
          )
        `,
      ).rejects.toThrow(/evidence_working_copy_has_an_original/);
    });
  });

  it("summarises what the case holds", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Evidence Summary Ltd");
      const items = createEvidenceRepository(actor, tx);

      const original = await items.register({
        caseId: record.id,
        collectedBy: user,
        ...COLLECTED,
      });
      await items.register({
        caseId: record.id,
        collectedBy: user,
        ...COLLECTED,
        description: "Working copy.",
        copyStatus: "working_copy",
        originalEvidenceId: original.id,
      });
      await items.attachFile(original.id, {
        declaredSha256: HASH_A,
        fileName: "a.pdf",
        fileType: "application/pdf",
        fileSize: 10,
        storageBucket: "evidence-originals",
        storagePath: `${record.id}/a.pdf`,
      });

      const summary = await items.summary({ caseId: record.id });
      expect(summary.total).toBe(2);
      expect(summary.originals).toBe(1);
      expect(summary.workingCopies).toBe(1);
      expect(summary.awaitingVerification).toBe(1);
      expect(summary.mismatched).toBe(0);
    });
  });

  it("soft-deletes and restores an item", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx, ["administrator"]);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Evidence Removal Ltd");
      const items = createEvidenceRepository(actor, tx);

      const item = await items.register({
        caseId: record.id,
        collectedBy: user,
        ...COLLECTED,
      });

      await items.softDelete(item.id, "Registered against the wrong case in error.");
      expect(
        (await items.list({ caseId: record.id, onlyDeleted: true })).total,
      ).toBe(1);
      expect((await items.list({ caseId: record.id })).total).toBe(0);

      await items.restore(item.id, "restored from the recycle bin");
      expect((await items.list({ caseId: record.id })).total).toBe(1);

      // The ledger is untouched by either: removing the record does not
      // remove the history.
      const events = await createCustodyRepository(actor, tx).events(item.id);
      expect(events).toHaveLength(1);
    });
  });
});

/* ------------------------------------------------------- chain of custody */

suite("the chain of custody", () => {
  async function withItem(
    tx: postgres.TransactionSql,
    name: string,
    roles: string[] = ["operations_manager", "investigator"],
  ) {
    const user = await seedUser(tx, roles);
    const actor = actorFor(user);
    const record = await seedCase(tx, actor, name);
    const items = createEvidenceRepository(actor, tx);
    const item = await items.register({
      caseId: record.id,
      collectedBy: user,
      ...COLLECTED,
    });
    return {
      user,
      actor,
      record,
      item,
      items,
      custody: createCustodyRepository(actor, tx),
    };
  }

  it("moves the custodian with the ledger", async () => {
    await inRolledBackTx(async (tx) => {
      const { user, item, custody, items } = await withItem(
        tx,
        "E2E Custody Move Ltd",
      );
      const analyst = await seedUser(tx, ["analyst"]);

      await custody.record({
        evidenceItemId: item.id,
        eventType: "released",
        releasedBy: user,
        receivedBy: analyst,
        purpose: "Forensic imaging at the laboratory",
        location: "PDDC laboratory",
        condition: "Sealed, seal intact",
      });

      // Whoever received it holds it: the item follows the ledger rather than
      // being set separately and allowed to disagree with it.
      const reread = await items.findById(item.id);
      expect(reread!.currentCustodian).toBe(analyst);
      expect(reread!.custodyEventCount).toBe(2);
    });
  });

  it("cannot be edited or deleted, by anybody", async () => {
    await inRolledBackTx(async (tx) => {
      const { item, custody } = await withItem(tx, "E2E Custody Immutable Ltd");
      const events = await custody.events(item.id);

      // Run as `postgres`, which owns the table: the trigger refuses it
      // regardless of privilege, which is the strongest statement this test
      // can make.
      await tx`savepoint no_update`;
      await expect(
        tx`
          update evidence.custody_events set purpose = 'something else'
          where id = ${events[0].id}::uuid
        `,
      ).rejects.toThrow(/append-only/);
      await tx`rollback to savepoint no_update`;

      await tx`savepoint no_delete`;
      await expect(
        tx`delete from evidence.custody_events where id = ${events[0].id}::uuid`,
      ).rejects.toThrow(/append-only/);
      await tx`rollback to savepoint no_delete`;
    });
  });

  it("keeps a hash chain that can be shown to hold", async () => {
    await inRolledBackTx(async (tx) => {
      const { user, item, custody } = await withItem(tx, "E2E Custody Chain Ltd");
      const analyst = await seedUser(tx, ["analyst"]);

      await custody.record({
        evidenceItemId: item.id,
        eventType: "released",
        releasedBy: user,
        receivedBy: analyst,
        purpose: "Forensic imaging at the laboratory",
      });
      await custody.record({
        evidenceItemId: item.id,
        eventType: "returned",
        releasedBy: analyst,
        receivedBy: user,
        purpose: "Imaging complete, returned to the evidence store",
      });

      const chain = await custody.verifyChain(item.id);
      expect(chain.events).toBe(3);
      expect(chain.intact).toBe(true);
      expect(chain.brokeAt).toBeNull();

      // Each entry links to the one before it.
      const events = await custody.events(item.id);
      expect(events[1].prevHash).toBe(events[0].rowHash);
      expect(events[2].prevHash).toBe(events[1].rowHash);
    });
  });

  it("corrects an entry by adding one, and only once", async () => {
    await inRolledBackTx(async (tx) => {
      const { user, item, custody } = await withItem(tx, "E2E Custody Fix Ltd");
      const analyst = await seedUser(tx, ["analyst"]);

      const wrong = await custody.record({
        evidenceItemId: item.id,
        eventType: "released",
        releasedBy: user,
        receivedBy: user,
        purpose: "Released for examination",
      });

      const correction = await custody.correct({
        correctsEventId: wrong.id,
        correctionReason: "The receiving officer was recorded wrongly",
        eventType: "released",
        releasedBy: user,
        receivedBy: analyst,
        purpose: "Released for examination",
      });

      expect(correction.correctsEventId).toBe(wrong.id);

      // Both are readable, and the original says it has been superseded.
      const events = await custody.events(item.id);
      const original = events.find((event) => event.id === wrong.id)!;
      expect(original.correctedByEventId).toBe(correction.id);

      // A second correction of the same entry is refused: a chain of
      // corrections of corrections is unreadable.
      await expect(
        custody.correct({
          correctsEventId: wrong.id,
          correctionReason: "Another attempt at the same entry",
          eventType: "released",
          releasedBy: user,
          receivedBy: analyst,
          purpose: "Released for examination",
        }),
      ).rejects.toThrow(/already been corrected/);

      // And the chain still holds across the correction.
      expect((await custody.verifyChain(item.id)).intact).toBe(true);
    });
  });

  it("refuses a movement with one end, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const { user, item } = await withItem(tx, "E2E Custody Oneend Ltd");

      await expect(
        tx`
          insert into evidence.custody_events (
            evidence_item_id, event_type, released_by, purpose, recorded_by
          ) values (
            ${item.id}::uuid, 'released', ${user}::uuid,
            'Released to nobody in particular', ${user}::uuid
          )
        `,
      ).rejects.toThrow(/custody_movement_has_two_ends/);
    });
  });

  it("refuses a correction with no reason, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const { user, item, custody } = await withItem(tx, "E2E Custody Noreason Ltd");
      const events = await custody.events(item.id);

      await expect(
        tx`
          insert into evidence.custody_events (
            evidence_item_id, event_type, purpose, corrects_event_id, recorded_by
          ) values (
            ${item.id}::uuid, 'correction', 'Fixing something',
            ${events[0].id}::uuid, ${user}::uuid
          )
        `,
      ).rejects.toThrow(/custody_correction_has_a_reason/);
    });
  });
});

/* ------------------------------------------------------------ documents */

suite("case documents", () => {
  it("gives every case its folders the moment it is created", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Documents Folders Ltd");
      const documents = createDocumentRepository(actor, tx);

      // PRD 7.1: "created automatically when a case is created". A trigger
      // rather than application code, so a case created by any route gets
      // them.
      const folders = await documents.folders(record.id);
      expect(folders).toHaveLength(12);
      expect(folders[0].name).toBe("01 Engagement");
      expect(folders.at(-1)!.name).toBe("12 Closure");
      expect(folders.every((folder) => folder.isSystem)).toBe(true);
      expect(folders.every((folder) => folder.documentCount === 0)).toBe(true);
    });
  });

  it("creates a document with its first version", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Documents First Ltd");
      const documents = createDocumentRepository(actor, tx);
      const folders = await documents.folders(record.id);

      const doc = await documents.create({
        caseId: record.id,
        folderId: folders[2].id,
        title: "Investigation plan, approved",
        documentType: "investigation_plan",
        classification: "CONFIDENTIAL",
        tags: ["plan"],
        version: {
          versionLabel: "v0.1",
          fileName: "plan.pdf",
          mimeType: "application/pdf",
          fileSize: 2048,
          sha256: HASH_A,
          storageBucket: "documents",
          storagePath: `${record.id}/plan-v0.1.pdf`,
        },
      });

      expect(doc.documentId).toMatch(/^DOC-\d{4}-\d{6}$/);
      expect(doc.current?.versionLabel).toBe("v0.1");
      expect(doc.current?.isCurrent).toBe(true);
      expect(doc.current?.isApproved).toBe(false);
      expect(doc.currentVersionId).toBe(doc.current?.id);
      expect(doc.approvedVersionId).toBeNull();
      expect(doc.folderName).toBe("03 Investigation Plan");
      expect(doc.tags).toEqual(["plan"]);
      expect(doc.versionCount).toBe(1);
      expect(await auditCount(tx, doc.id, "document.created")).toBe(1);

      // The folder now says it holds something.
      const after = await documents.folders(record.id);
      expect(after[2].documentCount).toBe(1);
    });
  });

  it("adds versions, keeps one current, and numbers them itself", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Documents Versions Ltd");
      const documents = createDocumentRepository(actor, tx);

      const doc = await documents.create({
        caseId: record.id,
        title: "Draft report",
        documentType: "draft_report",
        classification: "CONFIDENTIAL",
        version: {
          versionLabel: "v0.1",
          fileName: "report-v0.1.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          fileSize: 4096,
          sha256: HASH_A,
          storageBucket: "documents",
          storagePath: `${record.id}/report-v0.1.docx`,
        },
      });

      const second = await documents.addVersion({
        documentId: doc.id,
        versionLabel: nextVersionLabel({ versionLabel: "v0.1" }),
        changeNote: "Added the schedule of invoices at appendix B.",
        fileName: "report-v0.2.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileSize: 5120,
        sha256: HASH_B,
        storageBucket: "documents",
        storagePath: `${record.id}/report-v0.2.docx`,
      });

      expect(second.versionLabel).toBe("v0.2");
      expect(second.versionNo).toBe(2);
      expect(second.isCurrent).toBe(true);

      const versions = await documents.versions(doc.id);
      expect(versions).toHaveLength(2);
      // Exactly one current version, which a partial unique index enforces.
      expect(versions.filter((version) => version.isCurrent)).toHaveLength(1);
      expect(versions[0].versionNo).toBe(2);

      const reread = await documents.findById(doc.id);
      expect(reread!.current?.id).toBe(second.id);
      expect(reread!.versionCount).toBe(2);
    });
  });

  it("locks an approved version against alteration", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Documents Approved Ltd");
      const documents = createDocumentRepository(actor, tx);

      const doc = await documents.create({
        caseId: record.id,
        title: "Final report",
        documentType: "final_report",
        classification: "CONFIDENTIAL",
        version: {
          versionLabel: "v1.0",
          fileName: "final.pdf",
          mimeType: "application/pdf",
          fileSize: 8192,
          sha256: HASH_A,
          storageBucket: "documents",
          storagePath: `${record.id}/final-v1.0.pdf`,
        },
      });

      const approved = await documents.approveVersion(doc.current!.id);
      expect(approved.isApproved).toBe(true);
      expect(approved.approvedBy).toBe(user);
      expect(approved.approvedAt).not.toBeNull();

      const reread = await documents.findById(doc.id);
      expect(reread!.approvedVersionId).toBe(approved.id);

      // PRD 7.2: the file of an approved version cannot change. The trigger
      // refuses it whatever reaches the table.
      //
      // Inside a savepoint, because this test asserts two refusals and then
      // carries on working. A database error aborts the whole transaction, so
      // without the savepoint every statement after this one fails with
      // "current transaction is aborted" and the assertion that follows
      // reports the wrong cause.
      await expect(
        tx.savepoint(
          (sp) => sp`
            update docs.document_versions
            set sha256 = ${HASH_B}
            where id = ${approved.id}::uuid
          `,
        ),
      ).rejects.toThrow(/approved and cannot be altered/);

      // Approving twice is refused with something readable rather than a
      // constraint name.
      await expect(documents.approveVersion(approved.id)).rejects.toThrow(
        /already approved/,
      );

      // And a new version is how it changes instead.
      const next = await documents.addVersion({
        documentId: doc.id,
        versionLabel: nextVersionLabel(approved, "final"),
        changeNote: "Corrected the invoice totals in the schedule at appendix B.",
        fileName: "final-v2.pdf",
        mimeType: "application/pdf",
        fileSize: 8300,
        sha256: HASH_B,
        storageBucket: "documents",
        storagePath: `${record.id}/final-v2.0.pdf`,
      });
      expect(next.versionLabel).toBe("v2.0");
      expect(next.isCurrent).toBe(true);
      // The approved one is still the approved one until the new one is
      // approved too.
      expect((await documents.findById(doc.id))!.approvedVersionId).toBe(
        approved.id,
      );
    });
  });

  it("refuses an approval with no approver, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Documents Noapprover Ltd");
      const documents = createDocumentRepository(actor, tx);

      const doc = await documents.create({
        caseId: record.id,
        title: "Draft",
        documentType: "draft_report",
        classification: "CONFIDENTIAL",
        version: {
          versionLabel: "v0.1",
          fileName: "d.pdf",
          mimeType: "application/pdf",
          fileSize: 10,
          sha256: HASH_A,
          storageBucket: "documents",
          storagePath: `${record.id}/d.pdf`,
        },
      });

      await expect(
        tx`
          update docs.document_versions set is_approved = true
          where id = ${doc.current!.id}::uuid
        `,
      ).rejects.toThrow(/version_approval_has_an_approver/);
    });
  });

  it("filters by folder and by tag, and summarises", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Documents Filter Ltd");
      const documents = createDocumentRepository(actor, tx);
      const folders = await documents.folders(record.id);

      const plan = await documents.create({
        caseId: record.id,
        folderId: folders[2].id,
        title: "Plan",
        documentType: "investigation_plan",
        classification: "CONFIDENTIAL",
        tags: ["plan", "approved"],
        version: {
          versionLabel: "v0.1",
          fileName: "p.pdf",
          mimeType: "application/pdf",
          fileSize: 10,
          sha256: HASH_A,
          storageBucket: "documents",
          storagePath: `${record.id}/p.pdf`,
        },
      });
      await documents.create({
        caseId: record.id,
        folderId: folders[4].id,
        title: "Interview note",
        documentType: "interview_record",
        classification: "CONFIDENTIAL",
        version: {
          versionLabel: "v0.1",
          fileName: "i.pdf",
          mimeType: "application/pdf",
          fileSize: 10,
          sha256: HASH_B,
          storageBucket: "documents",
          storagePath: `${record.id}/i.pdf`,
        },
      });

      expect(
        (await documents.list({ caseId: record.id, folderId: folders[2].id })).total,
      ).toBe(1);
      expect((await documents.list({ caseId: record.id, tag: "plan" })).total).toBe(1);
      expect(
        (await documents.list({ caseId: record.id, documentType: "interview_record" }))
          .total,
      ).toBe(1);
      expect((await documents.list({ caseId: record.id })).total).toBe(2);

      await documents.approveVersion(plan.current!.id);
      const summary = await documents.summary({ caseId: record.id });
      expect(summary.total).toBe(2);
      expect(summary.approved).toBe(1);
      expect(summary.drafts).toBe(1);
      expect(summary.byFolder).toHaveLength(2);
    });
  });
});

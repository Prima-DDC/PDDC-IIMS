import { afterAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { testSql } from "../helpers/sql";
import { createClientRepository } from "@/modules/crm/infrastructure/client-repository";
import { createEngagementRepository } from "@/modules/crm/infrastructure/engagement-repository";
import { createIntakeRepository } from "@/modules/crm/infrastructure/intake-repository";
import { assertEngagementApprovable } from "@/modules/crm/domain/policies";
import { isCrmError } from "@/modules/crm/domain/errors";
import type { ActorContext } from "@/lib/db/client";

/**
 * The CRM repositories, exercised against the real Postgres.
 *
 * Same arrangement as user-repository.test.ts: everything runs inside a
 * transaction that is always rolled back, so the shared production database is
 * never written to, and the repositories accept the transaction for exactly
 * that reason.
 *
 * What is worth testing here, rather than in the domain tests, is the part
 * only the database can answer: that the identifier sequences allocate, that
 * the derived KYC status is stored, that the audit row lands in the same
 * transaction as the change, and that a conflict check records what the search
 * found. The rules themselves are tested in policies.test.ts.
 */

const hasDb = Boolean(process.env.SUPABASE_DB_URL);
const suite = describe.skipIf(!hasDb);

const sql = hasDb
  ? testSql()
  : null;

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

async function seedUser(
  tx: postgres.TransactionSql,
  roles: string[] = ["operations_manager"],
): Promise<string> {
  const [{ id }] = await tx<{ id: string }[]>`
    select extensions.gen_random_uuid() as id
  `;
  await tx`
    insert into auth.users
      (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${id}::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${`pddc-crm-${id}@example.invalid`}, 'fixture', now(), now())
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

/** How many audit rows mention a record, read as the owner. */
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

/* ------------------------------------------------------------------ clients */

suite("client repository", () => {
  it("allocates a CLI identifier and writes one audit row, in the same transaction", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const repo = createClientRepository(actorFor(manager), tx);

      const client = await repo.create({
        organisationName: "Integration Test Holdings Ltd",
        clientType: "corporate",
        riskRating: "medium",
        status: "prospect",
        classification: "CONFIDENTIAL",
      });

      expect(client.clientId).toMatch(/^CLI-\d{4}-\d{6}$/);
      expect(client.organisationName).toBe("Integration Test Holdings Ltd");
      expect(client.kycStatus).toBe("not_started");
      expect(client.version).toBe(1);

      // The audit row is written by the same transaction as the insert, which
      // is what makes the trail impossible to desynchronise from the data.
      expect(await auditCount(tx, client.id, "client.created")).toBe(1);
    });
  });

  it("refuses a second client with the same normalised name", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const repo = createClientRepository(actorFor(manager), tx);

      await repo.create({
        organisationName: "Duplicate Test Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });

      // "Limited" normalises to the same thing as "Ltd", so this is the same
      // name rather than a near miss.
      await expect(
        repo.create({
          organisationName: "Duplicate Test Limited",
          clientType: "corporate",
          riskRating: "low",
          status: "active",
          classification: "CONFIDENTIAL",
        }),
      ).rejects.toThrow(/already has that organisation name/i);
    });
  });

  it("rejects a stale update and leaves the record alone", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const repo = createClientRepository(actorFor(manager), tx);

      const client = await repo.create({
        organisationName: "Concurrency Test Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });

      await repo.update(client.id, {
        expectedVersion: client.version,
        industry: "Shipping",
      });

      // The second caller still holds version 1.
      await expect(
        repo.update(client.id, {
          expectedVersion: client.version,
          industry: "Mining",
        }),
      ).rejects.toThrow(/changed since you opened it/i);

      const after = await repo.findById(client.id);
      expect(after?.industry).toBe("Shipping");
    });
  });

  it("derives and stores the KYC status from the records on file", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const repo = createClientRepository(actorFor(manager), tx);

      const client = await repo.create({
        organisationName: "KYC Test Ltd",
        clientType: "corporate",
        riskRating: "medium",
        status: "prospect",
        classification: "CONFIDENTIAL",
      });

      await repo.addKycRecord({
        clientId: client.id,
        checkType: "identity",
        outcome: "pass",
      });
      let current = await repo.refreshKycStatus(client.id);
      expect(current.kycStatus).toBe("in_progress");

      await repo.addKycRecord({
        clientId: client.id,
        checkType: "registration",
        outcome: "pass",
      });
      await repo.addKycRecord({
        clientId: client.id,
        checkType: "ownership",
        outcome: "pass",
      });
      current = await repo.refreshKycStatus(client.id);
      expect(current.kycStatus).toBe("completed");
      expect(current.kycCompletedAt).not.toBeNull();

      // Raising the risk rating adds two required checks, so the same records
      // no longer amount to a complete position.
      await repo.update(client.id, {
        expectedVersion: current.version,
        riskRating: "high",
      });
      const raised = await repo.findById(client.id);
      expect(raised?.kycStatus).toBe("in_progress");
    });
  });

  it("keeps one primary contact per client by moving it", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const repo = createClientRepository(actorFor(manager), tx);

      const client = await repo.create({
        organisationName: "Contacts Test Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });

      await repo.addContact({
        clientId: client.id,
        fullName: "First Contact",
        isPrimary: true,
      });
      await repo.addContact({
        clientId: client.id,
        fullName: "Second Contact",
        isPrimary: true,
      });

      const contacts = await repo.contacts(client.id);
      const primary = contacts.filter((c) => c.isPrimary);
      expect(primary).toHaveLength(1);
      expect(primary[0].fullName).toBe("Second Contact");
    });
  });

  it("soft-deletes and restores, and counts live engagements", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const actor = actorFor(manager);
      const clients = createClientRepository(actor, tx);
      const engagements = createEngagementRepository(actor, tx);

      const client = await clients.create({
        organisationName: "Removal Test Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });

      expect(await clients.activeEngagementCount(client.id)).toBe(0);

      const engagement = await engagements.create({
        clientId: client.id,
        title: "A live engagement",
        engagementType: "due_diligence",
        classification: "CONFIDENTIAL",
      });
      expect(await clients.activeEngagementCount(client.id)).toBe(1);

      // Cancelling it takes it out of the count, which is what makes the
      // client removable again.
      await engagements.setStatus({
        id: engagement.id,
        status: "cancelled",
        reason: "integration test",
      });
      expect(await clients.activeEngagementCount(client.id)).toBe(0);

      await clients.softDelete(client.id, "integration test");
      const removed = await clients.findById(client.id);
      expect(removed?.deletedAt).not.toBeNull();

      await clients.restore(client.id, "integration test");
      const restored = await clients.findById(client.id);
      expect(restored?.deletedAt).toBeNull();
    });
  });
});

/* -------------------------------------------------------------- engagements */

suite("engagement repository", () => {
  it("allocates an ENG identifier and starts as a draft", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const actor = actorFor(manager);
      const clients = createClientRepository(actor, tx);
      const engagements = createEngagementRepository(actor, tx);

      const client = await clients.create({
        organisationName: "Engagement Test Ltd",
        clientType: "insurer",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });

      const engagement = await engagements.create({
        clientId: client.id,
        title: "Corporate fraud investigation",
        engagementType: "fraud_investigation",
        classification: "CONFIDENTIAL",
      });

      expect(engagement.engagementId).toMatch(/^ENG-\d{4}-\d{6}$/);
      expect(engagement.status).toBe("draft");
      expect(engagement.clientName).toBe("Engagement Test Ltd");
      // No check has been run, which is what the approval gate reads.
      expect(engagement.conflictStatus).toBeNull();
      expect(await auditCount(tx, engagement.id, "engagement.created")).toBe(1);
    });
  });

  it("freezes the scope and terms once approved", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const actor = actorFor(manager);
      const clients = createClientRepository(actor, tx);
      const engagements = createEngagementRepository(actor, tx);

      const client = await clients.create({
        organisationName: "Frozen Scope Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });
      const engagement = await engagements.create({
        clientId: client.id,
        title: "Scoped work",
        engagementType: "due_diligence",
        scopeOfServices: "The agreed scope",
        classification: "CONFIDENTIAL",
      });

      // Editable while it is a draft.
      const edited = await engagements.update(engagement.id, {
        expectedVersion: engagement.version,
        scopeOfServices: "A revised scope",
      });
      expect(edited.scopeOfServices).toBe("A revised scope");

      await engagements.setStatus({
        id: engagement.id,
        status: "pending_approval",
        reason: "ready",
      });
      const approved = await engagements.setStatus({
        id: engagement.id,
        status: "approved",
        reason: "signed off",
        approve: true,
      });
      expect(approved.approvedBy).toBe(manager);
      expect(approved.approvedAt).not.toBeNull();

      // And frozen afterwards: changing it is a scope change, not an edit.
      await expect(
        engagements.update(engagement.id, {
          expectedVersion: approved.version,
          scopeOfServices: "Quietly widened",
        }),
      ).rejects.toThrow(/cannot be edited here/i);
    });
  });

  it("records an approval under its own audit action", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const actor = actorFor(manager);
      const clients = createClientRepository(actor, tx);
      const engagements = createEngagementRepository(actor, tx);

      const client = await clients.create({
        organisationName: "Audited Approval Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });
      const engagement = await engagements.create({
        clientId: client.id,
        title: "Audited work",
        engagementType: "due_diligence",
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
        reason: "signed off",
        approve: true,
      });

      // Distinguishable from an ordinary status change, so "who approved
      // this" is answerable from the trail alone.
      expect(await auditCount(tx, engagement.id, "engagement.approved")).toBe(1);
      expect(await auditCount(tx, engagement.id, "engagement.status_changed")).toBe(1);
    });
  });

  it("refuses an engagement for a closed client", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const actor = actorFor(manager);
      const clients = createClientRepository(actor, tx);
      const engagements = createEngagementRepository(actor, tx);

      const client = await clients.create({
        organisationName: "Closed Client Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "closed",
        classification: "CONFIDENTIAL",
      });

      await expect(
        engagements.create({
          clientId: client.id,
          title: "Work for a closed client",
          engagementType: "due_diligence",
          classification: "CONFIDENTIAL",
        }),
      ).rejects.toThrow(/closed/i);
    });
  });
});

/* ------------------------------------------------------------------ intake */

suite("intake repository", () => {
  it("logs an enquiry with an ENQ identifier", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const intake = createIntakeRepository(actorFor(manager), tx);

      const enquiry = await intake.createEnquiry({
        receivedVia: "email",
        prospectName: "A New Prospect Ltd",
        subject: "Suspected supplier fraud",
        urgency: "high",
        classification: "CONFIDENTIAL",
      });

      expect(enquiry.enquiryId).toMatch(/^ENQ-\d{4}-\d{6}$/);
      expect(enquiry.status).toBe("new");
      expect(enquiry.conflictStatus).toBeNull();
      expect(await auditCount(tx, enquiry.id, "enquiry.received")).toBe(1);
    });
  });

  it("refuses an enquiry that names no party", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const intake = createIntakeRepository(actorFor(manager), tx);

      await expect(
        intake.createEnquiry({
          receivedVia: "email",
          subject: "An enquiry from nobody",
          urgency: "normal",
          classification: "CONFIDENTIAL",
        }),
      ).rejects.toThrow(/Name the party/i);
    });
  });

  it("finds the PRD's company example and records it as a potential match", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const actor = actorFor(manager);
      const clients = createClientRepository(actor, tx);
      const intake = createIntakeRepository(actor, tx);

      const onFile = await clients.create({
        organisationName: "ABC Holdings Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });

      // Read-only: finds candidates, records nothing.
      const candidates = await intake.screen(["ABC Holdings Ghana Limited"]);
      expect(candidates.length).toBeGreaterThanOrEqual(1);
      const hit = candidates.find((c) => c.matchedId === onFile.id);
      expect(hit).toBeDefined();
      expect(hit!.similarity).toBeGreaterThan(0.3);
      expect(hit!.matchedLabel).toBe("ABC Holdings Ltd");

      // Recording it stores the search and its results, so the check is
      // reproducible later.
      const check = await intake.recordCheck({
        clientId: onFile.id,
        terms: ["ABC Holdings Ghana Limited"],
      });

      expect(check.checkId).toMatch(/^CFL-\d{4}-\d{6}$/);
      expect(check.status).toBe("open");
      expect(check.decision).toBeNull();
      expect(check.matchCount).toBeGreaterThanOrEqual(1);
      expect(check.matches.map((m) => m.matchedLabel)).toContain("ABC Holdings Ltd");
      // Nothing was merged: the client on file is untouched.
      const unchanged = await clients.findById(onFile.id);
      expect(unchanged?.organisationName).toBe("ABC Holdings Ltd");
    });
  });

  it("finds the PRD's person example too", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const actor = actorFor(manager);
      const clients = createClientRepository(actor, tx);
      const intake = createIntakeRepository(actor, tx);

      await clients.create({
        organisationName: "John Mensah",
        clientType: "individual",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });

      const candidates = await intake.screen(["John K. Mensah"]);
      expect(candidates.map((c) => c.matchedLabel)).toContain("John Mensah");
    });
  });

  it("records a check with no matches, which is still a check", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const actor = actorFor(manager);
      const clients = createClientRepository(actor, tx);
      const intake = createIntakeRepository(actor, tx);

      const client = await clients.create({
        organisationName: "Wholly Unrelated Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });

      const check = await intake.recordCheck({
        clientId: client.id,
        terms: ["Kigali Mining Corporation"],
      });

      expect(check.matchCount).toBe(0);
      expect(check.highestScore).toBeNull();
      // Still open: no matches is not the same as a clearance, which only a
      // manager can record (PRD 8.3).
      expect(check.status).toBe("open");
      expect(check.decision).toBeNull();
    });
  });

  it("records a decision once, and refuses a second", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const actor = actorFor(manager);
      const clients = createClientRepository(actor, tx);
      const intake = createIntakeRepository(actor, tx);

      const client = await clients.create({
        organisationName: "Decision Test Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });
      const check = await intake.recordCheck({
        clientId: client.id,
        terms: ["Decision Test Ltd"],
      });

      const decided = await intake.decideCheck({
        id: check.id,
        decision: "cleared",
        reason: "The only match is this client itself.",
      });

      expect(decided.decision).toBe("cleared");
      expect(decided.status).toBe("cleared");
      expect(decided.decidedBy).toBe(manager);
      expect(decided.decidedAt).not.toBeNull();
      expect(await auditCount(tx, check.id, "conflict_check.decided")).toBe(1);

      await expect(
        intake.decideCheck({
          id: check.id,
          decision: "declined",
          reason: "Changed my mind about this one.",
        }),
      ).rejects.toThrow(/already been decided/i);
    });
  });

  it("surfaces the decided check to the engagement, which is what the gate reads", async () => {
    await inRolledBackTx(async (tx) => {
      const author = await seedUser(tx);
      const approver = await seedUser(tx);
      const actor = actorFor(author);
      const clients = createClientRepository(actor, tx);
      const engagements = createEngagementRepository(actor, tx);
      const intake = createIntakeRepository(actor, tx);

      const client = await clients.create({
        organisationName: "Gate Test Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });
      const engagement = await engagements.create({
        clientId: client.id,
        title: "Work behind the gate",
        engagementType: "due_diligence",
        classification: "CONFIDENTIAL",
      });
      await engagements.setStatus({
        id: engagement.id,
        status: "pending_approval",
        reason: "ready",
      });

      // No check yet, so approval is refused even for a different approver.
      const unscreened = await engagements.findById(engagement.id);
      expect(unscreened!.conflictStatus).toBeNull();
      expect(() => assertEngagementApprovable(unscreened!, approver)).toThrow();

      const check = await intake.recordCheck({
        engagementId: engagement.id,
        clientId: client.id,
        terms: ["Gate Test Ltd"],
      });

      // Run but undecided is still not a clearance.
      const screened = await engagements.findById(engagement.id);
      expect(screened!.conflictStatus).toBe("open");
      try {
        assertEngagementApprovable(screened!, approver);
        throw new Error("should have been refused");
      } catch (error) {
        expect(isCrmError(error)).toBe(true);
      }

      await intake.decideCheck({
        id: check.id,
        decision: "cleared",
        reason: "No conflicting instruction on file for this party.",
      });

      const cleared = await engagements.findById(engagement.id);
      expect(cleared!.conflictStatus).toBe("cleared");
      // A different approver may now approve it; the author still may not.
      expect(() => assertEngagementApprovable(cleared!, approver)).not.toThrow();
      expect(() => assertEngagementApprovable(cleared!, author)).toThrow();
    });
  });

  it("lists a subject's own checks, not a page of everybody's", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const actor = actorFor(manager);
      const clients = createClientRepository(actor, tx);
      const intake = createIntakeRepository(actor, tx);

      const mine = await clients.create({
        organisationName: "Mine Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });
      const theirs = await clients.create({
        organisationName: "Theirs Ltd",
        clientType: "corporate",
        riskRating: "low",
        status: "active",
        classification: "CONFIDENTIAL",
      });

      const own = await intake.recordCheck({
        clientId: mine.id,
        terms: ["Mine Ltd"],
      });
      // Several checks against the other client, so a system-wide page sorted
      // newest first would push the first client's own check off the end. The
      // filter has to be in the query, not applied to whatever came back.
      for (let i = 0; i < 3; i += 1) {
        await intake.recordCheck({
          clientId: theirs.id,
          terms: [`Theirs Ltd ${i}`],
        });
      }

      const page = await intake.listChecks({ clientId: mine.id, limit: 2 });
      expect(page.rows.map((c) => c.id)).toEqual([own.id]);
      expect(page.total).toBe(1);

      const others = await intake.listChecks({ clientId: theirs.id, limit: 10 });
      expect(others.total).toBe(3);
    });
  });

  it("counts what the intake dashboard reports", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const intake = createIntakeRepository(actorFor(manager), tx);

      const before = await intake.summary();

      await intake.createEnquiry({
        receivedVia: "telephone",
        prospectName: "Summary Test Ltd",
        subject: "An urgent matter",
        urgency: "urgent",
        classification: "CONFIDENTIAL",
      });

      const after = await intake.summary();
      expect(after.openEnquiries).toBe(before.openEnquiries + 1);
      expect(after.urgent).toBe(before.urgent + 1);
    });
  });
});

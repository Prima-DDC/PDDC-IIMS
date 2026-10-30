import { afterAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { testSql } from "../helpers/sql";
import { createCaseRepository } from "@/modules/casework/infrastructure/case-repository";
import { createClientRepository } from "@/modules/crm/infrastructure/client-repository";
import { createEngagementRepository } from "@/modules/crm/infrastructure/engagement-repository";
import { createEvidenceRepository } from "@/modules/evidence/infrastructure/evidence-repository";
import { createFindingRepository } from "@/modules/intel/infrastructure/finding-repository";
import { createReportRepository } from "@/modules/reporting/infrastructure/report-repository";
import {
  createDeliveryRepository,
  createQaRepository,
} from "@/modules/reporting/infrastructure/qa-repository";
import {
  createClosureRepository,
  createManagementRepository,
} from "@/modules/reporting/infrastructure/closure-repository";
import { qaResultFromItems } from "@/modules/reporting/domain/policies";
import type { ActorContext } from "@/lib/db/client";

/**
 * Reports, QA, delivery, closure and the management reports against the real
 * Postgres (PRD 5.9, 10).
 *
 * Everything runs in a transaction that is always rolled back.
 *
 * What is worth proving here rather than in the domain tests is the part only
 * the database can answer: that an approved version and its sections are
 * locked against alteration, that a report cannot cite a finding nobody
 * accepted or an exhibit that failed its integrity check, that the workflow
 * history cannot be rewritten, that a QA review with a failed item cannot be
 * an approval, that an unapproved version cannot be delivered, that approving
 * a closure closes the case in the same breath, and that every query in the
 * management report runs at all.
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
): Promise<string> {
  const [{ id }] = await tx<{ id: string }[]>`
    select extensions.gen_random_uuid() as id
  `;
  await tx`
    insert into auth.users
      (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${id}::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${`pddc-rpt-${id}@example.invalid`}, 'fixture',
            now(), now())
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

/** A report with one section, ready to be moved along the line. */
async function seedReport(
  tx: postgres.TransactionSql,
  actor: ActorContext,
  name: string,
) {
  const record = await seedCase(tx, actor, name);
  const reports = createReportRepository(actor, tx);

  const report = await reports.create({
    caseId: record.id,
    title: `${name} investigation report`,
    reportType: "investigation_report",
    author: actor.userId,
    classification: "CONFIDENTIAL",
    executiveSummary: "Three payments were made without a purchase order.",
  });

  const section = await reports.addSection({
    versionId: report.currentVersionId!,
    heading: "The payments",
    body: "Three payments of GHS 45,000 went to one account in April.",
    sectionType: "narrative",
  });

  return { record, report, reports, section };
}

suite("reports and the workflow", () => {
  it("allocates an RPT identifier and its first version together", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const { report } = await seedReport(tx, actor, "EdgeFour Numbering Ltd");

      expect(report.reportId).toMatch(/^RPT-\d{4}-\d{6}$/);
      expect(report.status).toBe("draft");
      // A report with no version is a title, so the two are created together.
      expect(report.current?.versionLabel).toBe("v0.1");
      expect(report.versionCount).toBe(1);
    });
  });

  it("records every stage with its user, time and decision (PRD 10.1)", async () => {
    await inRolledBackTx(async (tx) => {
      const author = actorFor(await seedUser(tx));
      const { report, reports } = await seedReport(
        tx,
        author,
        "EdgeFour Workflow Ltd",
      );

      const reviewer = actorFor(await seedUser(tx, ["supervisor"]));
      const reviewerReports = createReportRepository(reviewer, tx);

      await reports.transition({
        id: report.id,
        to: "investigator_review",
        decision: "submitted",
        notes: "Ready for a first read.",
      });
      await reviewerReports.transition({
        id: report.id,
        to: "supervisor_review",
        decision: "submitted",
      });
      await reviewerReports.transition({
        id: report.id,
        to: "draft",
        decision: "returned",
        notes: "Paragraph 4 needs the account number.",
      });

      const history = await reports.history(report.id);
      expect(history).toHaveLength(3);
      expect(history.map((row) => row.decision)).toEqual([
        "submitted",
        "submitted",
        "returned",
      ]);
      // Each one names who decided it and when, which is what PRD 10.1 asks
      // for and what a status column alone cannot give.
      expect(history[2].decidedBy).toBe(reviewer.userId);
      expect(history[2].notes).toContain("account number");
      expect(history[2].decidedAt).not.toBeNull();
    });
  });

  it("refuses to rewrite the workflow history, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const { report, reports } = await seedReport(
        tx,
        actor,
        "EdgeFour History Ltd",
      );

      await reports.transition({
        id: report.id,
        to: "investigator_review",
        decision: "submitted",
      });
      const [row] = await tx<{ id: string }[]>`
        select id from reporting.report_transitions
        where report_id = ${report.id}::uuid limit 1
      `;

      await expect(
        tx.savepoint(
          (sp) => sp`
            update reporting.report_transitions
            set notes = 'something else entirely'
            where id = ${row.id}::uuid
          `,
        ),
      ).rejects.toThrow(/append-only/);

      await expect(
        tx.savepoint(
          (sp) => sp`
            delete from reporting.report_transitions where id = ${row.id}::uuid
          `,
        ),
      ).rejects.toThrow(/append-only/);
    });
  });

  it("locks an approved version and its sections against alteration", async () => {
    await inRolledBackTx(async (tx) => {
      const author = actorFor(await seedUser(tx));
      const { report, section } = await seedReport(tx, author, "EdgeFour Lock Ltd");

      const approver = actorFor(await seedUser(tx, ["supervisor"]));
      const approverReports = createReportRepository(approver, tx);

      // Along the line to approval, then approved by somebody else.
      for (const to of [
        "investigator_review",
        "supervisor_review",
        "qa_review",
        "approval",
      ] as const) {
        await approverReports.transition({ id: report.id, to, decision: "submitted" });
      }
      const final = await approverReports.transition({
        id: report.id,
        to: "final",
        decision: "approved",
        approveVersion: true,
      });

      expect(final.status).toBe("final");
      expect(final.current?.isApproved).toBe(true);
      expect(final.current?.approvedBy).toBe(approver.userId);
      expect(final.approvedVersionId).toBe(report.currentVersionId);

      // PRD 10.2: a final version is locked.
      await expect(
        tx.savepoint(
          (sp) => sp`
            update reporting.report_versions
            set conclusion = 'rewritten after approval'
            where id = ${report.currentVersionId}::uuid
          `,
        ),
      ).rejects.toThrow(/approved and cannot be altered/);

      // And so are its sections, which is the half a version-level lock
      // would miss: the text that matters is in them.
      await expect(
        tx.savepoint(
          (sp) => sp`
            update reporting.report_sections
            set body = 'rewritten after approval'
            where id = ${section.id}::uuid
          `,
        ),
      ).rejects.toThrow(/approved, so its sections cannot change/);

      await expect(
        tx.savepoint(
          (sp) => sp`
            delete from reporting.report_sections where id = ${section.id}::uuid
          `,
        ),
      ).rejects.toThrow(/approved, so its sections cannot change/);
    });
  });

  it("refuses an approval by the version's own author, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const author = actorFor(await seedUser(tx));
      const { report } = await seedReport(tx, author, "EdgeFour Self Ltd");

      await expect(
        tx.savepoint(
          (sp) => sp`
            update reporting.report_versions set
              is_approved = true,
              approved_by = ${author.userId}::uuid,
              approved_at = now()
            where id = ${report.currentVersionId}::uuid
          `,
        ),
      ).rejects.toThrow(/not_approved_by_its_author/);
    });
  });

  it("carries a version's content and citations forward to the next one", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const { record, report, reports, section } = await seedReport(
        tx,
        actor,
        "EdgeFour Carry Ltd",
      );

      // An accepted finding to cite, which is the only kind that may be.
      const findings = createFindingRepository(actor, tx);
      const reviewer = await seedUser(tx, ["supervisor"]);
      const finding = await findings.create({
        caseId: record.id,
        statement: "The payments lacked a purchase order.",
        analyst: actor.userId,
        confidence: "moderate",
        classification: "CONFIDENTIAL",
      });
      // Accepted directly: what this test is about is the copy, not how a
      // finding comes to be accepted, and that has its own tests.
      await tx`
        update intel.findings set
          status = 'accepted', reviewer = ${reviewer}::uuid, reviewed_at = now()
        where id = ${finding.id}::uuid
      `;

      await reports.cite({
        sectionId: section.id,
        citationType: "finding",
        targetId: finding.id,
        note: "Finding F-001",
      });

      const next = await reports.addVersion({
        reportId: report.id,
        versionLabel: "v0.2",
        changeNote: "Added the account number.",
        copyFromVersionId: report.currentVersionId,
      });

      // Copied, not referenced: an approved version is locked, so a later
      // one has to be free to differ from it in any respect.
      expect(next.versionLabel).toBe("v0.2");
      expect(next.executiveSummary).toContain("purchase order");

      const sections = await reports.sections(next.id);
      expect(sections).toHaveLength(1);
      expect(sections[0].heading).toBe("The payments");
      // And the citations came with them, which is what stops the author
      // re-citing thirty paragraphs to correct a date.
      expect(sections[0].citations).toHaveLength(1);
      expect(sections[0].citations[0].targetReference).toBe(finding.findingId);
      // A different section row, so editing it cannot reach the approved one.
      expect(sections[0].id).not.toBe(section.id);
    });
  });

  it("moves a section without breaking its position index", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const { report, reports } = await seedReport(tx, actor, "EdgeFour Order Ltd");

      const second = await reports.addSection({
        versionId: report.currentVersionId!,
        heading: "The conclusion",
        body: "The payments were irregular.",
        sectionType: "conclusion",
      });

      await reports.moveSection(second.id, "up");

      const sections = await reports.sections(report.currentVersionId!);
      expect(sections.map((s) => s.heading)).toEqual([
        "The conclusion",
        "The payments",
      ]);
      // Positions stay unique and contiguous, which the unique index demands.
      expect(sections.map((s) => s.position)).toEqual([1, 2]);
    });
  });
});

suite("what a report may cite (PRD 10.1, 10.2)", () => {
  it("refuses a finding nobody has accepted", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const { record, reports, section } = await seedReport(
        tx,
        actor,
        "EdgeFive Draft Finding Ltd",
      );

      const findings = createFindingRepository(actor, tx);
      const draft = await findings.create({
        caseId: record.id,
        statement: "An unreviewed opinion.",
        analyst: actor.userId,
        confidence: "low",
        classification: "CONFIDENTIAL",
      });

      // A draft conclusion in a client report is somebody's unreviewed
      // opinion presented as PDDC's.
      await expect(
        tx.savepoint(() =>
          reports.cite({
            sectionId: section.id,
            citationType: "finding",
            targetId: draft.id,
          }),
        ),
      ).rejects.toThrow(/has not been accepted/);
    });
  });

  it("refuses an exhibit that failed its integrity check", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const { record, reports, section } = await seedReport(
        tx,
        actor,
        "EdgeFive Mismatch Ltd",
      );

      const evidenceItems = createEvidenceRepository(actor, tx);
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
        fileType: "application/vnd.ms-excel",
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

      await expect(
        tx.savepoint(() =>
          reports.cite({
            sectionId: section.id,
            citationType: "evidence",
            targetId: item.id,
          }),
        ),
      ).rejects.toThrow(/failed its integrity check/);
    });
  });

  it("offers only what is citable", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const { record, reports } = await seedReport(
        tx,
        actor,
        "EdgeFive Citable Ltd",
      );

      const findings = createFindingRepository(actor, tx);
      const reviewer = await seedUser(tx, ["supervisor"]);

      const accepted = await findings.create({
        caseId: record.id,
        statement: "Accepted, and therefore citable.",
        analyst: actor.userId,
        confidence: "moderate",
        classification: "CONFIDENTIAL",
      });
      await tx`
        update intel.findings set
          status = 'accepted', reviewer = ${reviewer}::uuid, reviewed_at = now()
        where id = ${accepted.id}::uuid
      `;
      await findings.create({
        caseId: record.id,
        statement: "Still a draft.",
        analyst: actor.userId,
        confidence: "low",
        classification: "CONFIDENTIAL",
      });

      const citable = await reports.citable(record.id);
      // A picker offering the draft would spring the database's refusal on
      // the author after they had written the paragraph.
      expect(citable.findings.map((f) => f.id)).toEqual([accepted.id]);
    });
  });
});

suite("QA review (PRD 10.3)", () => {
  it("has the twelve named items, as configurable data", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx, ["qa_reviewer"]));
      const qa = createQaRepository(actor, tx);

      const checklist = await qa.checklist();
      expect(checklist).toHaveLength(12);
      expect(checklist.map((item) => item.key)).toContain("facts_separated");
      expect(checklist[0].position).toBe(1);
    });
  });

  it("refuses an approval with a failed item, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const author = actorFor(await seedUser(tx));
      const { report } = await seedReport(tx, author, "EdgeSix QA Ltd");

      const reviewer = actorFor(await seedUser(tx, ["qa_reviewer"]));
      const qa = createQaRepository(reviewer, tx);

      const review = await qa.open({
        reportId: report.id,
        versionId: report.currentVersionId!,
      });

      await qa.answer({
        reviewId: review.id,
        itemKey: "dates_verified",
        result: "fail",
        comment: "Paragraph 9 says March; the statement says April.",
      });

      // The one thing a checklist is for.
      await expect(
        tx.savepoint(() =>
          qa.complete({ reviewId: review.id, result: "approved" }),
        ),
      ).rejects.toThrow(/cannot be an approval/);

      // The honest result, which the domain derives and the database accepts.
      const completed = await qa.complete({
        reviewId: review.id,
        result: qaResultFromItems([{ result: "fail" }]),
        summary: "Returned for the date in paragraph 9.",
      });
      expect(completed.result).toBe("returned");
    });
  });

  it("refuses a failed item with no comment, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const author = actorFor(await seedUser(tx));
      const { report } = await seedReport(tx, author, "EdgeSix Silent Ltd");
      const reviewer = actorFor(await seedUser(tx, ["qa_reviewer"]));
      const qa = createQaRepository(reviewer, tx);

      const review = await qa.open({
        reportId: report.id,
        versionId: report.currentVersionId!,
      });

      await expect(
        tx.savepoint(
          (sp) => sp`
            insert into reporting.qa_review_items (review_id, item_key, result)
            values (${review.id}::uuid, 'names_verified', 'fail')
          `,
        ),
      ).rejects.toThrow(/failure_has_a_comment/);
    });
  });

  it("hands back the review already open rather than starting a second", async () => {
    await inRolledBackTx(async (tx) => {
      const author = actorFor(await seedUser(tx));
      const { report } = await seedReport(tx, author, "EdgeSix Reload Ltd");
      const reviewer = actorFor(await seedUser(tx, ["qa_reviewer"]));
      const qa = createQaRepository(reviewer, tx);

      const first = await qa.open({
        reportId: report.id,
        versionId: report.currentVersionId!,
      });
      await qa.answer({
        reviewId: first.id,
        itemKey: "scope_addressed",
        result: "pass",
      });

      // A reviewer who reloads should not lose the answers in the first.
      const second = await qa.open({
        reportId: report.id,
        versionId: report.currentVersionId!,
      });
      expect(second.id).toBe(first.id);
      expect(second.items).toHaveLength(1);
    });
  });

  it("reports the return rate, and null when nothing has been reviewed", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx, ["qa_reviewer"]));
      const qa = createQaRepository(actor, tx);

      // Far enough in the future that nothing in the live project qualifies.
      const rate = await qa.returnRate({ since: "2099-01-01T00:00:00Z" });
      expect(rate.reviewsCompleted).toBe(0);
      // Not zero: "we never send anything back" is a different claim from
      // "we have not reviewed anything".
      expect(rate.rate).toBeNull();
    });
  });
});

suite("client delivery (PRD 10.2)", () => {
  it("refuses a version nobody approved, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const { report } = await seedReport(tx, actor, "EdgeSeven Delivery Ltd");
      const deliveries = createDeliveryRepository(actor, tx);

      await expect(
        tx.savepoint(() =>
          deliveries.record({
            reportId: report.id,
            versionId: report.currentVersionId!,
            deliveredTo: "ama@client.example",
            deliveryMethod: "secure_link",
          }),
        ),
      ).rejects.toThrow(/has not been approved/);
    });
  });

  it("records a delivery of an approved version, and its acknowledgement", async () => {
    await inRolledBackTx(async (tx) => {
      const author = actorFor(await seedUser(tx));
      const { report } = await seedReport(tx, author, "EdgeSeven Approved Ltd");

      const approver = actorFor(await seedUser(tx, ["supervisor"]));
      const approverReports = createReportRepository(approver, tx);
      for (const to of [
        "investigator_review",
        "supervisor_review",
        "qa_review",
        "approval",
      ] as const) {
        await approverReports.transition({ id: report.id, to, decision: "submitted" });
      }
      await approverReports.transition({
        id: report.id,
        to: "final",
        decision: "approved",
        approveVersion: true,
      });

      const deliveries = createDeliveryRepository(author, tx);
      const delivery = await deliveries.record({
        reportId: report.id,
        versionId: report.currentVersionId!,
        deliveredTo: "ama@client.example",
        deliveryMethod: "secure_link",
        notes: "Signed link, valid for seven days.",
      });

      expect(delivery.versionLabel).toBe("v0.1");
      expect(delivery.acknowledgedAt).toBeNull();

      const acknowledged = await deliveries.acknowledge({
        deliveryId: delivery.id,
        acknowledgement: "Received, thank you.",
        acknowledgedByName: "Ama Boateng",
      });
      expect(acknowledged.acknowledgedAt).not.toBeNull();
      expect(acknowledged.acknowledgedByName).toBe("Ama Boateng");

      expect(await deliveries.anyForCase(delivery.reportId)).toBe(false);
    });
  });
});

suite("case closure (PRD 5.9)", () => {
  it("reads the three computed requirements from the records", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "EdgeEight Gate Ltd");
      const closures = createClosureRepository(actor, tx);

      const state = await closures.gateState(record.id);
      // A fresh case: no tasks, no report, no delivery, no objective.
      expect(state.openTaskCount).toBe(0);
      expect(state.reportApproved).toBe(false);
      expect(state.deliveryRecorded).toBe(false);
      expect(state.evidenceOnRelease).toBe(0);
      expect(state.objectivesRecorded).toBe(false);
    });
  });

  it("offers the configured retention classes", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const closures = createClosureRepository(actor, tx);

      const classes = await closures.retentionClasses();
      expect(classes.length).toBeGreaterThanOrEqual(5);
      expect(classes.map((row) => row.code)).toContain("litigation_10");
      expect(classes[0].years).toBeGreaterThan(0);
    });
  });

  it("refuses an approval by whoever proposed it, at the database", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "EdgeEight Self Ltd");
      const closures = createClosureRepository(actor, tx);

      const closure = await closures.propose({
        caseId: record.id,
        objectivesOutcome: "All three questions answered.",
        evidenceDisposition: "Returned to the client.",
        financialStatus: "Billed in full.",
        retentionClass: "standard_7",
        whatWorked: "The early registry search.",
      });
      expect(closure.status).toBe("proposed");

      // PRD 5.9 gives closure approval to a supervisor other than its
      // proposer, and this is the second of the two locks.
      await expect(
        tx.savepoint(
          (sp) => sp`
            update casework.case_closures set
              status = 'approved', approved_by = ${actor.userId}::uuid,
              approved_at = now()
            where case_id = ${record.id}::uuid
          `,
        ),
      ).rejects.toThrow(/not_approved_by_proposer/);
    });
  });

  it("closes the case in the same breath as approving the closure", async () => {
    await inRolledBackTx(async (tx) => {
      const lead = actorFor(await seedUser(tx));
      const record = await seedCase(tx, lead, "EdgeEight Closed Ltd");
      const closures = createClosureRepository(lead, tx);

      await closures.propose({
        caseId: record.id,
        objectivesOutcome: "Every question answered in the final report.",
        evidenceDisposition: "Returned to the client, logged in the ledger.",
        financialStatus: "Billed in full, nothing written off.",
        retentionClass: "financial_crime_10",
        whatWorked: "Reconciling the statements before the interviews.",
        contributeToKnowledgeBase: true,
      });

      const supervisor = actorFor(await seedUser(tx, ["supervisor"]));
      const decided = await createClosureRepository(supervisor, tx).decide({
        caseId: record.id,
        status: "approved",
      });

      expect(decided.status).toBe("approved");
      expect(decided.approvedBy).toBe(supervisor.userId);

      // Two statements would leave a window in which the closure says
      // approved and the case says open, and whichever a screen read would
      // be wrong.
      const [caseRow] = await tx<
        {
          closed_at: string | null;
          closed_by: string | null;
          retention_class: string | null;
          is_terminal: boolean;
        }[]
      >`
        select c.closed_at, c.closed_by, c.retention_class, s.is_terminal
        from casework.cases c
        join config.workflow_stages s on s.id = c.stage_id
        where c.id = ${record.id}::uuid
      `;
      expect(caseRow.closed_at).not.toBeNull();
      expect(caseRow.closed_by).toBe(supervisor.userId);
      expect(caseRow.is_terminal).toBe(true);
      // The case carries the retention class the closure chose, which is
      // what the archive screen reads.
      expect(caseRow.retention_class).toBe("financial_crime_10");

      // And it is offered to the knowledge base, because it was marked so
      // and has something in it.
      const shared = await closures.knowledgeBase({ limit: 10 });
      expect(shared.map((row) => row.caseId)).toContain(record.id);
    });
  });

  it("refuses a lessons-learned contribution with nothing in it", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "EdgeEight Empty Ltd");

      await expect(
        tx.savepoint(
          (sp) => sp`
            insert into casework.case_closures (
              case_id, objectives_outcome, evidence_disposition,
              financial_status, retention_class,
              contribute_to_knowledge_base, proposed_by
            ) values (
              ${record.id}::uuid, 'Answered.', 'Returned.', 'Billed.',
              'standard_7', true, ${actor.userId}::uuid
            )
          `,
        ),
      ).rejects.toThrow(/knowledge_base_has_content/);
    });
  });

  it("puts a returned closure back to proposed when it is offered again", async () => {
    await inRolledBackTx(async (tx) => {
      const lead = actorFor(await seedUser(tx));
      const record = await seedCase(tx, lead, "EdgeEight Returned Ltd");
      const closures = createClosureRepository(lead, tx);

      await closures.propose({
        caseId: record.id,
        objectivesOutcome: "Answered.",
        evidenceDisposition: "Returned.",
        financialStatus: "Billed.",
        retentionClass: "standard_7",
      });

      const supervisor = actorFor(await seedUser(tx, ["supervisor"]));
      await createClosureRepository(supervisor, tx).decide({
        caseId: record.id,
        status: "returned",
        reviewNotes: "The evidence disposition does not mention the copies.",
      });

      const again = await closures.propose({
        caseId: record.id,
        objectivesOutcome: "Answered.",
        evidenceDisposition: "Returned, including the two working copies.",
        financialStatus: "Billed.",
        retentionClass: "standard_7",
      });

      // A supervisor should see a fresh decision, not the one they returned.
      expect(again.status).toBe("proposed");
      expect(again.approvedBy).toBeNull();
      expect(again.evidenceDisposition).toContain("working copies");
    });
  });
});

suite("the management reports (PRD 10.4)", () => {
  it("answers all six questions, and every query runs", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      await seedCase(tx, actor, "EdgeNine Management Ltd");

      const management = createManagementRepository(actor, tx);
      const report = await management.report({});

      // Six figures, each a different question. This test exists mostly to
      // run the SQL: six aggregates over nine tables is where a column name
      // goes wrong silently, and TypeScript cannot see any of it.
      expect(Array.isArray(report.caseRegister)).toBe(true);
      expect(report.caseRegister.length).toBeGreaterThan(0);
      expect(typeof report.turnaround.closedCases).toBe("number");
      expect(Array.isArray(report.workload)).toBe(true);
      expect(Array.isArray(report.overdueTasks)).toBe(true);
      expect(typeof report.qaReturnRate.reviewsCompleted).toBe("number");
      expect(Array.isArray(report.revenueVersusCost)).toBe(true);

      const row = report.caseRegister[0];
      expect(row.caseReference).toMatch(/^PDDC-\d{4}-\d{6}$/);
      expect(typeof row.daysOpen).toBe("number");
      expect(row.stageName.length).toBeGreaterThan(0);
    });
  });

  it("computes a margin from what was invoiced, not what was quoted", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "EdgeNine Margin Ltd");

      // An invoiced amount needs an invoice number, which the table insists
      // on: a figure in the revenue column that nobody can tie to a document
      // is the kind of number a management report should never carry.
      await tx`
        insert into casework.case_financials (
          case_id, currency, quoted_fee, approved_fee, invoice_number,
          amount_invoiced, payment_status, created_by, updated_by
        ) values (
          ${record.id}::uuid, 'GHS', 50000, 50000, 'INV-2026-0001', 40000,
          'invoiced', ${actor.userId}::uuid, ${actor.userId}::uuid
        )
      `;
      // An approved expense has to say who approved it and when: a cost in a
      // management report that nobody signed off is not a cost PDDC can
      // defend, and the table says so.
      await tx`
        insert into casework.expenses (
          case_id, incurred_on, category, description, amount, currency,
          incurred_by, status, decided_at, decided_by, created_by, updated_by
        ) values (
          ${record.id}::uuid, current_date, 'travel', 'Flights', 5000, 'GHS',
          ${actor.userId}::uuid, 'approved', now(), ${actor.userId}::uuid,
          ${actor.userId}::uuid, ${actor.userId}::uuid
        )
      `;

      const report = await createManagementRepository(actor, tx).report({});
      const row = report.revenueVersusCost.find(
        (entry) => entry.caseId === record.id,
      );

      expect(row).toBeDefined();
      // A quote is an intention; PRD 10.4 asks for revenue.
      expect(row!.billed).toBe(40000);
      expect(row!.cost).toBe(5000);
      expect(row!.margin).toBe(35000);
    });
  });
});

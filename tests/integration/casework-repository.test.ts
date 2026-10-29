import { afterAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { testSql } from "../helpers/sql";
import { createCaseRepository } from "@/modules/casework/infrastructure/case-repository";
import { createWorkflowRepository } from "@/modules/casework/infrastructure/workflow-repository";
import { createClientRepository } from "@/modules/crm/infrastructure/client-repository";
import { createEngagementRepository } from "@/modules/crm/infrastructure/engagement-repository";
import {
  assertObjectiveOrOverride,
  assertRiskApprovedForAssignment,
  assertTransition,
} from "@/modules/casework/domain/policies";
import { isCaseworkError } from "@/modules/casework/domain/errors";
import type { ActorContext } from "@/lib/db/client";

/**
 * The casework repositories, against the real Postgres.
 *
 * Everything runs inside a transaction that is always rolled back, so the
 * shared production database is never written to.
 *
 * What is worth proving here rather than in the domain tests is the part only
 * the database can answer: that the lifecycle loads as data, that the PDDC
 * identifier allocates, that a scope version cannot be edited, that approving
 * a change request writes the next version in the same transaction, and that
 * assignment history survives an unassignment. The rules themselves are tested
 * in policies.test.ts, without a database.
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
            'authenticated', ${`pddc-case-${id}@example.invalid`}, 'fixture', now(), now())
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

/** A client with an approved engagement, which is what a case needs. */
async function seedCaseSubject(
  tx: postgres.TransactionSql,
  actor: ActorContext,
  name: string,
) {
  const clients = createClientRepository(actor, tx);
  const engagements = createEngagementRepository(actor, tx);

  const client = await clients.create({
    organisationName: name,
    clientType: "corporate",
    riskRating: "medium",
    status: "active",
    classification: "CONFIDENTIAL",
  });
  const engagement = await engagements.create({
    clientId: client.id,
    title: `${name} investigation`,
    engagementType: "fraud_investigation",
    classification: "CONFIDENTIAL",
  });
  await engagements.setStatus({
    id: engagement.id,
    status: "pending_approval",
    reason: "ready",
  });
  const approved = await engagements.setStatus({
    id: engagement.id,
    status: "approved",
    reason: "approved for the test",
    approve: true,
  });

  return { client, engagement: approved };
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

/* -------------------------------------------------------------- workflow */

suite("the configurable lifecycle", () => {
  it("loads the default definition with PRD 4.2's stages in order", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const workflow = createWorkflowRepository(actorFor(user), tx);

      const definition = await workflow.defaultDefinition();
      expect(definition.isDefault).toBe(true);
      expect(definition.stages.length).toBeGreaterThanOrEqual(14);

      const keys = definition.stages.map((s) => s.key);
      expect(keys[0]).toBe("new");
      expect(keys).toContain("pending_approval");
      expect(keys).toContain("quality_review");
      expect(keys.at(-1)).toBe("archived");

      // Positions ascend, which is what the progress rail depends on.
      const positions = definition.stages.map((s) => s.position);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });
  });

  it("marks only the genuinely final stages terminal", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const workflow = createWorkflowRepository(actorFor(user), tx);
      const definition = await workflow.defaultDefinition();

      const terminal = definition.stages.filter((s) => s.isTerminal).map((s) => s.key);
      expect(terminal.sort()).toEqual(["archived", "closed"]);
    });
  });

  it("returns the legal moves out of a stage, as data", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const workflow = createWorkflowRepository(actorFor(user), tx);
      const definition = await workflow.defaultDefinition();

      const draft = definition.stages.find((s) => s.key === "draft_report")!;
      const moves = await workflow.transitionsFrom(draft.id);

      expect(moves.map((m) => m.toStageKey)).toEqual(["quality_review"]);
      // PRD 4.2's named illegal transition.
      expect(moves.map((m) => m.toStageKey)).not.toContain("closed");
    });
  });

  it("carries the permission a gated transition needs", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const workflow = createWorkflowRepository(actorFor(user), tx);
      const definition = await workflow.defaultDefinition();

      const completed = definition.stages.find((s) => s.key === "completed")!;
      const moves = await workflow.transitionsFrom(completed.id);
      const toClosed = moves.find((m) => m.toStageKey === "closed");

      expect(toClosed?.requiredPermission).toBe("cases:close");
    });
  });

  it("reorders stages without colliding on the unique position", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx, ["administrator"]);
      const workflow = createWorkflowRepository(actorFor(user), tx);
      const definition = await workflow.defaultDefinition();

      // Reversing is the worst case for a naive implementation: every new
      // position is already taken by another row.
      const reversed = [...definition.stages].reverse().map((s) => s.id);
      await workflow.reorderStages(definition.id, reversed);

      const after = await workflow.definition(definition.id);
      expect(after!.stages.map((s) => s.id)).toEqual(reversed);
    });
  });

  it("refuses a partial reordering rather than losing a stage", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx, ["administrator"]);
      const workflow = createWorkflowRepository(actorFor(user), tx);
      const definition = await workflow.defaultDefinition();

      await expect(
        workflow.reorderStages(
          definition.id,
          definition.stages.slice(0, 3).map((s) => s.id),
        ),
      ).rejects.toThrow(/every stage/i);
    });
  });

  it("renames a stage for display without changing its key", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx, ["administrator"]);
      const workflow = createWorkflowRepository(actorFor(user), tx);
      const definition = await workflow.defaultDefinition();
      const stage = definition.stages.find((s) => s.key === "in_progress")!;

      const renamed = await workflow.renameStage(stage.id, "Fieldwork");
      expect(renamed.name).toBe("Fieldwork");
      // The key appears in permission grants and saved filters, so renaming
      // the label must not move it.
      expect(renamed.key).toBe("in_progress");
    });
  });

  it("counts the live cases sitting in each stage", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx, ["administrator"]));
      const workflow = createWorkflowRepository(actor, tx);
      const cases = createCaseRepository(actor, tx);
      const { client, engagement } = await seedCaseSubject(
        tx,
        actor,
        "E2E Stage Usage Ltd",
      );
      const record = await cases.create({
        title: "E2E stage usage case",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "fraud_investigation",
        priority: "medium",
        classification: "CONFIDENTIAL",
      });
      const definition = await workflow.defaultDefinition();

      const usage = await workflow.stageUsage(definition.id);

      // Every stage is listed, including the empty ones: the administration
      // screen needs a count for each, and a missing row would read as zero
      // by accident rather than on purpose.
      expect(usage).toHaveLength(definition.stages.length);

      const first = [...definition.stages].sort((a, b) => a.position - b.position)[0];
      const here = usage.find((u) => u.stageId === first.id)!;
      expect(here.cases).toBeGreaterThanOrEqual(1);

      // The count follows the case: moving it on empties the stage it left.
      const onwards = await workflow.transitionsFrom(first.id);
      await cases.moveToStage({
        id: record.id,
        toStageId: onwards[0].toStageId,
        reason: "moving it on to check the counts follow",
      });

      const after = await workflow.stageUsage(definition.id);
      expect(after.find((u) => u.stageId === first.id)!.cases).toBe(
        here.cases - 1,
      );
      expect(
        after.find((u) => u.stageId === onwards[0].toStageId)!.cases,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it("lists the case types PRD 5.2 names", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const workflow = createWorkflowRepository(actorFor(user), tx);
      const types = (await workflow.caseTypes()).map((t) => t.key);

      expect(types).toContain("fraud_investigation");
      expect(types).toContain("due_diligence");
      expect(types).toContain("surveillance");
      expect(types.length).toBeGreaterThanOrEqual(11);
    });
  });

  it("retires a case type rather than deleting it", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx, ["administrator"]);
      const workflow = createWorkflowRepository(actorFor(user), tx);

      await workflow.setCaseTypeActive("surveillance", false);
      const active = (await workflow.caseTypes()).map((t) => t.key);
      const all = (await workflow.caseTypes(true)).map((t) => t.key);

      // Gone from the choices for new cases, still there for the old ones.
      expect(active).not.toContain("surveillance");
      expect(all).toContain("surveillance");
    });
  });
});

/* ----------------------------------------------------------------- cases */

suite("the case record", () => {
  it("allocates a PDDC identifier and opens at the first stage", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E Case Co Ltd");
      const cases = createCaseRepository(actor, tx);

      const opened = await cases.create({
        title: "Suspected procurement fraud",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "fraud_investigation",
        priority: "high",
        classification: "CONFIDENTIAL",
      });

      expect(opened.caseId).toMatch(/^PDDC-\d{4}-\d{6}$/);
      expect(opened.stageKey).toBe("new");
      expect(opened.stageIsTerminal).toBe(false);
      expect(opened.clientName).toBe("E2E Case Co Ltd");
      expect(opened.engagementReference).toBe(engagement.engagementId);
      expect(opened.hasObjective).toBe(false);
      expect(opened.riskLevel).toBe("medium");
      expect(await auditCount(tx, opened.id, "case.opened")).toBe(1);
    });
  });

  it("records the case id against the audit row, so the case has a history", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E Audit Co Ltd");
      const cases = createCaseRepository(actor, tx);

      const opened = await cases.create({
        title: "Audited case",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "due_diligence",
        priority: "medium",
        classification: "CONFIDENTIAL",
      });

      // PRD 13 wants case entries findable by case, which needs case_id set
      // rather than only record_id.
      const rows = await tx<{ n: string }[]>`
        select count(*) as n from audit.audit_log where case_id = ${opened.id}::uuid
      `;
      expect(Number(rows[0].n)).toBeGreaterThanOrEqual(1);
    });
  });

  it("moves through the lifecycle and records each transition", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E Move Co Ltd");
      const cases = createCaseRepository(actor, tx);
      const workflow = createWorkflowRepository(actor, tx);

      const opened = await cases.create({
        title: "Moving case",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "due_diligence",
        priority: "medium",
        classification: "CONFIDENTIAL",
      });

      const definition = await workflow.defaultDefinition();
      const pending = definition.stages.find((s) => s.key === "pending_approval")!;

      const moves = await workflow.transitionsFrom(opened.stageId);
      // The domain rule and the loaded data agree.
      expect(() => assertTransition(
        { ...opened, id: opened.stageId, name: opened.stageName } as never,
        pending.id,
        moves,
      )).not.toThrow();

      const moved = await cases.moveToStage({
        id: opened.id,
        toStageId: pending.id,
        reason: "submitted for approval",
      });

      expect(moved.stageKey).toBe("pending_approval");
      expect(await auditCount(tx, opened.id, "case.stage_changed")).toBe(1);
    });
  });

  it("stamps the completion date on reaching a terminal stage", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E Close Co Ltd");
      const cases = createCaseRepository(actor, tx);
      const workflow = createWorkflowRepository(actor, tx);
      const definition = await workflow.defaultDefinition();

      const opened = await cases.create({
        title: "Closing case",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "due_diligence",
        priority: "low",
        classification: "CONFIDENTIAL",
      });
      expect(opened.actualCompletionAt).toBeNull();

      const closed = definition.stages.find((s) => s.key === "closed")!;
      // Moved directly here because the gate being tested is the terminal
      // stamp, not the path; the path is tested above and in the domain tests.
      const after = await cases.moveToStage({
        id: opened.id,
        toStageId: closed.id,
        reason: "closed for the test",
      });

      expect(after.stageIsTerminal).toBe(true);
      expect(after.actualCompletionAt).not.toBeNull();
    });
  });

  it("rejects a stale update", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E Stale Co Ltd");
      const cases = createCaseRepository(actor, tx);

      const opened = await cases.create({
        title: "Concurrency",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "due_diligence",
        priority: "low",
        classification: "CONFIDENTIAL",
      });

      await cases.update(opened.id, {
        expectedVersion: opened.version,
        title: "Concurrency, revised",
      });

      await expect(
        cases.update(opened.id, {
          expectedVersion: opened.version,
          title: "Concurrency, also revised",
        }),
      ).rejects.toThrow(/changed since you opened it/i);
    });
  });

  it("computes the overdue position from the target date and the stage", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E Late Co Ltd");
      const cases = createCaseRepository(actor, tx);
      const workflow = createWorkflowRepository(actor, tx);

      const opened = await cases.create({
        title: "Late case",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "due_diligence",
        priority: "medium",
        classification: "CONFIDENTIAL",
        // Backdated, as a case migrated from the previous manual process is:
        // the work started three weeks ago and its target has passed.
        openedAt: new Date(Date.now() - 21 * 86_400_000).toISOString(),
        targetCompletionAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      });

      expect(opened.isOverdue).toBe(true);
      expect(opened.daysToTarget).toBeLessThan(0);

      // A closed case is not overdue, however late it was: the work is done.
      const definition = await workflow.defaultDefinition();
      const archived = definition.stages.find((s) => s.key === "archived")!;
      const after = await cases.moveToStage({
        id: opened.id,
        toStageId: archived.id,
        reason: "archived",
      });
      expect(after.isOverdue).toBe(false);
    });
  });
});

/* ------------------------------------------------------------ objectives */

suite("objectives and the override", () => {
  async function openCase(tx: postgres.TransactionSql, actor: ActorContext, name: string) {
    const { client, engagement } = await seedCaseSubject(tx, actor, name);
    const cases = createCaseRepository(actor, tx);
    const opened = await cases.create({
      title: `${name} case`,
      clientId: client.id,
      engagementId: engagement.id,
      caseType: "due_diligence",
      priority: "medium",
      classification: "CONFIDENTIAL",
    });
    return { cases, opened };
  }

  it("records an objective with its questions and deliverables", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { cases, opened } = await openCase(tx, actor, "E2E Objective Co Ltd");

      const objective = await cases.setObjective({
        caseId: opened.id,
        clientInstruction: "Find out who authorised the duplicate invoices.",
        objective: "Establish whether procurement fraud occurred and by whom.",
        questions: ["Who approved the invoices?", "Was the supplier real?"],
        deliverables: ["Written report", "Evidence schedule"],
      });

      expect(objective.questions).toHaveLength(2);
      expect(objective.deliverables).toContain("Evidence schedule");

      const reloaded = await cases.findById(opened.id);
      expect(reloaded!.hasObjective).toBe(true);
      // Which is what the PRD 5.1 gate reads.
      expect(() => assertObjectiveOrOverride(reloaded!)).not.toThrow();
    });
  });

  it("keeps one objective per case, updating rather than adding", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { cases, opened } = await openCase(tx, actor, "E2E One Objective Ltd");

      const first = await cases.setObjective({
        caseId: opened.id,
        objective: "The first statement of what this case is for.",
        questions: [],
        deliverables: [],
      });
      const second = await cases.setObjective({
        caseId: opened.id,
        objective: "The revised statement of what this case is for.",
        questions: ["One question"],
        deliverables: [],
        expectedVersion: first.version,
      });

      expect(second.id).toBe(first.id);
      expect(second.objective).toContain("revised");
      expect(second.version).toBe(first.version + 1);
    });
  });

  it("records the PRD 5.1 override as a decision with an owner", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { cases, opened } = await openCase(tx, actor, "E2E Override Co Ltd");

      // Before: the gate refuses.
      expect(() => assertObjectiveOrOverride(opened)).toThrow();

      const after = await cases.recordObjectiveOverride(
        opened.id,
        "Retainer case: the objective is set per instruction and recorded on each task.",
      );

      expect(after.objectiveOverrideBy).toBe(user);
      expect(after.objectiveOverrideAt).not.toBeNull();
      expect(() => assertObjectiveOrOverride(after)).not.toThrow();
      expect(await auditCount(tx, opened.id, "case.objective_overridden")).toBe(1);
    });
  });
});

/* ------------------------------------------------------------------ risk */

suite("risk assessment", () => {
  it("records an assessment and moves the case's cached rating", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E Risk Co Ltd");
      const cases = createCaseRepository(actor, tx);

      const opened = await cases.create({
        title: "Risky case",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "surveillance",
        priority: "high",
        classification: "CONFIDENTIAL",
      });
      expect(opened.riskLevel).toBe("medium");

      await cases.addRiskAssessment({
        caseId: opened.id,
        operationalRisk: "high",
        legalRisk: "medium",
        reputationalRisk: "medium",
        safetyRisk: "critical",
        sensitivityRisk: "high",
        overallRisk: "critical",
        rationale: "Field surveillance in an area with a history of violence.",
      });

      const after = await cases.findById(opened.id);
      expect(after!.riskLevel).toBe("critical");
    });
  });

  it("blocks assignment on a critical case until the risk is approved", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E Critical Ltd");
      const cases = createCaseRepository(actor, tx);

      const opened = await cases.create({
        title: "Critical case",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "surveillance",
        priority: "urgent",
        classification: "CONFIDENTIAL",
      });

      const assessment = await cases.addRiskAssessment({
        caseId: opened.id,
        operationalRisk: "critical",
        legalRisk: "high",
        reputationalRisk: "high",
        safetyRisk: "critical",
        sensitivityRisk: "high",
        overallRisk: "critical",
        rationale: "Hostile subject, overseas jurisdiction, political exposure.",
      });

      const before = await cases.findById(opened.id);
      expect(() =>
        assertRiskApprovedForAssignment({
          riskLevel: before!.riskLevel,
          latestRiskApprovedAt: null,
        }),
      ).toThrow();

      const approved = await cases.approveRiskAssessment(assessment.id);
      expect(approved.approvedBy).toBe(user);
      expect(() =>
        assertRiskApprovedForAssignment({
          riskLevel: before!.riskLevel,
          latestRiskApprovedAt: approved.approvedAt,
        }),
      ).not.toThrow();
    });
  });

  it("refuses to approve the same assessment twice", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E Twice Ltd");
      const cases = createCaseRepository(actor, tx);
      const opened = await cases.create({
        title: "Twice-approved",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "due_diligence",
        priority: "low",
        classification: "CONFIDENTIAL",
      });

      const assessment = await cases.addRiskAssessment({
        caseId: opened.id,
        operationalRisk: "low",
        legalRisk: "low",
        reputationalRisk: "low",
        safetyRisk: "low",
        sensitivityRisk: "low",
        overallRisk: "low",
        rationale: "Routine desk-based review of public records.",
      });

      await cases.approveRiskAssessment(assessment.id);
      await expect(cases.approveRiskAssessment(assessment.id)).rejects.toThrow(
        /already been approved/i,
      );
    });
  });

  it("keeps every assessment, newest first", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E History Ltd");
      const cases = createCaseRepository(actor, tx);
      const opened = await cases.create({
        title: "Reassessed",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "due_diligence",
        priority: "low",
        classification: "CONFIDENTIAL",
      });

      for (const overall of ["low", "high"] as const) {
        await cases.addRiskAssessment({
          caseId: opened.id,
          operationalRisk: overall,
          legalRisk: overall,
          reputationalRisk: overall,
          safetyRisk: overall,
          sensitivityRisk: overall,
          overallRisk: overall,
          rationale: `Assessed as ${overall} after review of the file.`,
        });
      }

      const history = await cases.riskAssessments(opened.id);
      expect(history).toHaveLength(2);
      // Reassessment is normal, and the earlier view stays readable.
      expect(history[0].overallRisk).toBe("high");
      expect(history[1].overallRisk).toBe("low");
    });
  });
});

/* ----------------------------------------------------------------- scope */

suite("scope control (PRD 5.4)", () => {
  async function caseWithScope(
    tx: postgres.TransactionSql,
    actor: ActorContext,
    name: string,
  ) {
    const { client, engagement } = await seedCaseSubject(tx, actor, name);
    const cases = createCaseRepository(actor, tx);
    const opened = await cases.create({
      title: `${name} case`,
      clientId: client.id,
      engagementId: engagement.id,
      caseType: "due_diligence",
      priority: "medium",
      classification: "CONFIDENTIAL",
    });
    const original = await cases.setOriginalScope({
      caseId: opened.id,
      scope: "Review the three named subsidiaries and their directors.",
      outOfScope: "Anything outside Ghana.",
    });
    return { cases, opened, original };
  }

  it("records version 1 as the original", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { original } = await caseWithScope(tx, actor, "E2E Scope Co Ltd");

      expect(original.versionNo).toBe(1);
      expect(original.changeRequestId).toBeNull();
    });
  });

  it("refuses a second original", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { cases, opened } = await caseWithScope(tx, actor, "E2E Second Scope Ltd");

      await expect(
        cases.setOriginalScope({
          caseId: opened.id,
          scope: "A completely different scope, slipped in quietly.",
        }),
      ).rejects.toThrow(/immutable/i);
    });
  });

  it("refuses to edit a scope version at all, even as the owner", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { original } = await caseWithScope(tx, actor, "E2E Immutable Scope Ltd");

      // The trigger, not a policy: this runs as `postgres`, which owns the
      // table, so a policy alone would not stop it.
      await tx`savepoint attempt`;
      let message = "";
      try {
        await tx`
          update casework.scope_versions set scope = 'rewritten'
          where id = ${original.id}::uuid
        `;
      } catch (error) {
        message = (error as Error).message;
      }
      await tx`rollback to savepoint attempt`;
      expect(message).toMatch(/cannot be edited/i);
    });
  });

  it("approving a change request writes the next version in the same breath", async () => {
    await inRolledBackTx(async (tx) => {
      const author = await seedUser(tx);
      const approver = await seedUser(tx);
      const { cases, opened } = await caseWithScope(tx, actorFor(author), "E2E Change Ltd");

      const request = await cases.requestScopeChange({
        caseId: opened.id,
        reason: "The client has asked us to cover two more subsidiaries.",
        proposedScope: "Review five subsidiaries and their directors.",
        additionalCost: 4500,
        additionalCostCurrency: "GHS",
        additionalDays: 10,
        clientApprovalReference: "email of 21 October 2026",
      });
      expect(request.changeId).toMatch(/^SCR-\d{4}-\d{6}$/);
      expect(request.status).toBe("pending");

      // Decided by somebody else, which is what the domain rule requires.
      const approverCases = createCaseRepository(actorFor(approver), tx);
      const decided = await approverCases.decideScopeChange({
        id: request.id,
        approve: true,
        decisionReason: "Client approval received in writing; fee agreed.",
      });

      expect(decided.status).toBe("approved");
      expect(decided.resultingVersionId).not.toBeNull();

      const versions = await approverCases.scopeVersions(opened.id);
      expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
      // The original is still there, beside the revision (PRD 5.4).
      expect(versions[1].scope).toContain("three named subsidiaries");
      expect(versions[0].scope).toContain("five subsidiaries");
      expect(versions[0].changeRequestReference).toBe(request.changeId);
    });
  });

  it("rejecting a change request writes no new version", async () => {
    await inRolledBackTx(async (tx) => {
      const author = await seedUser(tx);
      const approver = await seedUser(tx);
      const { cases, opened } = await caseWithScope(tx, actorFor(author), "E2E Reject Ltd");

      const request = await cases.requestScopeChange({
        caseId: opened.id,
        reason: "We would like to widen this considerably.",
        proposedScope: "Review every company in the group.",
      });

      const approverCases = createCaseRepository(actorFor(approver), tx);
      const decided = await approverCases.decideScopeChange({
        id: request.id,
        approve: false,
        decisionReason: "The client has not agreed to the additional fee.",
      });

      expect(decided.status).toBe("rejected");
      expect(decided.resultingVersionId).toBeNull();
      const versions = await approverCases.scopeVersions(opened.id);
      expect(versions).toHaveLength(1);
    });
  });

  it("allows only one pending request at a time", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { cases, opened } = await caseWithScope(tx, actor, "E2E One Pending Ltd");

      await cases.requestScopeChange({
        caseId: opened.id,
        reason: "The first request, which is still awaiting a decision.",
        proposedScope: "A slightly wider scope than before.",
      });

      // Two open requests would race to produce version 2, and the second
      // would be approving a scope that no longer exists.
      await expect(
        cases.requestScopeChange({
          caseId: opened.id,
          reason: "A second request raised before the first was decided.",
          proposedScope: "A different wider scope.",
        }),
      ).rejects.toThrow(/awaiting a decision/i);
    });
  });

  it("refuses the database-level self-approval too", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { cases, opened } = await caseWithScope(tx, actor, "E2E Self Approve Ltd");

      const request = await cases.requestScopeChange({
        caseId: opened.id,
        reason: "A request this same person will try to approve.",
        proposedScope: "A wider scope approved by its own author.",
      });

      // The CHECK constraint, independent of the domain rule: the same actor
      // decides their own request.
      await tx`savepoint attempt`;
      let message = "";
      try {
        await cases.decideScopeChange({
          id: request.id,
          approve: true,
          decisionReason: "Approving my own request, which must not be possible.",
        });
      } catch (error) {
        message = (error as Error).message;
      }
      await tx`rollback to savepoint attempt`;
      expect(message).toMatch(/scr_no_self_approval|constraint/i);
    });
  });

  it("withdraws a pending request without deciding it", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { cases, opened } = await caseWithScope(tx, actor, "E2E Withdraw Ltd");

      const request = await cases.requestScopeChange({
        caseId: opened.id,
        reason: "Raised in error and withdrawn before anybody decided it.",
        proposedScope: "A scope nobody will ever approve.",
      });

      const withdrawn = await cases.withdrawScopeChange(
        request.id,
        "Raised against the wrong case.",
      );
      expect(withdrawn.status).toBe("withdrawn");
      expect(withdrawn.approvingOfficer).toBeNull();

      // And a new one can then be raised.
      await expect(
        cases.requestScopeChange({
          caseId: opened.id,
          reason: "The request that should have been raised in the first place.",
          proposedScope: "The scope that was actually wanted.",
        }),
      ).resolves.toBeTruthy();
    });
  });
});

/* ------------------------------------------------------------ assignment */

suite("assignment", () => {
  async function openCase(tx: postgres.TransactionSql, actor: ActorContext, name: string) {
    const { client, engagement } = await seedCaseSubject(tx, actor, name);
    const cases = createCaseRepository(actor, tx);
    const opened = await cases.create({
      title: `${name} case`,
      clientId: client.id,
      engagementId: engagement.id,
      caseType: "due_diligence",
      priority: "medium",
      classification: "CONFIDENTIAL",
    });
    return { cases, opened };
  }

  it("assigns somebody and records who did it", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const investigator = await seedUser(tx, ["investigator"]);
      const actor = actorFor(manager);
      const { cases, opened } = await openCase(tx, actor, "E2E Assign Co Ltd");

      await cases.assign({
        caseId: opened.id,
        userId: investigator,
        role: "lead_investigator",
        reason: "Available and has the sector experience.",
      });

      const assignments = await cases.assignments(opened.id);
      expect(assignments).toHaveLength(1);
      expect(assignments[0].role).toBe("lead_investigator");
      expect(assignments[0].assignedBy).toBe(manager);

      const reloaded = await cases.findById(opened.id);
      expect(reloaded!.assignmentCount).toBe(1);
      expect(reloaded!.leadInvestigatorName).not.toBeNull();
    });
  });

  it("refuses a second lead investigator at the database level", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const first = await seedUser(tx, ["investigator"]);
      const second = await seedUser(tx, ["investigator"]);
      const actor = actorFor(manager);
      const { cases, opened } = await openCase(tx, actor, "E2E Two Leads Ltd");

      await cases.assign({
        caseId: opened.id,
        userId: first,
        role: "lead_investigator",
      });

      // The partial unique index, independent of the domain rule: two leads is
      // the kind of thing that happens through a race, not a mistake.
      await tx`savepoint attempt`;
      let message = "";
      try {
        await cases.assign({
          caseId: opened.id,
          userId: second,
          role: "lead_investigator",
        });
      } catch (error) {
        message = (error as Error).message;
      }
      await tx`rollback to savepoint attempt`;
      expect(message).toMatch(/case_one_lead_idx|duplicate key/i);
    });
  });

  it("allows several supporting investigators", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const actor = actorFor(manager);
      const { cases, opened } = await openCase(tx, actor, "E2E Many Hands Ltd");

      for (let i = 0; i < 3; i += 1) {
        const who = await seedUser(tx, ["investigator"]);
        await cases.assign({
          caseId: opened.id,
          userId: who,
          role: "supporting_investigator",
        });
      }

      expect(await cases.assignments(opened.id)).toHaveLength(3);
    });
  });

  it("keeps the history when somebody comes off a case", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const investigator = await seedUser(tx, ["investigator"]);
      const actor = actorFor(manager);
      const { cases, opened } = await openCase(tx, actor, "E2E History Co Ltd");

      const assignment = await cases.assign({
        caseId: opened.id,
        userId: investigator,
        role: "analyst",
      });
      await cases.unassign(assignment.id, "Moved to another case.");

      // Gone from the live list.
      expect(await cases.assignments(opened.id)).toHaveLength(0);
      // Still answerable: "who was on this case in March".
      const historic = await cases.assignments(opened.id, true);
      expect(historic).toHaveLength(1);
      expect(historic[0].unassignedAt).not.toBeNull();
      expect(historic[0].unassignReason).toBe("Moved to another case.");
    });
  });

  it("refuses to assign somebody without platform access", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const actor = actorFor(manager);
      const { cases, opened } = await openCase(tx, actor, "E2E No Access Ltd");

      const [{ id: stranger }] = await tx<{ id: string }[]>`
        select extensions.gen_random_uuid() as id
      `;

      await expect(
        cases.assign({
          caseId: opened.id,
          userId: stranger,
          role: "analyst",
        }),
      ).rejects.toThrow(/does not have access/i);
    });
  });

  it("refuses to assign a suspended account", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const suspended = await seedUser(tx, ["investigator"]);
      await tx`update iam.users set status = 'suspended' where id = ${suspended}::uuid`;
      const actor = actorFor(manager);
      const { cases, opened } = await openCase(tx, actor, "E2E Suspended Assign Ltd");

      await expect(
        cases.assign({ caseId: opened.id, userId: suspended, role: "analyst" }),
      ).rejects.toThrow(/suspended/i);
    });
  });
});

/* ------------------------------------------------------- communications */

suite("case communications (PRD 5.5)", () => {
  it("logs a material communication and keeps it in order", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E Comms Co Ltd");
      const cases = createCaseRepository(actor, tx);
      const opened = await cases.create({
        title: "Communicating case",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "due_diligence",
        priority: "medium",
        classification: "CONFIDENTIAL",
      });

      await cases.logCommunication({
        caseId: opened.id,
        direction: "inbound",
        kind: "instruction",
        channel: "email",
        sender: "ama@client.example",
        recipient: "ops@primaddc.com",
        subject: "Initial instruction",
        body: "Please proceed as discussed.",
        classification: "CONFIDENTIAL",
        occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
      });
      await cases.logCommunication({
        caseId: opened.id,
        direction: "outbound",
        kind: "status_update",
        channel: "email",
        sender: "ops@primaddc.com",
        recipient: "ama@client.example",
        subject: "Week one update",
        classification: "CONFIDENTIAL",
      });

      const log = await cases.communications(opened.id);
      expect(log).toHaveLength(2);
      // Newest first, which is how a log is read.
      expect(log[0].subject).toBe("Week one update");
      expect(log[1].kind).toBe("instruction");
    });
  });

  it("soft-deletes rather than erasing, because it is a record", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E Comms Del Ltd");
      const cases = createCaseRepository(actor, tx);
      const opened = await cases.create({
        title: "Case with a removed note",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "due_diligence",
        priority: "low",
        classification: "CONFIDENTIAL",
      });

      const entry = await cases.logCommunication({
        caseId: opened.id,
        direction: "internal",
        kind: "other",
        channel: "other",
        sender: "a",
        recipient: "b",
        subject: "Logged against the wrong case",
        classification: "CONFIDENTIAL",
      });

      await cases.removeCommunication(entry.id, "Logged against the wrong case.");
      expect(await cases.communications(opened.id)).toHaveLength(0);

      const rows = await tx<{ deleted_at: string | null }[]>`
        select deleted_at from casework.case_communications where id = ${entry.id}::uuid
      `;
      expect(rows[0].deleted_at).not.toBeNull();
    });
  });
});

/* --------------------------------------------------------------- summary */

suite("the case summary", () => {
  it("counts what the case list header reports", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const investigator = await seedUser(tx, ["investigator"]);
      const actor = actorFor(manager);
      const { client, engagement } = await seedCaseSubject(tx, actor, "E2E Summary Ltd");
      const cases = createCaseRepository(actor, tx);

      const before = await cases.summary(investigator);

      const mine = await cases.create({
        title: "Assigned to the investigator",
        clientId: client.id,
        engagementId: engagement.id,
        caseType: "due_diligence",
        priority: "medium",
        classification: "CONFIDENTIAL",
        openedAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        targetCompletionAt: new Date(Date.now() - 86_400_000).toISOString(),
      });
      await cases.assign({
        caseId: mine.id,
        userId: investigator,
        role: "lead_investigator",
      });

      const after = await cases.summary(investigator);
      expect(after.total).toBe(before.total + 1);
      expect(after.open).toBe(before.open + 1);
      expect(after.mine).toBe(before.mine + 1);
      expect(after.overdue).toBe(before.overdue + 1);
    });
  });

  it("reports a CaseworkError, not a raw database error, for a missing case", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const cases = createCaseRepository(actorFor(user), tx);

      try {
        await cases.softDelete(crypto.randomUUID(), "does not exist");
        throw new Error("should have thrown");
      } catch (error) {
        expect(isCaseworkError(error)).toBe(true);
      }
    });
  });
});

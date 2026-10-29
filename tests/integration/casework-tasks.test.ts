import { afterAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { testSql } from "../helpers/sql";
import { createCaseRepository } from "@/modules/casework/infrastructure/case-repository";
import { createTaskRepository } from "@/modules/casework/infrastructure/task-repository";
import {
  createActivityRepository,
  createPlanRepository,
} from "@/modules/casework/infrastructure/activity-repository";
import { createClientRepository } from "@/modules/crm/infrastructure/client-repository";
import { createEngagementRepository } from "@/modules/crm/infrastructure/engagement-repository";
import {
  assertCorrectionIsUsable,
  assertNoPlanVersionInFlight,
  assertNoTaskCycle,
  assertSubTasksClosed,
} from "@/modules/casework/domain/policies";
import type { ActorContext } from "@/lib/db/client";

/**
 * Tasks, the activity log and investigation plans, against the real Postgres.
 *
 * Everything runs in a transaction that is always rolled back.
 *
 * What is worth proving here rather than in the domain tests is the part only
 * the database can answer: that completed_at cannot disagree with the status,
 * that the activity log genuinely refuses to be edited even by the table
 * owner, that a correction chain is readable in both directions, and that
 * approving a plan version supersedes the previous one in the same breath.
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
            'authenticated', ${`pddc-task-${id}@example.invalid`}, 'fixture', now(), now())
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

/** A case under an approved engagement, which is what tasks hang off. */
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

/* ----------------------------------------------------------------- tasks */

suite("tasks", () => {
  it("allocates a TSK identifier and starts not started", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Task Co Ltd");
      const tasks = createTaskRepository(actor, tx);

      const task = await tasks.create({
        caseId: record.id,
        title: "Obtain the bank statements",
        priority: "high",
        dueDate: "2026-12-01",
      });

      expect(task.taskId).toMatch(/^TSK-\d{4}-\d{6}$/);
      expect(task.status).toBe("not_started");
      expect(task.completedAt).toBeNull();
      expect(task.caseReference).toBe(record.caseId);
      expect(await auditCount(tx, task.id, "task.created")).toBe(1);
    });
  });

  it("files the audit entry against the case, so it joins the case history", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Task Audit Ltd");
      const tasks = createTaskRepository(actor, tx);

      const task = await tasks.create({
        caseId: record.id,
        title: "A task whose audit entry belongs to the case",
        priority: "medium",
      });

      // PRD 9.2: "every task change is audited and appears in the case
      // activity log", which needs case_id set rather than only record_id.
      const rows = await tx<{ n: string }[]>`
        select count(*) as n from audit.audit_log
        where case_id = ${record.id}::uuid and record_id = ${task.id}
      `;
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it("manages completed_at so it cannot disagree with the status", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Completion Ltd");
      const tasks = createTaskRepository(actor, tx);

      const task = await tasks.create({
        caseId: record.id,
        title: "A task that gets completed",
        priority: "medium",
      });

      const started = await tasks.setStatus({ id: task.id, status: "in_progress" });
      expect(started.completedAt).toBeNull();

      const done = await tasks.setStatus({ id: task.id, status: "completed" });
      expect(done.status).toBe("completed");
      expect(done.completedAt).not.toBeNull();
    });
  });

  it("refuses a blocked task with no reason, at the database level", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Blocked Ltd");
      const tasks = createTaskRepository(actor, tx);

      const task = await tasks.create({
        caseId: record.id,
        title: "A task about to be blocked",
        priority: "medium",
      });

      // The CHECK constraint, independent of the domain rule: a blocker
      // nobody wrote down cannot be cleared by anybody else.
      await tx`savepoint attempt`;
      let message = "";
      try {
        await tasks.setStatus({ id: task.id, status: "blocked", reason: null });
      } catch (error) {
        message = (error as Error).message;
      }
      await tx`rollback to savepoint attempt`;
      expect(message).toMatch(/task_status_reason_required|constraint/i);

      // With a reason it goes through.
      const blocked = await tasks.setStatus({
        id: task.id,
        status: "blocked",
        reason: "Waiting on the registry search",
      });
      expect(blocked.statusReason).toBe("Waiting on the registry search");
    });
  });

  it("computes overdue from the due date and the status", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Late Task Ltd");
      const tasks = createTaskRepository(actor, tx);

      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const task = await tasks.create({
        caseId: record.id,
        title: "A task that is already late",
        priority: "high",
        dueDate: yesterday,
      });

      expect(task.isOverdue).toBe(true);
      expect(task.daysToDue).toBeLessThan(0);

      // A completed task is not overdue, however late it was: the work is no
      // longer waiting on anybody.
      const done = await tasks.setStatus({ id: task.id, status: "in_progress" });
      expect(done.isOverdue).toBe(true);
      const closed = await tasks.setStatus({ id: task.id, status: "completed" });
      expect(closed.isOverdue).toBe(false);
    });
  });

  it("keeps a sub-task on its parent's case", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const first = await seedCase(tx, actor, "E2E Parent Case Ltd");
      const second = await seedCase(tx, actor, "E2E Other Case Ltd");
      const tasks = createTaskRepository(actor, tx);

      const parent = await tasks.create({
        caseId: first.id,
        title: "The parent task",
        priority: "medium",
      });

      await expect(
        tasks.create({
          caseId: second.id,
          title: "A sub-task on the wrong case",
          priority: "medium",
          parentTaskId: parent.id,
        }),
      ).rejects.toThrow(/same case as its parent/i);
    });
  });

  it("walks the ancestor chain, which is what refuses a cycle", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Ancestry Ltd");
      const tasks = createTaskRepository(actor, tx);

      const grandparent = await tasks.create({
        caseId: record.id,
        title: "Grandparent",
        priority: "medium",
      });
      const parent = await tasks.create({
        caseId: record.id,
        title: "Parent",
        priority: "medium",
        parentTaskId: grandparent.id,
      });
      const child = await tasks.create({
        caseId: record.id,
        title: "Child",
        priority: "medium",
        parentTaskId: parent.id,
      });

      expect(await tasks.ancestorIds(child.id)).toEqual([parent.id, grandparent.id]);
      expect(await tasks.ancestorIds(grandparent.id)).toEqual([]);

      // Which is what makes the cycle check possible: reparenting the
      // grandparent under its own grandchild would close the loop.
      const ancestorsOfChild = await tasks.ancestorIds(child.id);
      expect(() =>
        assertNoTaskCycle(grandparent.id, child.id, [child.id, ...ancestorsOfChild]),
      ).toThrow();
    });
  });

  it("counts open sub-tasks, which block completing the parent", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Subtasks Ltd");
      const tasks = createTaskRepository(actor, tx);

      const parent = await tasks.create({
        caseId: record.id,
        title: "Parent with children",
        priority: "medium",
      });
      const childA = await tasks.create({
        caseId: record.id,
        title: "Child A",
        priority: "medium",
        parentTaskId: parent.id,
      });
      await tasks.create({
        caseId: record.id,
        title: "Child B",
        priority: "medium",
        parentTaskId: parent.id,
      });

      expect(await tasks.openSubTaskCount(parent.id)).toBe(2);
      expect(() => assertSubTasksClosed(2, "completed")).toThrow();

      await tasks.setStatus({ id: childA.id, status: "in_progress" });
      await tasks.setStatus({ id: childA.id, status: "completed" });
      expect(await tasks.openSubTaskCount(parent.id)).toBe(1);

      // A cancelled child counts as closed: nobody is waiting on it.
      const children = await tasks.list({ parentTaskId: parent.id, openOnly: true });
      await tasks.setStatus({
        id: children.rows[0].id,
        status: "cancelled",
        reason: "No longer needed",
      });
      expect(await tasks.openSubTaskCount(parent.id)).toBe(0);
      expect(() => assertSubTasksClosed(0, "completed")).not.toThrow();
    });
  });

  it("refuses to assign a task to somebody without active access", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const suspended = await seedUser(tx, ["investigator"]);
      await tx`update iam.users set status = 'suspended' where id = ${suspended}::uuid`;
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Suspended Task Ltd");
      const tasks = createTaskRepository(actor, tx);

      await expect(
        tasks.create({
          caseId: record.id,
          title: "A task for a suspended account",
          priority: "medium",
          assignedTo: suspended,
        }),
      ).rejects.toThrow(/suspended/i);
    });
  });

  it("records a reassignment with its reason", async () => {
    await inRolledBackTx(async (tx) => {
      const manager = await seedUser(tx);
      const first = await seedUser(tx, ["investigator"]);
      const second = await seedUser(tx, ["investigator"]);
      const actor = actorFor(manager);
      const record = await seedCase(tx, actor, "E2E Reassign Ltd");
      const tasks = createTaskRepository(actor, tx);

      const task = await tasks.create({
        caseId: record.id,
        title: "A task that changes hands",
        priority: "medium",
        assignedTo: first,
      });

      const moved = await tasks.reassign(task.id, second, "First investigator is on leave");
      expect(moved.assignedTo).toBe(second);
      expect(await auditCount(tx, task.id, "task.reassigned")).toBe(1);

      // And it can be unassigned entirely, which is what leaves it visible on
      // the unassigned filter.
      const freed = await tasks.reassign(task.id, null, "Returning to the pool");
      expect(freed.assignedTo).toBeNull();
    });
  });

  it("counts what the task list header reports", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Task Summary Ltd");
      const tasks = createTaskRepository(actor, tx);

      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      await tasks.create({
        caseId: record.id,
        title: "Overdue and unassigned",
        priority: "high",
        dueDate: yesterday,
      });
      const blocked = await tasks.create({
        caseId: record.id,
        title: "Blocked",
        priority: "medium",
      });
      await tasks.setStatus({
        id: blocked.id,
        status: "blocked",
        reason: "Waiting on the client",
      });

      const summary = await tasks.summary({ caseId: record.id });
      expect(summary.total).toBe(2);
      expect(summary.open).toBe(2);
      expect(summary.overdue).toBe(1);
      expect(summary.blocked).toBe(1);
      expect(summary.unassigned).toBe(2);
    });
  });

  it("holds comments against a task", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Comments Ltd");
      const tasks = createTaskRepository(actor, tx);

      const task = await tasks.create({
        caseId: record.id,
        title: "A task people talk about",
        priority: "medium",
      });

      await tasks.addComment(task.id, "Bank has acknowledged the request.");
      const second = await tasks.addComment(task.id, "Expecting a reply this week.");

      const comments = await tasks.comments(task.id);
      expect(comments).toHaveLength(2);
      // Oldest first: a conversation reads forwards.
      expect(comments[0].body).toMatch(/acknowledged/);

      await tasks.removeComment(second.id, "Posted against the wrong task");
      expect(await tasks.comments(task.id)).toHaveLength(1);

      const reloaded = await tasks.findById(task.id);
      expect(reloaded!.commentCount).toBe(1);
    });
  });

  it("soft-deletes and restores a task", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Task Bin Ltd");
      const tasks = createTaskRepository(actor, tx);

      const task = await tasks.create({
        caseId: record.id,
        title: "A task raised in error",
        priority: "low",
      });

      await tasks.softDelete(task.id, "Raised against the wrong case");
      expect(await tasks.list({ caseId: record.id })).toMatchObject({ total: 0 });
      expect(await tasks.list({ caseId: record.id, onlyDeleted: true })).toMatchObject({
        total: 1,
      });

      await tasks.restore(task.id, "Restored from the recycle bin");
      expect(await tasks.list({ caseId: record.id })).toMatchObject({ total: 1 });
    });
  });
});

/* ------------------------------------------------------------ activities */

suite("the activity log (PRD 9.4)", () => {
  it("records an activity with an ACT identifier", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Activity Ltd");
      const activities = createActivityRepository(actor, tx);

      const entry = await activities.record({
        caseId: record.id,
        activityType: "document_review",
        description: "Reviewed the twelve invoices supplied by the client.",
        location: "Accra office",
        classification: "CONFIDENTIAL",
      });

      expect(entry.activityId).toMatch(/^ACT-\d{4}-\d{6}$/);
      expect(entry.correctsActivityId).toBeNull();
      expect(entry.correctedByActivityId).toBeNull();
      expect(await auditCount(tx, entry.id, "activity.recorded")).toBe(1);
    });
  });

  it("refuses to be edited, even by the table owner", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Append Only Ltd");
      const activities = createActivityRepository(actor, tx);

      const entry = await activities.record({
        caseId: record.id,
        activityType: "interview",
        description: "Interviewed the warehouse supervisor for forty minutes.",
        classification: "CONFIDENTIAL",
      });

      // This connection is `postgres`, which owns the table, so a policy alone
      // would not stop it. The trigger is what makes the log append-only.
      for (const statement of [
        tx`update casework.activities set description = 'rewritten' where id = ${entry.id}::uuid`,
        tx`delete from casework.activities where id = ${entry.id}::uuid`,
      ]) {
        await tx`savepoint attempt`;
        let message = "";
        try {
          await statement;
        } catch (error) {
          message = (error as Error).message;
        }
        await tx`rollback to savepoint attempt`;
        expect(message).toMatch(/append-only/i);
      }
    });
  });

  it("corrects an entry with a new entry, readable in both directions", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Correction Ltd");
      const activities = createActivityRepository(actor, tx);

      const original = await activities.record({
        caseId: record.id,
        activityType: "site_visit",
        description: "Visited the warehouse on 14 October.",
        classification: "CONFIDENTIAL",
      });

      const correction = await activities.correct({
        correctsActivityId: original.id,
        correctionReason: "The visit was on the 15th, not the 14th.",
        activityType: "site_visit",
        description: "Visited the warehouse on 15 October.",
        classification: "CONFIDENTIAL",
      });

      expect(correction.correctsActivityId).toBe(original.id);
      expect(correction.correctsActivityReference).toBe(original.activityId);

      // The original is untouched and says it has been corrected, which is
      // what stops a reader relying on it.
      const reloaded = await activities.findById(original.id);
      expect(reloaded!.description).toContain("14 October");
      expect(reloaded!.correctedByActivityId).toBe(correction.id);
      expect(reloaded!.correctedByReference).toBe(correction.activityId);

      // And the domain rule reads that to refuse a second correction.
      expect(() =>
        assertCorrectionIsUsable(reloaded!, "Trying to correct it again."),
      ).toThrow();
    });
  });

  it("refuses to correct an entry that has already been corrected", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Double Correction Ltd");
      const activities = createActivityRepository(actor, tx);

      const original = await activities.record({
        caseId: record.id,
        activityType: "research",
        description: "Searched the company registry for the three subsidiaries.",
        classification: "CONFIDENTIAL",
      });
      await activities.correct({
        correctsActivityId: original.id,
        correctionReason: "There were four subsidiaries, not three.",
        activityType: "research",
        description: "Searched the company registry for the four subsidiaries.",
        classification: "CONFIDENTIAL",
      });

      await expect(
        activities.correct({
          correctsActivityId: original.id,
          correctionReason: "Correcting the original a second time.",
          activityType: "research",
          description: "A second correction of the same original entry.",
          classification: "CONFIDENTIAL",
        }),
      ).rejects.toThrow(/already been corrected/i);
    });
  });

  it("lists chronologically, newest first", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "E2E Chronology Ltd");
      const activities = createActivityRepository(actor, tx);

      await activities.record({
        caseId: record.id,
        activityType: "research",
        description: "The earlier piece of work, done last week.",
        occurredAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        classification: "CONFIDENTIAL",
      });
      await activities.record({
        caseId: record.id,
        activityType: "analysis",
        description: "The later piece of work, done yesterday.",
        occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
        classification: "CONFIDENTIAL",
      });

      const log = await activities.list({ caseId: record.id });
      expect(log.total).toBe(2);
      expect(log.rows[0].description).toContain("later");
      expect(log.rows[1].description).toContain("earlier");
    });
  });
});

/* -------------------------------------------------- investigation plans */

suite("investigation plans (PRD 9.3)", () => {
  async function planFor(
    tx: postgres.TransactionSql,
    actor: ActorContext,
    name: string,
  ) {
    const record = await seedCase(tx, actor, name);
    const plans = createPlanRepository(actor, tx);
    return { record, plans };
  }

  const draft = {
    objective: "Establish whether the invoices were authorised, and by whom.",
    methodology: "Document review, interviews, and a registry search.",
    sourcesToConsult: ["Company registry", "Bank statements"],
    assignedPersonnel: ["Lead investigator", "Analyst"],
    expectedDeliverables: ["Written report"],
  };

  it("starts at version 1 as a draft", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { record, plans } = await planFor(tx, actor, "E2E Plan Ltd");

      const version = await plans.createVersion({ caseId: record.id, ...draft });
      expect(version.versionNo).toBe(1);
      expect(version.status).toBe("draft");

      const plan = await plans.forCase(record.id);
      expect(plan!.planId).toMatch(/^PLN-\d{4}-\d{6}$/);
      expect(plan!.current).toBeNull();
      expect(plan!.working?.versionNo).toBe(1);
    });
  });

  it("will not start a second version while one is in flight", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const { record, plans } = await planFor(tx, actor, "E2E Plan In Flight Ltd");

      await plans.createVersion({ caseId: record.id, ...draft });
      const plan = await plans.forCase(record.id);

      // Two drafts would race to be version N+1, and the second reviewer would
      // be approving a plan that had already been superseded.
      expect(() => assertNoPlanVersionInFlight(plan!.working)).toThrow(/still a draft/i);
    });
  });

  it("goes draft, submitted, approved, with a second person reviewing", async () => {
    await inRolledBackTx(async (tx) => {
      const author = await seedUser(tx, ["investigator"]);
      const supervisor = await seedUser(tx, ["supervisor"]);
      const { record, plans } = await planFor(tx, actorFor(author), "E2E Plan Flow Ltd");

      const version = await plans.createVersion({ caseId: record.id, ...draft });
      const submitted = await plans.submitVersion(version.id);
      expect(submitted.status).toBe("submitted");
      expect(submitted.submittedBy).toBe(author);

      const supervisorPlans = createPlanRepository(actorFor(supervisor), tx);
      const approved = await supervisorPlans.reviewVersion({
        id: version.id,
        approve: true,
        notes: "Methodology is proportionate to the objective.",
      });

      expect(approved.status).toBe("approved");
      expect(approved.reviewedBy).toBe(supervisor);
      expect(approved.reviewedAt).not.toBeNull();

      const plan = await supervisorPlans.forCase(record.id);
      expect(plan!.current?.versionNo).toBe(1);
      expect(plan!.working).toBeNull();
    });
  });

  it("refuses the self-review at the database level", async () => {
    await inRolledBackTx(async (tx) => {
      const author = await seedUser(tx, ["investigator"]);
      const { record, plans } = await planFor(tx, actorFor(author), "E2E Self Review Ltd");

      const version = await plans.createVersion({ caseId: record.id, ...draft });
      await plans.submitVersion(version.id);

      // plan_no_self_review, independent of the domain rule: PRD 9.3 puts a
      // supervisor in the loop, which is only a loop if it is somebody else.
      await tx`savepoint attempt`;
      let message = "";
      try {
        await plans.reviewVersion({ id: version.id, approve: true, notes: "Fine." });
      } catch (error) {
        message = (error as Error).message;
      }
      await tx`rollback to savepoint attempt`;
      expect(message).toMatch(/plan_no_self_review|constraint/i);
    });
  });

  it("returns a plan with notes, and editing it goes back to draft", async () => {
    await inRolledBackTx(async (tx) => {
      const author = await seedUser(tx, ["investigator"]);
      const supervisor = await seedUser(tx, ["supervisor"]);
      const { record, plans } = await planFor(tx, actorFor(author), "E2E Returned Ltd");

      const version = await plans.createVersion({ caseId: record.id, ...draft });
      await plans.submitVersion(version.id);

      const supervisorPlans = createPlanRepository(actorFor(supervisor), tx);
      const returned = await supervisorPlans.reviewVersion({
        id: version.id,
        approve: false,
        notes: "The methodology does not cover the bank records.",
      });
      expect(returned.status).toBe("returned");
      expect(returned.reviewNotes).toContain("bank records");

      // Editing a returned plan puts it back to draft, so the reviewer's notes
      // stay attached to what they actually reviewed.
      const edited = await plans.updateVersion(version.id, {
        methodology: "Document review, interviews, a registry search and bank records.",
        expectedVersion: returned.version,
      });
      expect(edited.status).toBe("draft");

      // And it can be resubmitted.
      const resubmitted = await plans.submitVersion(version.id);
      expect(resubmitted.status).toBe("submitted");
    });
  });

  it("freezes an approved plan, even against the table owner", async () => {
    await inRolledBackTx(async (tx) => {
      const author = await seedUser(tx, ["investigator"]);
      const supervisor = await seedUser(tx, ["supervisor"]);
      const { record, plans } = await planFor(tx, actorFor(author), "E2E Frozen Plan Ltd");

      const version = await plans.createVersion({ caseId: record.id, ...draft });
      await plans.submitVersion(version.id);
      await createPlanRepository(actorFor(supervisor), tx).reviewVersion({
        id: version.id,
        approve: true,
        notes: "Approved.",
      });

      await tx`savepoint attempt`;
      let message = "";
      try {
        await tx`
          update casework.plan_versions set objective = 'quietly widened'
          where id = ${version.id}::uuid
        `;
      } catch (error) {
        message = (error as Error).message;
      }
      await tx`rollback to savepoint attempt`;
      expect(message).toMatch(/cannot be changed/i);
    });
  });

  it("approving version 2 supersedes version 1 in the same breath", async () => {
    await inRolledBackTx(async (tx) => {
      const author = await seedUser(tx, ["investigator"]);
      const supervisor = await seedUser(tx, ["supervisor"]);
      const { record, plans } = await planFor(tx, actorFor(author), "E2E Plan V2 Ltd");
      const supervisorPlans = createPlanRepository(actorFor(supervisor), tx);

      const first = await plans.createVersion({ caseId: record.id, ...draft });
      await plans.submitVersion(first.id);
      await supervisorPlans.reviewVersion({ id: first.id, approve: true, notes: "Approved." });

      const second = await plans.createVersion({
        caseId: record.id,
        ...draft,
        methodology: "A revised methodology that also covers the bank records.",
      });
      expect(second.versionNo).toBe(2);
      await plans.submitVersion(second.id);
      await supervisorPlans.reviewVersion({
        id: second.id,
        approve: true,
        notes: "The revision is approved.",
      });

      const plan = await supervisorPlans.forCase(record.id);
      // Exactly one approved plan at a time, which is what "the plan" means.
      expect(plan!.current?.versionNo).toBe(2);
      expect(plan!.versions.filter((v) => v.status === "approved")).toHaveLength(1);
      expect(plan!.versions.find((v) => v.versionNo === 1)?.status).toBe("superseded");
    });
  });

  it("has nothing to review on a plan that was never submitted", async () => {
    await inRolledBackTx(async (tx) => {
      const author = await seedUser(tx, ["investigator"]);
      const supervisor = await seedUser(tx, ["supervisor"]);
      const { record, plans } = await planFor(tx, actorFor(author), "E2E Unsubmitted Ltd");

      const version = await plans.createVersion({ caseId: record.id, ...draft });

      await expect(
        createPlanRepository(actorFor(supervisor), tx).reviewVersion({
          id: version.id,
          approve: true,
          notes: "Approving a draft nobody submitted.",
        }),
      ).rejects.toThrow(/nothing to review/i);
    });
  });
});

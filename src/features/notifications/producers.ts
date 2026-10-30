import "server-only";
import type postgres from "postgres";
import type { Actor } from "@/lib/auth/session";
import { notify } from "@/modules/notify";
import type { NotifyInput } from "@/modules/notify";

/**
 * The events that notify somebody (PRD 12.1).
 *
 * One file for all of them, which is the point. A notification written inline
 * in the action that causes it drifts: two actions that assign a task end up
 * phrasing it differently, one of them forgets the link, and the third
 * forgets to notify at all. Here they can be read as a set and compared with
 * PRD 12.1 directly.
 *
 * EVERY FUNCTION TAKES A TRANSACTION, and that is the requirement rather than
 * a convenience. PRD 12.2 asks for a transactional outbox so "no email is
 * lost or sent for a rolled-back action": the notification is written with
 * the change that caused it, so an action that fails announces nothing and
 * one that commits always announces. A producer called after the commit
 * would have neither guarantee.
 *
 * WHAT GOES IN THE EMAIL. Only `caseReference`, `link` and `dueAt` are passed
 * from here. The category's label and the recipient's name are filled by
 * `notify.publish` from the catalogue and the staff directory, so an email
 * cannot disagree with the platform about what a category is called. Nothing
 * else may be passed at all: a title or a subject's name is refused by the
 * domain layer before it reaches the database, and by the database after
 * that.
 *
 * `title` and `detail` are a different matter. They are read in the feed, in
 * the platform, by somebody whose permissions were checked, so they may say
 * what actually happened. That asymmetry is the whole design of PRD 12.2.
 */

type Tx = postgres.TransactionSql;

/** Everything a producer needs to know about the case something is on. */
export interface CaseRef {
  id: string;
  reference: string;
}

async function publish(
  actor: Actor,
  tx: Tx,
  inputs: NotifyInput[],
): Promise<void> {
  const real = inputs.filter((input) => input.recipientId);
  if (real.length === 0) return;

  // Deduplicated by recipient and category: an event with an audience
  // assembled from several assignments can name the same person twice, and
  // being told the same thing twice is worse than being told once.
  const seen = new Set<string>();
  const unique = real.filter((input) => {
    const key = `${input.recipientId}:${input.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await notify(actor, tx).notifyAll(unique);
}

/* ----------------------------------------------------------------- tasks */

export async function notifyTaskAssigned(
  actor: Actor,
  tx: Tx,
  task: {
    id: string;
    taskId: string;
    title: string;
    caseReference: string;
    assignedTo: string | null;
    dueDate: string | null;
  },
): Promise<void> {
  if (!task.assignedTo) return;

  const link = `/tasks/${task.id}`;

  await publish(actor, tx, [
    {
      recipientId: task.assignedTo,
      category: "task_assigned",
      title: `${task.taskId}: ${task.title}`,
      detail: task.dueDate
        ? `On case ${task.caseReference}, due ${task.dueDate}.`
        : `On case ${task.caseReference}.`,
      link,
      email: {
        caseReference: task.caseReference,
        link,
        ...(task.dueDate ? { dueAt: task.dueDate } : {}),
      },
    },
  ]);
}

/* ----------------------------------------------------------------- cases */

export async function notifyCaseAssigned(
  actor: Actor,
  tx: Tx,
  input: {
    userId: string;
    role: string;
    caseRecord: CaseRef & { title: string };
  },
): Promise<void> {
  const link = `/cases/${input.caseRecord.id}`;
  const role = input.role.replace(/_/g, " ");

  await publish(actor, tx, [
    {
      recipientId: input.userId,
      category: "case_assigned",
      title: `You are on ${input.caseRecord.reference} as ${role}`,
      detail: input.caseRecord.title,
      caseId: input.caseRecord.id,
      link,
      email: { caseReference: input.caseRecord.reference, link },
    },
  ]);
}

export async function notifyCaseStageChange(
  actor: Actor,
  tx: Tx,
  input: {
    caseRecord: CaseRef;
    stageName: string;
    audience: string[];
  },
): Promise<void> {
  const link = `/cases/${input.caseRecord.id}`;

  await publish(
    actor,
    tx,
    input.audience.map((recipientId) => ({
      recipientId,
      category: "case_status_change" as const,
      title: `${input.caseRecord.reference} is now at ${input.stageName}`,
      caseId: input.caseRecord.id,
      link,
      email: { caseReference: input.caseRecord.reference, link },
    })),
  );
}

export async function notifyCaseClosed(
  actor: Actor,
  tx: Tx,
  input: { caseRecord: CaseRef; audience: string[] },
): Promise<void> {
  const link = `/cases/${input.caseRecord.id}`;

  await publish(
    actor,
    tx,
    input.audience.map((recipientId) => ({
      recipientId,
      category: "case_closure" as const,
      title: `${input.caseRecord.reference} has been closed`,
      detail: "No further work can be recorded on it without reopening it.",
      caseId: input.caseRecord.id,
      link,
      email: { caseReference: input.caseRecord.reference, link },
    })),
  );
}

/* --------------------------------------------------------------- reports */

/**
 * A report has moved, and somebody has to read it.
 *
 * Two different notifications, because they go to different people for
 * different reasons. A report put forward needs whoever reviews it next; a
 * report sent back needs its author, by name, with the fact that it was
 * returned rather than approved.
 */
export async function notifyReportMoved(
  actor: Actor,
  tx: Tx,
  input: {
    report: { id: string; reportId: string; caseId: string; caseReference: string };
    status: string;
    authorId: string;
    audience: string[];
  },
): Promise<void> {
  const link = `/reports/${input.report.id}`;
  const email = { caseReference: input.report.caseReference, link };

  if (input.status === "draft") {
    // Returned. The author is the only person who can act on it.
    await publish(actor, tx, [
      {
        recipientId: input.authorId,
        category: "report_returned",
        title: `${input.report.reportId} has been returned to you`,
        detail: "The reviewer's note is on the report.",
        caseId: input.report.caseId,
        link,
        email,
      },
    ]);
    return;
  }

  const waiting: Record<string, string> = {
    investigator_review: "an investigator to read",
    supervisor_review: "a supervisor",
    qa_review: "quality assurance",
    approval: "approval",
  };
  const stage = waiting[input.status];
  if (!stage) return;

  await publish(
    actor,
    tx,
    input.audience.map((recipientId) => ({
      recipientId,
      category: "report_review" as const,
      title: `${input.report.reportId} is with ${stage}`,
      caseId: input.report.caseId,
      link,
      email,
    })),
  );
}

/* -------------------------------------------------------------- conflicts */

export async function notifyConflictDetected(
  actor: Actor,
  tx: Tx,
  input: {
    /** The check itself, because the decision is made on the check's screen. */
    checkId: string;
    reference: string;
    matchCount: number;
    audience: string[];
  },
): Promise<void> {
  const link = `/intake/conflicts/${input.checkId}`;

  await publish(
    actor,
    tx,
    input.audience.map((recipientId) => ({
      recipientId,
      category: "conflict_detected" as const,
      title: `${input.matchCount} possible ${
        input.matchCount === 1 ? "conflict" : "conflicts"
      } on ${input.reference}`,
      detail:
        "A screening run found names close enough to existing records to need a decision. Nothing has been merged or cleared.",
      link,
      // No case reference: an enquiry is not a case yet, which is exactly
      // why the conflict has to be decided before it becomes one.
      email: { link },
    })),
  );
}

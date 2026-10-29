"use server";

import { refreshPath } from "@/lib/revalidate";
import { EMPTY_FORM_STATE, invalidForm, type FormState } from "@/lib/forms";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import {
  assertCorrectionIsUsable,
  assertNoPlanVersionInFlight,
  assertNoTaskCycle,
  assertPlanReviewable,
  assertReturnNotes,
  assertSubTasksClosed,
  assertTaskDates,
  assertTaskStatusReason,
  assertTaskTransition,
  casework,
  isCaseworkError,
} from "@/modules/casework";
import { isIamError } from "@/modules/iam";
import {
  correctActivitySchema,
  createPlanVersionSchema,
  createTaskSchema,
  reassignTaskSchema,
  recordActivitySchema,
  removeTaskCommentSchema,
  removeTaskSchema,
  reviewPlanSchema,
  submitPlanSchema,
  taskCommentSchema,
  taskStatusSchema,
  updatePlanVersionSchema,
  updateTaskCommentSchema,
  updateTaskSchema,
} from "./schema";

/**
 * Task, activity and investigation-plan actions (PRD 9).
 *
 * The activity log has no update and no delete action, deliberately: PRD 9.4
 * makes it append-only, so `correctActivity` writes a new entry pointing at
 * the original and there is nothing here that could edit one.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isCaseworkError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("tasks action failed", error);
    return {
      ...EMPTY_FORM_STATE,
      error: "Something went wrong saving that. Nothing was changed.",
    };
  }
}

/**
 * Refreshes everywhere a task appears.
 *
 * A task shows on its case page and on the cross-case task list, and the
 * second is the one somebody is usually looking at when they change it.
 */
function revalidateTask(caseRecordId?: string | null, taskId?: string) {
  refreshPath("/tasks");
  refreshPath("/cases");
  if (caseRecordId) refreshPath(`/cases/${caseRecordId}`);
  if (taskId) refreshPath(`/tasks/${taskId}`);
}

/* ------------------------------------------------------------------ tasks */

export async function createTask(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "tasks", "create");

    const parsed = createTaskSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    assertTaskDates(parsed.data.startDate, parsed.data.dueDate);

    const { caseRecordId, ...input } = parsed.data;
    const task = await casework(actor).tasks.create({ caseId: caseRecordId, ...input });

    revalidateTask(caseRecordId);
    return { ...EMPTY_FORM_STATE, success: `${task.taskId} created.` };
  });
}

export async function updateTask(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "tasks", "edit");

    const parsed = updateTaskSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    assertTaskDates(parsed.data.startDate, parsed.data.dueDate);

    const { taskId, ...input } = parsed.data;
    const api = casework(actor);

    const existing = await api.tasks.findById(taskId);
    if (!existing) {
      return { ...EMPTY_FORM_STATE, error: "That task no longer exists." };
    }

    // Reparenting can close a loop, which a CHECK constraint cannot see.
    if (input.parentTaskId && input.parentTaskId !== existing.parentTaskId) {
      const ancestors = await api.tasks.ancestorIds(input.parentTaskId);
      assertNoTaskCycle(taskId, input.parentTaskId, [input.parentTaskId, ...ancestors]);
    }

    await api.tasks.update(taskId, input);

    revalidateTask(existing.caseId, taskId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

export async function setTaskStatus(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "tasks", "edit");

    const parsed = taskStatusSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { taskId, status, reason } = parsed.data;
    const api = casework(actor);

    const task = await api.tasks.findById(taskId);
    if (!task) {
      return { ...EMPTY_FORM_STATE, error: "That task no longer exists." };
    }

    assertTaskTransition(task.status, status);
    assertTaskStatusReason(status, reason);

    // A parent is not complete while its children are open, or a case can
    // show every parent closed with work still outstanding underneath.
    if (status === "completed") {
      assertSubTasksClosed(await api.tasks.openSubTaskCount(taskId), status);
    }

    const updated = await api.tasks.setStatus({ id: taskId, status, reason });

    revalidateTask(task.caseId, taskId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${updated.taskId} is now ${status.replace(/_/g, " ")}.`,
    };
  });
}

export async function reassignTask(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "tasks", "edit");

    const parsed = reassignTaskSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { taskId, assignedTo, reason } = parsed.data;
    const api = casework(actor);

    const task = await api.tasks.findById(taskId);
    if (!task) {
      return { ...EMPTY_FORM_STATE, error: "That task no longer exists." };
    }

    const updated = await api.tasks.reassign(taskId, assignedTo, reason);

    revalidateTask(task.caseId, taskId);
    return {
      ...EMPTY_FORM_STATE,
      success: updated.assignedToName
        ? `Reassigned to ${updated.assignedToName}.`
        : "Returned to the unassigned pool.",
    };
  });
}

/**
 * Removes a task.
 *
 * Needs tasks:delete, which PRD 16 grants to no role: work is retired by
 * cancelling it with a reason, which keeps the task and the reason on the
 * case. The Administrator's wildcard reaches it, so this is an administrative
 * act, and the reveal policy in migration 0032 is keyed on the same
 * permission: whoever can remove a task can still see it afterwards.
 */
export async function removeTask(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "tasks", "delete");

    const parsed = removeTaskSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = casework(actor);
    const task = await api.tasks.findById(parsed.data.taskId);
    if (!task) {
      return { ...EMPTY_FORM_STATE, error: "That task no longer exists." };
    }

    await api.tasks.softDelete(parsed.data.taskId, parsed.data.reason);

    revalidateTask(task.caseId, parsed.data.taskId);
    refreshPath("/admin/recycle-bin");
    return {
      ...EMPTY_FORM_STATE,
      success:
        "Task removed. If the work simply is not needed, cancelling it with a reason leaves a better record.",
    };
  });
}

export async function restoreTask(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "tasks", "delete");

    const parsed = removeTaskSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = casework(actor);
    const task = await api.tasks.findById(parsed.data.taskId);
    if (!task) {
      return { ...EMPTY_FORM_STATE, error: "That task no longer exists." };
    }

    await api.tasks.restore(parsed.data.taskId, parsed.data.reason);

    revalidateTask(task.caseId, parsed.data.taskId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Task restored." };
  });
}

/* --------------------------------------------------------------- comments */

export async function addTaskComment(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "tasks", "view");

    const parsed = taskCommentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = casework(actor);
    const task = await api.tasks.findById(parsed.data.taskId);
    if (!task) {
      return { ...EMPTY_FORM_STATE, error: "That task no longer exists." };
    }

    await api.tasks.addComment(parsed.data.taskId, parsed.data.body);

    revalidateTask(task.caseId, parsed.data.taskId);
    return { ...EMPTY_FORM_STATE, success: "Comment added." };
  });
}

export async function updateTaskComment(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "tasks", "view");

    const parsed = updateTaskCommentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { commentId, taskId, ...input } = parsed.data;
    const api = casework(actor);
    const task = await api.tasks.findById(taskId);

    // The policy allows only the author to edit their own comment, so this
    // needs no check of its own beyond existence.
    await api.tasks.updateComment(commentId, input);

    revalidateTask(task?.caseId, taskId);
    return { ...EMPTY_FORM_STATE, success: "Comment saved." };
  });
}

export async function removeTaskComment(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "tasks", "view");

    const parsed = removeTaskCommentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = casework(actor);
    const task = await api.tasks.findById(parsed.data.taskId);
    await api.tasks.removeComment(parsed.data.commentId, parsed.data.reason);

    revalidateTask(task?.caseId, parsed.data.taskId);
    return { ...EMPTY_FORM_STATE, success: "Comment removed." };
  });
}

/* ------------------------------------------------------------- activities */

export async function recordActivity(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = recordActivitySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "cases", "edit", parsed.data.classification);

    const { caseRecordId, ...input } = parsed.data;
    const entry = await casework(actor).activities.record({
      caseId: caseRecordId,
      ...input,
    });

    refreshPath(`/cases/${caseRecordId}`);
    return {
      ...EMPTY_FORM_STATE,
      success: `${entry.activityId} recorded. The log is append-only: a mistake is corrected by a new entry.`,
    };
  });
}

/**
 * Corrects an activity by recording a new one that references it (PRD 9.4).
 *
 * There is no action that edits an entry, and there could not be: the database
 * refuses the mutation with a trigger and no policy would let the application
 * reach it.
 */
export async function correctActivity(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = correctActivitySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, correctsActivityId, correctionReason, ...input } = parsed.data;
    const api = casework(actor);

    const original = await api.activities.findById(correctsActivityId);
    assertCorrectionIsUsable(original, correctionReason);

    const correction = await api.activities.correct({
      correctsActivityId,
      correctionReason,
      ...input,
    });

    refreshPath(`/cases/${caseRecordId}`);
    return {
      ...EMPTY_FORM_STATE,
      success: `${correction.activityId} recorded as a correction of ${original!.activityId}. The original stays as it was.`,
    };
  });
}

/* ------------------------------------------------- investigation plans */

export async function createPlanVersion(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = createPlanVersionSchema.safeParse({
      ...Object.fromEntries(formData),
      sourcesToConsult: formData.getAll("source").map(String),
      assignedPersonnel: formData.getAll("personnel").map(String),
      expectedDeliverables: formData.getAll("deliverable").map(String),
    });
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, ...input } = parsed.data;
    const api = casework(actor);

    // Two versions in flight would race to be the next number, and the second
    // reviewer would be approving a plan that had already been superseded.
    const existing = await api.plans.forCase(caseRecordId);
    assertNoPlanVersionInFlight(existing?.working ?? null);

    const version = await api.plans.createVersion({ caseId: caseRecordId, ...input });

    refreshPath(`/cases/${caseRecordId}`);
    return {
      ...EMPTY_FORM_STATE,
      success: `Version ${version.versionNo} drafted. Submit it for a supervisor to review.`,
    };
  });
}

export async function updatePlanVersion(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = updatePlanVersionSchema.safeParse({
      ...Object.fromEntries(formData),
      sourcesToConsult: formData.getAll("source").map(String),
      assignedPersonnel: formData.getAll("personnel").map(String),
      expectedDeliverables: formData.getAll("deliverable").map(String),
    });
    if (!parsed.success) return invalidForm(parsed.error);

    const { versionId, caseRecordId, ...input } = parsed.data;
    await casework(actor).plans.updateVersion(versionId, input);

    refreshPath(`/cases/${caseRecordId}`);
    return { ...EMPTY_FORM_STATE, success: "Plan saved." };
  });
}

export async function submitPlanVersion(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = submitPlanSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const version = await casework(actor).plans.submitVersion(parsed.data.versionId);

    refreshPath(`/cases/${parsed.data.caseRecordId}`);
    return {
      ...EMPTY_FORM_STATE,
      success: `Version ${version.versionNo} submitted. A supervisor other than you has to review it.`,
    };
  });
}

export async function reviewPlanVersion(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    // Reviewing a plan is the supervisor's job, whose distinguishing
    // permission is cases:approve.
    await requirePermission(actor, "cases", "approve");

    const parsed = reviewPlanSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { versionId, caseRecordId, decision, notes } = parsed.data;
    const api = casework(actor);

    const plan = await api.plans.forCase(caseRecordId);
    const version = plan?.versions.find((v) => v.id === versionId);
    if (!version) {
      return { ...EMPTY_FORM_STATE, error: "That plan version no longer exists." };
    }

    if (decision === "approve") {
      // PRD 9.3 puts a supervisor in the loop, which is only a loop if it is
      // somebody else.
      assertPlanReviewable(version, actor.userId);
    } else {
      assertReturnNotes(notes ?? "");
    }

    const reviewed = await api.plans.reviewVersion({
      id: versionId,
      approve: decision === "approve",
      notes,
    });

    refreshPath(`/cases/${caseRecordId}`);
    return {
      ...EMPTY_FORM_STATE,
      success:
        decision === "approve"
          ? `Version ${reviewed.versionNo} approved. It is now the plan in force, and any earlier version is superseded.`
          : `Version ${reviewed.versionNo} returned for changes.`,
    };
  });
}

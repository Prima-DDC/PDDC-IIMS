import "server-only";
import { canAll, requireActor } from "@/lib/auth/session";
import { casework } from "@/modules/casework";
import { evidence } from "@/modules/evidence";
import { classificationLevels, staffDirectory } from "@/lib/reference";

/** Read models for the task, activity and plan screens. */

export async function listTasks(params: {
  caseId?: string;
  search?: string;
  status?: string;
  priority?: string;
  assignedTo?: string;
  mine?: boolean;
  unassignedOnly?: boolean;
  overdueOnly?: boolean;
  openOnly?: boolean;
  sort?: string;
  page?: number;
  perPage?: number;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 50, 200);
  const page = Math.max(params.page ?? 1, 1);

  const api = casework(actor);

  // No status in the URL means "the work that is still outstanding", which is
  // what somebody opening a task list wants to see. An explicit "all" is how
  // they ask for the completed and cancelled ones as well.
  const status =
    !params.status || params.status === "all" ? "all" : params.status;
  const openOnly = params.openOnly ?? !params.status;

  const [result, summary, mine, allowed, directory, openCases] =
    await Promise.all([
      api.tasks.list({
        caseId: params.caseId,
        search: params.search,
        status: status as never,
        openOnly,
        priority: params.priority as never,
        assignedTo: params.mine ? actor.userId : params.assignedTo,
        unassignedOnly: params.unassignedOnly,
        overdueOnly: params.overdueOnly,
        sort: params.sort as never,
        limit: perPage,
        offset: (page - 1) * perPage,
      }),
      // Two summaries, because one cannot be both. Scoping a single summary to
      // this actor would make its "unassigned" count structurally zero: a task
      // cannot be assigned to them and unassigned at the same time.
      api.tasks.summary({ caseId: params.caseId }),
      api.tasks.summary({ caseId: params.caseId, assignedTo: actor.userId }),
      canAll(actor, [
        { resource: "tasks", action: "create" },
        { resource: "tasks", action: "edit" },
      ]),
      staffDirectory(actor),
      // A task cannot exist without a case, so the cross-case screen needs
      // somewhere to put it. RLS already narrows this to cases the actor can
      // reach, so the picker can never offer one they are not on.
      api.cases.list({ openness: "open", limit: 200, sort: "title" }),
    ]);

  return {
    ...result,
    summary,
    /** The same counts, narrowed to this actor, for the "assigned to me" tile. */
    mine,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    people: directory,
    cases: openCases.rows.map((c) => ({
      id: c.id,
      label: `${c.caseId} ${c.title}`,
    })),
    can: {
      create: allowed["tasks:create"],
      edit: allowed["tasks:edit"],
    },
  };
}

/** One task with its comments, for the detail panel. */
export async function getTaskDetail(taskId: string) {
  const actor = await requireActor();

  const api = casework(actor);

  const task = await api.tasks.findById(taskId);
  if (!task) return null;

  const [comments, subTasks, allowed, directory] = await Promise.all([
    api.tasks.comments(taskId),
    api.tasks.list({ parentTaskId: taskId, limit: 50 }),
    canAll(actor, [
      { resource: "tasks", action: "edit" },
      { resource: "tasks", action: "create" },
      { resource: "tasks", action: "delete" },
    ]),
    staffDirectory(actor),
  ]);

  return {
    task,
    comments,
    subTasks: subTasks.rows,
    people: directory,
    /** Whose comments this actor may edit: their own, which the policy enforces. */
    actorId: actor.userId,
    can: {
      edit: allowed["tasks:edit"],
      create: allowed["tasks:create"],
      /**
       * Removal is an administrative act (PRD 16 grants X on tasks to no
       * role), and the policy that reveals a removed task is keyed on the
       * same permission, so offering the form to anybody else would hand
       * them a button whose result they could not see.
       */
      remove: allowed["tasks:delete"],
    },
  };
}

/**
 * The case page's tabs read what their own tab needs, and nothing else.
 *
 * It was one function for all three while they shared one long page, which
 * saved two round trips. Now that the plan, the work and the log are separate
 * tabs (PRD 18, screen 9), reading all three to render one of them would be
 * the opposite trade: three times the queries for a third of the screen.
 */

export async function getCasePlan(caseRecordId: string) {
  const actor = await requireActor();

  const api = casework(actor);

  const [plan, allowed] = await Promise.all([
    api.plans.forCase(caseRecordId),
    canAll(actor, [
      { resource: "cases", action: "edit" },
      { resource: "cases", action: "approve" },
    ]),
  ]);

  return {
    plan,
    /**
     * Whether this actor submitted the version awaiting review, so the screen
     * can say why they cannot review it rather than offering a form the server
     * would refuse.
     */
    isOwnPlanSubmission: plan?.working?.submittedBy === actor.userId,
    can: {
      editCase: allowed["cases:edit"],
      approve: allowed["cases:approve"],
    },
  };
}

export async function getCaseTasks(caseRecordId: string) {
  const actor = await requireActor();

  const api = casework(actor);

  const [tasks, taskSummary, allowed, directory] = await Promise.all([
    api.tasks.list({ caseId: caseRecordId, limit: 200, sort: "due" }),
    api.tasks.summary({ caseId: caseRecordId }),
    canAll(actor, [
      { resource: "tasks", action: "create" },
      { resource: "tasks", action: "edit" },
    ]),
    staffDirectory(actor),
  ]);

  return {
    tasks: tasks.rows,
    taskSummary,
    people: directory,
    can: {
      createTask: allowed["tasks:create"],
      editTask: allowed["tasks:edit"],
    },
  };
}

export async function getCaseActivity(caseRecordId: string) {
  const actor = await requireActor();

  const api = casework(actor);

  const [activities, tasks, allowed, levels] = await Promise.all([
    api.activities.list({ caseId: caseRecordId, limit: 100 }),
    // The task picker on an activity, so what was done can be filed against
    // the work it was done for.
    api.tasks.list({ caseId: caseRecordId, limit: 200, sort: "due" }),
    canAll(actor, [{ resource: "cases", action: "edit" }]),
    classificationLevels(actor),
  ]);

  return {
    activities: activities.rows,
    tasks: tasks.rows,
    levels,
    can: { editCase: allowed["cases:edit"] },
  };
}

/**
 * Two queries, not nine.
 *
 * The tab bar used to ask each repository for its own summary, which meant
 * nine transactions for a row of badges, on every render of the case page
 * including the one every server action triggers behind it. Measured against
 * the live project: this pooler serves the app from a small server pool, so a
 * page asking for nine connections at once queues at the pooler, and a queued
 * client is one the pooler closes mid-transaction. The write still landed and
 * the screen never showed it, which is the worst failure shape there is.
 *
 * Each module now answers its own figures in one statement, which keeps the
 * boundary (no module reads another's tables) and costs two connections.
 */
export async function getCaseTabCounts(caseRecordId: string) {
  const actor = await requireActor();

  const [caseworkCounts, evidenceCounts] = await Promise.all([
    casework(actor).cases.tabCounts(caseRecordId),
    evidence(actor).items.tabCounts(caseRecordId),
  ]);

  return { ...caseworkCounts, ...evidenceCounts };
}

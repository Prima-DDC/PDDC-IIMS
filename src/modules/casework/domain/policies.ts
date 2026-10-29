import { CaseworkError } from "./errors";
import {
  SINGULAR_ASSIGNMENT_ROLES,
  TASK_STATUSES_NEEDING_REASON,
  type AssignmentRole,
  type PlanStatus,
  type RiskLevel,
  type ScopeChangeRequest,
  type TaskStatus,
  type WorkflowStage,
  type WorkflowTransition,
} from "./types";

/**
 * The rules the database cannot express, and the gates PRD 5 says must hold.
 *
 * Pure functions over plain data. The one that looks different from the CRM
 * module's state machines is the transition check: it takes the legal moves as
 * an argument rather than reading them from a constant, because PRD 4.3 makes
 * the lifecycle administrator-configurable. The rule is still enforced in one
 * place; it is the *content* of the rule that is loaded rather than written.
 */

/* --------------------------------------------------- the lifecycle gate */

/**
 * Whether a case may move from where it is to where somebody wants it.
 *
 * `allowed` comes from config.workflow_transitions for the case's current
 * stage, so this function cannot be fooled by a stage key the interface made
 * up, and an administrator who adds a stage does not have to change this code.
 */
export function canTransition(
  allowed: readonly WorkflowTransition[],
  toStageId: string,
): boolean {
  return allowed.some((t) => t.toStageId === toStageId);
}

export function findTransition(
  allowed: readonly WorkflowTransition[],
  toStageId: string,
): WorkflowTransition | undefined {
  return allowed.find((t) => t.toStageId === toStageId);
}

export function assertTransition(
  from: WorkflowStage,
  toStageId: string,
  allowed: readonly WorkflowTransition[],
): WorkflowTransition {
  const transition = findTransition(allowed, toStageId);
  if (transition) return transition;

  if (from.isTerminal) {
    throw new CaseworkError(
      "illegal_transition",
      `A ${from.name.toLowerCase()} case is final and cannot change stage.`,
      { from: from.key },
    );
  }

  if (allowed.length === 0) {
    throw new CaseworkError(
      "illegal_transition",
      `There is no configured move out of "${from.name}". An administrator has to add one.`,
      { from: from.key },
    );
  }

  throw new CaseworkError(
    "illegal_transition",
    `A case at "${from.name}" can only move to: ${allowed
      .map((t) => t.toStageName)
      .join(", ")}.`,
    { from: from.key, to: toStageId, allowed: allowed.map((t) => t.toStageKey) },
  );
}

/** A transition that demands one gets a reason worth reading. */
export function assertTransitionReason(
  transition: WorkflowTransition,
  reason: string | null | undefined,
): void {
  if (!transition.requiresReason) return;
  if ((reason ?? "").trim().length < 5) {
    throw new CaseworkError(
      "validation_failed",
      "Give a reason for the change. Every transition records who moved the case, when, and why (PRD 4.2).",
    );
  }
}

/* --------------------------------------------------- the objective gate */

/**
 * PRD 5.1: "a case cannot be opened without an objective unless an authorised
 * user records an override with reason."
 *
 * "Opened" is read as leaving the first stage: a case can be created as a stub
 * and filled in, but it cannot start moving through the lifecycle without
 * either an objective or a recorded decision that it does not need one. An
 * absent objective and a deliberate override are different facts, and only the
 * second is acceptable, which is why the override is a stored reason rather
 * than a flag.
 */
export function assertObjectiveOrOverride(caseRecord: {
  hasObjective: boolean;
  objectiveOverrideReason: string | null;
  stagePosition: number;
}): void {
  if (caseRecord.hasObjective) return;
  if ((caseRecord.objectiveOverrideReason ?? "").trim().length >= 10) return;

  throw new CaseworkError(
    "objective_required",
    "This case has no objective. Record one, or record an override saying why the case is proceeding without one.",
  );
}

export function assertOverrideReason(reason: string): void {
  if (reason.trim().length < 10) {
    throw new CaseworkError(
      "validation_failed",
      "Give a reason of at least 10 characters. Proceeding without an objective is a decision somebody has to own.",
    );
  }
}

/* -------------------------------------------------------- the risk gate */

/**
 * PRD 5.3: "Critical cases require Operations Manager approval before
 * assignment."
 *
 * Read literally: the gate is on assignment, not on creation, because a case
 * is often rated critical before anybody is put on it. An unassessed case is
 * not blocked, because the rating defaults to medium and demanding an
 * assessment before the first assignment would stop work on routine cases.
 */
export function assertRiskApprovedForAssignment(caseRecord: {
  riskLevel: RiskLevel;
  latestRiskApprovedAt: string | null;
}): void {
  if (caseRecord.riskLevel !== "critical") return;
  if (caseRecord.latestRiskApprovedAt !== null) return;

  throw new CaseworkError(
    "risk_approval_required",
    "This case is rated critical, so the Operations Manager has to approve the risk assessment before anybody is assigned to it.",
  );
}

/**
 * The overall rating is the assessor's judgement, not an average, but it
 * cannot be lower than the worst dimension: a case with a critical safety risk
 * is not an overall low risk, whatever the rationale says.
 */
export function assertOverallRiskIsDefensible(assessment: {
  operationalRisk: RiskLevel;
  legalRisk: RiskLevel;
  reputationalRisk: RiskLevel;
  safetyRisk: RiskLevel;
  sensitivityRisk: RiskLevel;
  overallRisk: RiskLevel;
}): void {
  const rank: Record<RiskLevel, number> = {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };

  const dimensions = [
    assessment.operationalRisk,
    assessment.legalRisk,
    assessment.reputationalRisk,
    assessment.safetyRisk,
    assessment.sensitivityRisk,
  ];
  const worst = dimensions.reduce((a, b) => (rank[a] >= rank[b] ? a : b));

  if (rank[assessment.overallRisk] < rank[worst]) {
    throw new CaseworkError(
      "validation_failed",
      `The overall rating cannot be lower than the highest individual rating, which is ${worst}.`,
      { overall: assessment.overallRisk, worst },
    );
  }
}

/* ------------------------------------------------------- scope control */

/**
 * PRD 5.4: Original Scope -> Change Request -> Reason -> Approval -> Revised
 * Scope, and "the original approved scope is immutable".
 *
 * A change request is approved by somebody other than its requester, which is
 * the same separation of duties the engagement approval gate applies, and for
 * the same reason: a scope change usually costs the client money.
 */
export function assertScopeChangeDecidable(
  request: Pick<ScopeChangeRequest, "status" | "requestedBy">,
  deciderId: string,
): void {
  if (request.status !== "pending") {
    throw new CaseworkError(
      "conflict",
      `This change request is already ${request.status}. Raise a new one if the position has changed.`,
      { status: request.status },
    );
  }
  if (request.requestedBy !== null && request.requestedBy === deciderId) {
    throw new CaseworkError(
      "self_approval_forbidden",
      "You raised this scope change, so somebody else has to decide it.",
    );
  }
}

export function assertScopeChangeReason(reason: string): void {
  if (reason.trim().length < 10) {
    throw new CaseworkError(
      "validation_failed",
      "Say why the scope needs to change, in at least 10 characters. The reason is what the revised scope is justified by.",
    );
  }
}

/* ----------------------------------------------------------- assignment */

/**
 * The roles a case can hold only one of.
 *
 * A partial unique index enforces it, but reaching that produces a constraint
 * name rather than a sentence, and the interface can offer to replace the
 * incumbent instead when it knows in advance.
 */
export function isSingularRole(role: AssignmentRole): boolean {
  return SINGULAR_ASSIGNMENT_ROLES.includes(role);
}

export function assertCanAddAssignment(
  role: AssignmentRole,
  current: ReadonlyArray<{ role: AssignmentRole; userId: string; userName: string }>,
  userId: string,
): void {
  if (current.some((a) => a.userId === userId && a.role === role)) {
    throw new CaseworkError(
      "conflict",
      "That person already holds that role on this case.",
    );
  }

  if (isSingularRole(role)) {
    const incumbent = current.find((a) => a.role === role);
    if (incumbent) {
      throw new CaseworkError(
        "conflict",
        `${incumbent.userName} is already the ${role.replace(/_/g, " ")}. Remove them first, or pick a different role.`,
        { role, incumbent: incumbent.userId },
      );
    }
  }
}

/**
 * A case keeps a lead investigator once it has started.
 *
 * Removing the last one from an active case leaves work nobody owns, which is
 * the situation the platform exists to prevent.
 */
export function assertCanRemoveAssignment(
  assignment: { role: AssignmentRole },
  caseRecord: { stageIsTerminal: boolean; stagePosition: number },
  remaining: ReadonlyArray<{ role: AssignmentRole }>,
): void {
  if (assignment.role !== "lead_investigator") return;
  if (caseRecord.stageIsTerminal) return;

  const anotherLead = remaining.some((a) => a.role === "lead_investigator");
  if (!anotherLead) {
    throw new CaseworkError(
      "conflict",
      "A case that is not closed needs a lead investigator. Assign a replacement first.",
    );
  }
}

/* --------------------------------------------------------- the closure gate */

/**
 * PRD 5.9's checklist, as data rather than prose.
 *
 * "The system blocks closure while any item is incomplete." Returning the
 * list rather than a boolean matters: a closure screen that says "blocked" is
 * useless, and one that says which three of nine things are outstanding is the
 * screen somebody can act on.
 */
export interface ClosureRequirement {
  key: string;
  label: string;
  met: boolean;
  /** What to do about it, when it is not met. */
  remedy: string;
}

export interface ClosureReadiness {
  requirements: ClosureRequirement[];
  outstanding: ClosureRequirement[];
  ready: boolean;
}

export function assessClosureReadiness(state: {
  objectivesAddressed: boolean;
  openTaskCount: number;
  evidenceAccountedFor: boolean;
  reportApproved: boolean;
  deliveryRecorded: boolean;
  outstandingIssuesDocumented: boolean;
  financialStatusRecorded: boolean;
  lessonsLearnedRecorded: boolean;
  retentionClass: string | null;
}): ClosureReadiness {
  const requirements: ClosureRequirement[] = [
    {
      key: "objectives",
      label: "Objectives addressed",
      met: state.objectivesAddressed,
      remedy: "Record against each objective whether it was met, and how.",
    },
    {
      key: "tasks",
      label: "Tasks completed",
      met: state.openTaskCount === 0,
      remedy:
        state.openTaskCount === 1
          ? "1 task is still open. Complete or cancel it."
          : `${state.openTaskCount} tasks are still open. Complete or cancel them.`,
    },
    {
      key: "evidence",
      label: "Evidence accounted for",
      met: state.evidenceAccountedFor,
      remedy: "Every evidence item needs a current custody position.",
    },
    {
      key: "report",
      label: "Report approved",
      met: state.reportApproved,
      remedy: "The final report has to be approved before the case can close.",
    },
    {
      key: "delivery",
      label: "Client delivery recorded",
      met: state.deliveryRecorded,
      remedy: "Record when and how the report reached the client.",
    },
    {
      key: "issues",
      label: "Outstanding issues documented",
      met: state.outstandingIssuesDocumented,
      remedy: "Write down anything unresolved, even if the answer is none.",
    },
    {
      key: "financials",
      label: "Financial status recorded",
      met: state.financialStatusRecorded,
      remedy: "Record the invoiced and paid position.",
    },
    {
      key: "lessons",
      label: "Lessons learned recorded",
      met: state.lessonsLearnedRecorded,
      remedy: "Record what worked, what did not, and what to do differently.",
    },
    {
      key: "retention",
      label: "Retention class selected",
      met: (state.retentionClass ?? "").trim().length > 0,
      remedy: "Choose how long this case is kept.",
    },
  ];

  const outstanding = requirements.filter((r) => !r.met);
  return { requirements, outstanding, ready: outstanding.length === 0 };
}

export function assertClosable(readiness: ClosureReadiness): void {
  if (readiness.ready) return;

  const n = readiness.outstanding.length;
  throw new CaseworkError(
    "closure_blocked",
    `${n} closure requirement${n === 1 ? "" : "s"} ${
      n === 1 ? "is" : "are"
    } outstanding: ${readiness.outstanding.map((r) => r.label).join(", ")}.`,
    { outstanding: readiness.outstanding.map((r) => r.key) },
  );
}

/**
 * PRD 5.9: "Supervisor approves closure."
 *
 * Nobody closes their own case, for the same reason nobody approves their own
 * engagement: the checklist is a self-assessment until somebody else signs it.
 */
export function assertNotClosingOwnWork(
  caseRecord: { leadInvestigatorId: string | null },
  closerId: string,
): void {
  if (caseRecord.leadInvestigatorId === closerId) {
    throw new CaseworkError(
      "self_approval_forbidden",
      "You are the lead investigator on this case, so a supervisor has to approve its closure.",
    );
  }
}

/* ------------------------------------------------------------- creation */

/**
 * A case hangs off an engagement that PDDC has actually committed to.
 *
 * PRD 4.1 runs Engagement Approval before Case Creation, and the engagement is
 * what carries the instruction and the commercial terms. Opening a case under
 * a draft engagement would mean working before the conflict check was decided,
 * which the engagement approval gate exists to prevent.
 */
export function assertEngagementCanCarryCases(engagement: {
  status: string;
  engagementId: string;
}): void {
  if (engagement.status === "approved" || engagement.status === "active") return;

  throw new CaseworkError(
    "engagement_not_active",
    engagement.status === "draft" || engagement.status === "pending_approval"
      ? `${engagement.engagementId} has not been approved yet. An engagement is approved once its conflict check has been decided, and only then can cases be opened against it.`
      : `${engagement.engagementId} is ${engagement.status.replace(/_/g, " ")}, so no new cases can be opened against it.`,
    { status: engagement.status },
  );
}

/** Dates are checked for the message; a CHECK constraint enforces it too. */
export function assertCaseDates(
  openedAt: string | null | undefined,
  targetCompletionAt: string | null | undefined,
): void {
  if (openedAt && targetCompletionAt && targetCompletionAt < openedAt) {
    throw new CaseworkError(
      "validation_failed",
      "The target completion date cannot be before the case was opened.",
    );
  }
}

/* ------------------------------------------------------------- deletion */

export function assertCaseRemovable(caseRecord: {
  stageIsTerminal: boolean;
  stagePosition: number;
  openTaskCount: number;
}): void {
  // A case that has started is cancelled through the lifecycle, not removed:
  // the work done on it has to stay readable.
  if (caseRecord.stagePosition > 40) {
    throw new CaseworkError(
      "in_use",
      "This case has passed assignment, so it cannot be removed. Take it to closure instead, which keeps the work readable.",
    );
  }
  if (caseRecord.openTaskCount > 0) {
    throw new CaseworkError(
      "in_use",
      "Complete or cancel this case's tasks before removing it.",
    );
  }
}

/* ------------------------------------------------- the task state machine */

/**
 * PRD 9.1's task statuses, as transitions.
 *
 * A fixed machine rather than a configurable one: PRD 4.3 makes the CASE
 * lifecycle administrator-configurable and says nothing of the sort about
 * tasks, and five statuses everybody understands are worth more than five that
 * each office has renamed differently.
 *
 * Blocked is reachable from and returnable to the working statuses, because
 * that is what being blocked is. Completed and cancelled are terminal: work
 * that needs doing again is a new task, so the original stays readable as the
 * thing that was closed.
 */
const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  not_started: ["in_progress", "blocked", "cancelled"],
  in_progress: ["blocked", "completed", "cancelled", "not_started"],
  blocked: ["in_progress", "cancelled", "not_started"],
  completed: [],
  cancelled: [],
};

export function allowedTaskTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[from];
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) {
    throw new CaseworkError("illegal_transition", "The task is already at that status.");
  }
  if (!canTransitionTask(from, to)) {
    const allowed = TASK_TRANSITIONS[from];
    throw new CaseworkError(
      "illegal_transition",
      allowed.length === 0
        ? `A ${from.replace(/_/g, " ")} task is closed. If the work needs doing again, raise a new task so this one stays readable.`
        : `A task that is ${from.replace(/_/g, " ")} can only move to: ${allowed
            .map((s) => s.replace(/_/g, " "))
            .join(", ")}.`,
      { from, to, allowed },
    );
  }
}

/**
 * Blocked and cancelled demand a reason (PRD 9.1).
 *
 * A blocked task whose blocker is not written down is just a late task, and a
 * cancelled one without a reason cannot be told apart from an abandoned one.
 */
export function assertTaskStatusReason(
  status: TaskStatus,
  reason: string | null | undefined,
): void {
  if (!TASK_STATUSES_NEEDING_REASON.includes(status)) return;
  if ((reason ?? "").trim().length >= 5) return;

  throw new CaseworkError(
    "validation_failed",
    status === "blocked"
      ? "Say what is blocking this task. A blocker nobody wrote down cannot be cleared by anybody else."
      : "Say why this task was cancelled.",
  );
}

/** Dates are checked here for the message; a CHECK constraint enforces it. */
export function assertTaskDates(
  startDate: string | null | undefined,
  dueDate: string | null | undefined,
): void {
  if (startDate && dueDate && dueDate < startDate) {
    throw new CaseworkError(
      "validation_failed",
      "The due date cannot be before the start date.",
    );
  }
}

/**
 * A sub-task cannot be its own ancestor.
 *
 * A CHECK constraint can only see its own row, so the cycle check happens here
 * with the chain loaded. Without it a task could be made its own grandparent
 * and every walk of the tree would hang.
 */
export function assertNoTaskCycle(
  taskId: string,
  parentTaskId: string | null,
  ancestorsOfParent: readonly string[],
): void {
  if (parentTaskId === null) return;
  if (parentTaskId === taskId) {
    throw new CaseworkError("validation_failed", "A task cannot be its own parent.");
  }
  if (ancestorsOfParent.includes(taskId)) {
    throw new CaseworkError(
      "validation_failed",
      "That would make the task its own ancestor, leaving the sub-task tree with no end.",
    );
  }
}

/**
 * A parent task is not complete while its sub-tasks are open.
 *
 * Otherwise a case shows every parent closed with work still outstanding
 * underneath, which is the kind of thing the closure checklist exists to catch
 * and should not have to.
 */
export function assertSubTasksClosed(openSubTaskCount: number, to: TaskStatus): void {
  if (to !== "completed") return;
  if (openSubTaskCount === 0) return;

  throw new CaseworkError(
    "conflict",
    openSubTaskCount === 1
      ? "This task has 1 open sub-task. Close it first."
      : `This task has ${openSubTaskCount} open sub-tasks. Close them first.`,
    { openSubTaskCount },
  );
}

/* ------------------------------------------------------- the activity log */

/**
 * PRD 9.4: the log is append-only and corrections are new entries referencing
 * the original.
 *
 * So there is no "edit an activity" rule to write. What there is instead is a
 * rule about corrections: one says what it corrects and why, and it cannot
 * correct an entry that has already been corrected, because a chain of
 * corrections to corrections is unreadable and the later one should point at
 * the entry in force.
 */
export function assertCorrectionIsUsable(
  original: { id: string; correctedByActivityId: string | null } | null,
  reason: string,
): void {
  if (original === null) {
    throw new CaseworkError("not_found", "The entry being corrected no longer exists.");
  }
  if (original.correctedByActivityId !== null) {
    throw new CaseworkError(
      "conflict",
      "That entry has already been corrected. Correct the current entry instead, so the log reads as one sequence.",
    );
  }
  if (reason.trim().length < 5) {
    throw new CaseworkError(
      "validation_failed",
      "Say what was wrong with the original entry. The reason is what makes the correction believable.",
    );
  }
}

/* --------------------------------------------- the investigation plan gate */

/**
 * PRD 9.3: Investigator, then supervisor review, then approved or returned.
 *
 * `superseded` is not a status anybody picks: it is what happens to an
 * approved version when a later one is approved.
 */
const PLAN_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ["submitted"],
  submitted: ["approved", "returned"],
  returned: ["submitted"],
  approved: ["superseded"],
  superseded: [],
};

export function allowedPlanTransitions(from: PlanStatus): readonly PlanStatus[] {
  return PLAN_TRANSITIONS[from];
}

export function assertPlanTransition(from: PlanStatus, to: PlanStatus): void {
  if (!PLAN_TRANSITIONS[from].includes(to)) {
    throw new CaseworkError(
      "illegal_transition",
      from === "approved"
        ? "An approved plan cannot be changed. Create the next version, which starts as a draft and needs approval of its own (PRD 9.3)."
        : `A ${from} plan cannot move to ${to}.`,
      { from, to, allowed: PLAN_TRANSITIONS[from] },
    );
  }
}

/**
 * Nobody reviews their own plan.
 *
 * PRD 9.3 puts a supervisor in the loop, which is only a loop if it is
 * somebody else. The database says the same thing in plan_no_self_review; this
 * is here so the message is a sentence.
 */
export function assertPlanReviewable(
  version: { status: PlanStatus; submittedBy: string | null },
  reviewerId: string,
): void {
  assertPlanTransition(version.status, "approved");

  if (version.submittedBy !== null && version.submittedBy === reviewerId) {
    throw new CaseworkError(
      "self_approval_forbidden",
      "You submitted this plan, so a supervisor has to review it.",
    );
  }
}

/** A returned plan says what to fix, or the investigator is guessing. */
export function assertReturnNotes(notes: string): void {
  if (notes.trim().length < 5) {
    throw new CaseworkError(
      "validation_failed",
      "Say what needs to change. A plan returned without notes sends the investigator back to guess.",
    );
  }
}

/**
 * A plan can only be worked on when there is no review outstanding.
 *
 * Two drafts in flight would race to be version N+1, and the second reviewer
 * would be approving a plan that had already been superseded.
 */
export function assertNoPlanVersionInFlight(
  working: { versionNo: number; status: PlanStatus } | null,
): void {
  if (working === null) return;
  throw new CaseworkError(
    "conflict",
    working.status === "submitted"
      ? `Version ${working.versionNo} is awaiting review. It has to be approved or returned before another version is started.`
      : `Version ${working.versionNo} is still a draft. Submit or finish it before starting another.`,
    { versionNo: working.versionNo, status: working.status },
  );
}

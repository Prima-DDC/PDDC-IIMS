"use server";

import { refreshPath } from "@/lib/revalidate";
import { EMPTY_FORM_STATE, invalidForm, type FormState } from "@/lib/forms";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import {
  assertCanAddAssignment,
  assertCanRemoveAssignment,
  assertCaseDates,
  assertCaseRemovable,
  assertEngagementCanCarryCases,
  assertObjectiveOrOverride,
  assertOverallRiskIsDefensible,
  assertOverrideReason,
  assertRiskApprovedForAssignment,
  assertScopeChangeDecidable,
  assertScopeChangeReason,
  assertTransition,
  assertTransitionReason,
  casework,
  isCaseworkError,
} from "@/modules/casework";
import { crm, isCrmError } from "@/modules/crm";
import { isIamError } from "@/modules/iam";
import {
  approveRiskSchema,
  assignSchema,
  createCaseSchema,
  decideScopeChangeSchema,
  logCommunicationSchema,
  moveStageSchema,
  objectiveOverrideSchema,
  removeCaseSchema,
  removeCommunicationSchema,
  riskAssessmentSchema,
  scopeChangeSchema,
  setObjectiveSchema,
  setScopeSchema,
  unassignSchema,
  updateCaseSchema,
  updateCommunicationSchema,
  withdrawScopeChangeSchema,
} from "./schema";

/**
 * Case actions (PRD 5).
 *
 * The same four steps in the same order as every other feature: resolve the
 * actor, check the permission server-side, apply the domain rules, mutate with
 * the audit row in the same transaction.
 *
 * Casework adds a fifth consideration that the others do not have: a
 * transition can carry its own permission requirement, loaded from
 * config.workflow_transitions. `moveStage` therefore checks two permissions,
 * the second of which it does not know until it has read the configuration.
 * That is what makes PRD 4.3's "attach required checks to each stage without
 * code changes" true.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isCaseworkError(error) || isCrmError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("cases action failed", error);
    return {
      ...EMPTY_FORM_STATE,
      error: "Something went wrong saving that. Nothing was changed.",
    };
  }
}

function revalidateCase(caseRecordId?: string) {
  refreshPath("/cases");
  if (caseRecordId) refreshPath(`/cases/${caseRecordId}`);
}

/* ------------------------------------------------------------------- case */

export async function createCase(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "create");

    const parsed = createCaseSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "cases", "create", parsed.data.classification);

    assertCaseDates(parsed.data.openedAt, parsed.data.targetCompletionAt);

    // PRD 4.1 runs Engagement Approval before Case Creation, so the
    // engagement has to be one PDDC has actually committed to. Reading it here
    // rather than trusting the form matters: the form offers approved
    // engagements, but the form is not the control.
    const engagement = await crm(actor).engagements.findById(parsed.data.engagementId);
    if (!engagement) {
      return { ...EMPTY_FORM_STATE, error: "That engagement no longer exists." };
    }
    assertEngagementCanCarryCases(engagement);

    if (engagement.clientId !== parsed.data.clientId) {
      return {
        ...EMPTY_FORM_STATE,
        error: "That engagement belongs to a different client.",
      };
    }

    const opened = await casework(actor).cases.create(parsed.data);

    revalidateCase();
    return {
      ...EMPTY_FORM_STATE,
      success: `${opened.caseId} opened. Record its objective, scope and risk assessment next.`,
    };
  });
}

export async function updateCase(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = updateCaseSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "cases", "edit", parsed.data.classification);

    assertCaseDates(parsed.data.openedAt, parsed.data.targetCompletionAt);

    const { caseRecordId, ...input } = parsed.data;
    await casework(actor).cases.update(caseRecordId, input);

    revalidateCase(caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

/**
 * Moves a case along its lifecycle.
 *
 * Three checks, in this order: the move is configured, the caller holds
 * whatever the move requires, and the case is in a state that permits it. The
 * objective gate applies on the way out of the first stage, which is how PRD
 * 5.1's "a case cannot be opened without an objective" is read: a case can be
 * created as a stub and filled in, but it cannot start moving without one.
 */
export async function moveStage(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = moveStageSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, toStageId, reason } = parsed.data;
    const api = casework(actor);

    const record = await api.cases.findById(caseRecordId);
    if (!record) {
      return { ...EMPTY_FORM_STATE, error: "That case no longer exists." };
    }

    const allowed = await api.workflow.transitionsFrom(record.stageId);
    const from = await api.workflow.stage(record.stageId);
    if (!from) {
      return {
        ...EMPTY_FORM_STATE,
        error: "This case's lifecycle stage no longer exists. An administrator has to repair the lifecycle.",
      };
    }

    const transition = assertTransition(from, toStageId, allowed);
    assertTransitionReason(transition, reason);

    // The permission the configuration attaches to this particular move, which
    // this code does not know until it has read it.
    if (transition.requiredPermission) {
      const [resource, action] = transition.requiredPermission.split(":");
      await requirePermission(actor, resource, action, record.classification);
    }

    // Leaving the first stage is "opening" the case.
    if (from.position <= 10) {
      assertObjectiveOrOverride(record);
    }

    const moved = await api.cases.moveToStage({
      id: caseRecordId,
      toStageId,
      reason: reason ?? null,
    });

    revalidateCase(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${moved.caseId} is now at "${moved.stageName}".`,
    };
  });
}

export async function recordObjectiveOverride(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    // A narrower permission than editing: proceeding without an objective is
    // a decision, not a detail.
    await requirePermission(actor, "cases", "approve");

    const parsed = objectiveOverrideSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    assertOverrideReason(parsed.data.reason);
    await casework(actor).cases.recordObjectiveOverride(
      parsed.data.caseRecordId,
      parsed.data.reason,
    );

    revalidateCase(parsed.data.caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: "Override recorded against your name. The case can now proceed.",
    };
  });
}

export async function removeCase(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "delete");

    const parsed = removeCaseSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, reason } = parsed.data;
    const api = casework(actor);

    const record = await api.cases.findById(caseRecordId);
    if (!record) {
      return { ...EMPTY_FORM_STATE, error: "That case no longer exists." };
    }
    assertCaseRemovable(record);

    await api.cases.softDelete(caseRecordId, reason);

    revalidateCase(caseRecordId);
    refreshPath("/admin/recycle-bin");
    return {
      ...EMPTY_FORM_STATE,
      success: "Case removed. It can be restored from the recycle bin.",
    };
  });
}

export async function restoreCase(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = removeCaseSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await casework(actor).cases.restore(parsed.data.caseRecordId, parsed.data.reason);

    revalidateCase(parsed.data.caseRecordId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Case restored." };
  });
}

/* ------------------------------------------------------------- objectives */

export async function setObjective(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = setObjectiveSchema.safeParse({
      ...Object.fromEntries(formData),
      // Repeated fields, which is what the browser posts for a list.
      questions: formData.getAll("question").map(String),
      deliverables: formData.getAll("deliverable").map(String),
    });
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, ...input } = parsed.data;
    await casework(actor).cases.setObjective({ caseId: caseRecordId, ...input });

    revalidateCase(caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Objective saved." };
  });
}

/* ------------------------------------------------------------------- risk */

export async function addRiskAssessment(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = riskAssessmentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    // A case with a critical safety risk is not an overall low risk, whatever
    // the rationale says.
    assertOverallRiskIsDefensible(parsed.data);

    const { caseRecordId, ...input } = parsed.data;
    const assessment = await casework(actor).cases.addRiskAssessment({
      caseId: caseRecordId,
      ...input,
    });

    revalidateCase(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success:
        assessment.overallRisk === "critical"
          ? "Assessment recorded. A critical case needs the Operations Manager to approve it before anybody is assigned."
          : "Assessment recorded.",
    };
  });
}

export async function approveRiskAssessment(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    // PRD 5.3 names the Operations Manager, whose distinguishing permission is
    // cases:approve.
    await requirePermission(actor, "cases", "approve");

    const parsed = approveRiskSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await casework(actor).cases.approveRiskAssessment(parsed.data.assessmentId);

    revalidateCase(parsed.data.caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: "Risk assessment approved. The case can now be assigned.",
    };
  });
}

/* ------------------------------------------------------------------ scope */

export async function setOriginalScope(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = setScopeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, ...input } = parsed.data;
    await casework(actor).cases.setOriginalScope({ caseId: caseRecordId, ...input });

    revalidateCase(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success:
        "Scope recorded as version 1. It is immutable from here: changes go through a scope change request.",
    };
  });
}

export async function requestScopeChange(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = scopeChangeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    assertScopeChangeReason(parsed.data.reason);

    const { caseRecordId, ...input } = parsed.data;
    const request = await casework(actor).cases.requestScopeChange({
      caseId: caseRecordId,
      ...input,
    });

    revalidateCase(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${request.changeId} raised. Somebody other than you has to decide it.`,
    };
  });
}

export async function decideScopeChange(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "approve");

    const parsed = decideScopeChangeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { requestId, caseRecordId, decision, decisionReason } = parsed.data;
    const api = casework(actor);

    const requests = await api.cases.scopeChangeRequests(caseRecordId);
    const request = requests.find((r) => r.id === requestId);
    if (!request) {
      return { ...EMPTY_FORM_STATE, error: "That change request no longer exists." };
    }

    // Nobody decides their own scope change: it usually costs the client
    // money, which is the same reason an engagement needs a second approver.
    assertScopeChangeDecidable(request, actor.userId);

    const decided = await api.cases.decideScopeChange({
      id: requestId,
      approve: decision === "approve",
      decisionReason,
    });

    revalidateCase(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success:
        decision === "approve"
          ? `${decided.changeId} approved. The revised scope is version ${decided.resultingVersionNo ?? "the next one"}, beside the original.`
          : `${decided.changeId} rejected. The scope is unchanged.`,
    };
  });
}

export async function withdrawScopeChange(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = withdrawScopeChangeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await casework(actor).cases.withdrawScopeChange(
      parsed.data.requestId,
      parsed.data.reason,
    );

    revalidateCase(parsed.data.caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Change request withdrawn." };
  });
}

/* ------------------------------------------------------------- assignment */

export async function assignToCase(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    // Assignment is what grants access to a case, so it is its own permission.
    await requirePermission(actor, "cases", "assign");

    const parsed = assignSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, userId, role, reason } = parsed.data;
    const api = casework(actor);

    const record = await api.cases.findById(caseRecordId);
    if (!record) {
      return { ...EMPTY_FORM_STATE, error: "That case no longer exists." };
    }

    // PRD 5.3: a critical case needs the risk approved before anybody is put
    // on it. Read from the assessments rather than from the cached rating, so
    // the approval and the rating cannot disagree.
    const assessments = await api.cases.riskAssessments(caseRecordId);
    assertRiskApprovedForAssignment({
      riskLevel: record.riskLevel,
      latestRiskApprovedAt: assessments[0]?.approvedAt ?? null,
    });

    const current = await api.cases.assignments(caseRecordId);
    assertCanAddAssignment(role, current, userId);

    const assignment = await api.cases.assign({
      caseId: caseRecordId,
      userId,
      role,
      reason,
    });

    revalidateCase(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${assignment.userName} assigned as ${role.replace(/_/g, " ")}.`,
    };
  });
}

export async function unassignFromCase(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "assign");

    const parsed = unassignSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { assignmentId, caseRecordId, reason } = parsed.data;
    const api = casework(actor);

    const record = await api.cases.findById(caseRecordId);
    if (!record) {
      return { ...EMPTY_FORM_STATE, error: "That case no longer exists." };
    }

    const current = await api.cases.assignments(caseRecordId);
    const going = current.find((a) => a.id === assignmentId);
    if (!going) {
      return { ...EMPTY_FORM_STATE, error: "That assignment has already been removed." };
    }

    // An open case keeps a lead investigator: work nobody owns is the
    // situation this platform exists to prevent.
    assertCanRemoveAssignment(
      going,
      record,
      current.filter((a) => a.id !== assignmentId),
    );

    await api.cases.unassign(assignmentId, reason);

    revalidateCase(caseRecordId);
    return { ...EMPTY_FORM_STATE, success: `${going.userName} removed from the case.` };
  });
}

/* --------------------------------------------------------- communications */

export async function logCommunication(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = logCommunicationSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "cases", "edit", parsed.data.classification);

    const { caseRecordId, ...input } = parsed.data;
    await casework(actor).cases.logCommunication({ caseId: caseRecordId, ...input });

    revalidateCase(caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Communication logged." };
  });
}

export async function updateCommunication(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = updateCommunicationSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { communicationId, caseRecordId, ...input } = parsed.data;
    await casework(actor).cases.updateCommunication(communicationId, input);

    revalidateCase(caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

export async function removeCommunication(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = removeCommunicationSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await casework(actor).cases.removeCommunication(
      parsed.data.communicationId,
      parsed.data.reason,
    );

    revalidateCase(parsed.data.caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Entry removed." };
  });
}

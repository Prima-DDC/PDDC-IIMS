"use server";

import { refreshPath } from "@/lib/revalidate";
import { EMPTY_FORM_STATE, invalidForm, type FormState } from "@/lib/forms";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import {
  assertCheckInNote,
  assertIncidentClosableBy,
  assertIncidentResolution,
  assertIncidentTransition,
  assertInjuryDetail,
  assertPoliceReference,
  assertSafetySchedule,
  casework,
  isCaseworkError,
  nextCheckInDue,
} from "@/modules/casework";
import { isIamError } from "@/modules/iam";
import {
  checkInSchema,
  createSafetyPlanSchema,
  incidentStatusSchema,
  reportIncidentSchema,
  updateIncidentSchema,
  updateSafetyPlanSchema,
} from "./schema";

/**
 * Investigator safety actions (PRD 5.8).
 *
 * A check-in is the one action in the platform somebody may need to complete
 * in a hurry, on a phone, with one hand. It therefore asks for nothing it can
 * work out for itself: who is checking in, when, and when the next one falls
 * due all come from the server.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isCaseworkError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("safety action failed", error);
    return {
      ...EMPTY_FORM_STATE,
      error: "Something went wrong saving that. Nothing was changed.",
    };
  }
}

function revalidateSafety(caseRecordId: string) {
  refreshPath("/safety");
  refreshPath(`/cases/${caseRecordId}`);
}

/* ------------------------------------------------------------ the plan */

export async function createSafetyPlan(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = createSafetyPlanSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, ...input } = parsed.data;
    assertSafetySchedule(input.checkInFrequencyHours, input.checkInInstructions);

    await casework(actor).safety.savePlan(caseRecordId, input);

    revalidateSafety(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: "Safety plan recorded. Anybody going to site can see it now.",
    };
  });
}

export async function updateSafetyPlan(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = updateSafetyPlanSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { planId, caseRecordId, expectedVersion, ...input } = parsed.data;
    assertSafetySchedule(input.checkInFrequencyHours, input.checkInInstructions);

    await casework(actor).safety.updatePlan(planId, input, expectedVersion);

    revalidateSafety(caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Safety plan saved." };
  });
}

/* --------------------------------------------------------- check-ins */

export async function recordCheckIn(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    // Checking in needs no more than access to the case: somebody in the
    // field must never be stopped from reporting that they are safe by a
    // permission check they cannot do anything about.
    await requirePermission(actor, "cases", "view");

    const parsed = checkInSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, userId, event, isSafe, ...input } = parsed.data;
    assertCheckInNote(isSafe, input.notes);

    // Logging a check-in on somebody else's behalf is a supervisory act, and
    // the row-level policy says the same thing.
    const subject = userId ?? actor.userId;
    if (subject !== actor.userId) {
      await requirePermission(actor, "cases", "edit");
    }

    const api = casework(actor);
    const plan = await api.safety.planForCase(caseRecordId);
    const occurredAt = new Date().toISOString();

    const recorded = await api.safety.recordCheckIn({
      caseId: caseRecordId,
      userId: subject,
      event,
      occurredAt,
      isSafe,
      // Read from the plan as it stands now, so a later change to the
      // schedule cannot retrospectively make this check-in late.
      nextDueAt: nextCheckInDue(plan, event, occurredAt),
      ...input,
    });

    revalidateSafety(caseRecordId);

    if (!isSafe) {
      return {
        ...EMPTY_FORM_STATE,
        success: `${recorded.checkInId} recorded as NOT safe. Ring the emergency contact now: the platform does not do that for you.`,
      };
    }
    return {
      ...EMPTY_FORM_STATE,
      success:
        event === "check_in"
          ? recorded.nextDueAt
            ? `Checked in. The next check-in is due by ${new Date(
                recorded.nextDueAt,
              ).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.`
            : "Checked in."
          : "Checked out. Nothing further is due.",
    };
  });
}

/* --------------------------------------------------------- incidents */

export async function reportIncident(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = reportIncidentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "cases", "edit", parsed.data.classification);

    const { caseRecordId, ...input } = parsed.data;
    assertInjuryDetail(input.injuries, input.injuryDetail);
    assertPoliceReference(input.policeNotified, input.policeReference);

    const incident = await casework(actor).safety.reportIncident({
      caseId: caseRecordId,
      ...input,
    });

    revalidateSafety(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${incident.incidentId} reported. Tell the supervisor as well: this records it, it does not raise the alarm.`,
    };
  });
}

export async function updateIncident(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = updateIncidentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "cases", "edit", parsed.data.classification);

    const { incidentId, caseRecordId, expectedVersion, ...input } = parsed.data;
    assertInjuryDetail(input.injuries, input.injuryDetail);
    assertPoliceReference(input.policeNotified, input.policeReference);

    await casework(actor).safety.updateIncident(incidentId, input, expectedVersion);

    revalidateSafety(caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Incident report saved." };
  });
}

export async function setIncidentStatus(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "edit");

    const parsed = incidentStatusSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { incidentId, caseRecordId, status, resolution } = parsed.data;
    const api = casework(actor);

    const incident = await api.safety.findIncidentById(incidentId);
    if (!incident) {
      return { ...EMPTY_FORM_STATE, error: "That incident no longer exists." };
    }

    assertIncidentTransition(incident.status, status);
    assertIncidentResolution(status, resolution);
    if (status === "closed") {
      // PRD 16: nobody signs off their own. Whoever an incident happened to,
      // and whoever reported it, are the two people who should not be the
      // ones deciding it is dealt with.
      assertIncidentClosableBy(incident, actor.userId);
    }

    const updated = await api.safety.setIncidentStatus({
      id: incidentId,
      status,
      resolution,
    });

    revalidateSafety(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${updated.incidentId} is now ${status.replace(/_/g, " ")}.`,
    };
  });
}

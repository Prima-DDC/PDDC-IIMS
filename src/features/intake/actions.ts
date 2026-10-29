"use server";

import { refreshPath } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { EMPTY_FORM_STATE, invalidForm, type FormState } from "@/lib/forms";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import {
  assertConflictDecidable,
  assertDeclineReason,
  assertDecisionReason,
  assertEnquiryTransition,
  crm,
  isCrmError,
  screeningTerms,
} from "@/modules/crm";
import { isIamError } from "@/modules/iam";
import {
  assignEnquirySchema,
  createEnquirySchema,
  decideCheckSchema,
  enquiryStageSchema,
  runCheckSchema,
  updateEnquirySchema,
} from "./schema";

/**
 * Intake actions: enquiries and conflict screening (PRD 4.1, 8.3).
 *
 * The two that matter most are `runCheck` and `decideCheck`, and the division
 * between them is the point of PRD 8.3: running a check needs conflicts:view,
 * because anybody screening should be able to see a potential match, while
 * recording the decision needs conflicts:approve, because only an authorised
 * manager clears or declines one. Nothing in either path merges records or
 * decides anything by itself.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isCrmError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("intake action failed", error);
    return {
      ...EMPTY_FORM_STATE,
      error: "Something went wrong saving that. Nothing was changed.",
    };
  }
}

function revalidateEnquiry(enquiryId?: string) {
  refreshPath("/intake");
  if (enquiryId) refreshPath(`/intake/${enquiryId}`);
}

/* --------------------------------------------------------------- enquiries */

export async function createEnquiry(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "create");

    const parsed = createEnquirySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "clients", "create", parsed.data.classification);

    const enquiry = await crm(actor).intake.createEnquiry(parsed.data);

    revalidateEnquiry();
    return {
      ...EMPTY_FORM_STATE,
      success: `Logged as ${enquiry.enquiryId}. Assess it, then run a conflict check.`,
    };
  });
}

export async function updateEnquiry(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = updateEnquirySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "clients", "edit", parsed.data.classification);

    const { enquiryId, ...input } = parsed.data;
    await crm(actor).intake.updateEnquiry(enquiryId, input);

    revalidateEnquiry(enquiryId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

/**
 * Moves an enquiry along the intake pipeline.
 *
 * The state machine lives in the domain layer, so the order of the pipeline is
 * enforced in one place: an enquiry cannot reach "quoted" without having
 * passed through "conflict check", whatever the interface offers.
 */
export async function setEnquiryStage(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = enquiryStageSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { enquiryId, status, reason } = parsed.data;
    const api = crm(actor);

    const enquiry = await api.intake.findEnquiry(enquiryId);
    if (!enquiry) {
      return { ...EMPTY_FORM_STATE, error: "That enquiry no longer exists." };
    }

    assertEnquiryTransition(enquiry.status, status);
    assertDeclineReason(status, reason);

    // Reaching "quoted" means the conflict check is behind us, so refuse if it
    // is not: a quotation implies PDDC is willing to take the work.
    if (status === "quoted" && enquiry.conflictStatus !== "cleared") {
      return {
        ...EMPTY_FORM_STATE,
        error:
          enquiry.conflictStatus === null
            ? "Run a conflict check before quoting."
            : enquiry.conflictStatus === "declined"
              ? "The conflict check was declined, so this enquiry cannot be quoted."
              : "The conflict check has not been cleared yet.",
      };
    }

    const updated = await api.intake.setEnquiryStatus({ id: enquiryId, status, reason });

    revalidateEnquiry(enquiryId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${updated.enquiryId} is now at "${status.replace(/_/g, " ")}".`,
    };
  });
}

export async function assignEnquiry(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "clients", "edit");

    const parsed = assignEnquirySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { enquiryId, assignedTo, reason } = parsed.data;
    await crm(actor).intake.assignEnquiry(enquiryId, assignedTo, reason);

    revalidateEnquiry(enquiryId);
    return {
      ...EMPTY_FORM_STATE,
      success: assignedTo ? "Assigned." : "Assignment cleared.",
    };
  });
}

/* --------------------------------------------------------- conflict checks */

/**
 * Runs a conflict check and stores it.
 *
 * Redirects to the check so the matches are read on a page of their own, which
 * is also the page the decision is recorded on. Storing it is what makes the
 * check reproducible later: an engagement approved on the strength of a
 * clearance must be able to show what was searched for and what came back.
 */
export async function runCheck(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "conflicts", "view");

    const parsed = runCheckSchema.safeParse({
      enquiryId: formData.get("enquiryId") ?? "",
      engagementId: formData.get("engagementId") ?? "",
      clientId: formData.get("clientId") ?? "",
      // De-duplicated and trimmed in the domain layer, so screening the same
      // name twice cannot look like corroboration.
      terms: screeningTerms(formData.getAll("term").map(String)),
      threshold: formData.get("threshold") ?? 0.3,
    });
    if (!parsed.success) return invalidForm(parsed.error);

    const check = await crm(actor).intake.recordCheck({
      enquiryId: parsed.data.enquiryId,
      engagementId: parsed.data.engagementId,
      clientId: parsed.data.clientId,
      terms: parsed.data.terms,
      threshold: parsed.data.threshold,
    });

    refreshPath("/intake/conflicts");
    if (parsed.data.enquiryId) revalidateEnquiry(parsed.data.enquiryId);
    if (parsed.data.clientId) refreshPath(`/clients/${parsed.data.clientId}`);

    // Carried out of the closure as the success message, so the redirect can
    // happen outside the try: redirect() works by throwing.
    return { ...EMPTY_FORM_STATE, success: check.id };
  });

  if (result.success) redirect(`/intake/conflicts/${result.success}`);
  return result;
}

/**
 * Records the manager's decision. Permitted once, and once only.
 *
 * Three independent things enforce that: this check, the trigger in migration
 * 0019, and the absence of any route that could update a decided check. A
 * mistaken decision is corrected by raising a new check, exactly as a mistaken
 * audit entry is corrected by a new entry.
 */
export async function decideCheck(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "conflicts", "approve");

    const parsed = decideCheckSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { checkId, decision, reason } = parsed.data;
    const api = crm(actor);

    const check = await api.intake.findCheck(checkId);
    if (!check) {
      return { ...EMPTY_FORM_STATE, error: "That conflict check no longer exists." };
    }

    assertConflictDecidable(check);
    assertDecisionReason(reason);

    const decided = await api.intake.decideCheck({ id: checkId, decision, reason });

    refreshPath("/intake/conflicts");
    refreshPath(`/intake/conflicts/${checkId}`);
    if (decided.enquiryId) revalidateEnquiry(decided.enquiryId);
    if (decided.clientId) refreshPath(`/clients/${decided.clientId}`);
    if (decided.engagementId) refreshPath(`/engagements/${decided.engagementId}`);

    return {
      ...EMPTY_FORM_STATE,
      success: `Recorded as "${decision.replace(/_/g, " ")}". This decision cannot be changed.`,
    };
  });
}

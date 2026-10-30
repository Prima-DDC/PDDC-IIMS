"use server";

import { refreshPath } from "@/lib/revalidate";
import {
  EMPTY_FORM_STATE,
  invalidForm,
  unexpectedFailure,
  type FormState,
} from "@/lib/forms";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import { ai, ask, isAiError } from "@/modules/ai";
import { isIamError } from "@/modules/iam";
import { createRetrieval } from "./retrieval";
import {
  askSchema,
  decideCaseAiSchema,
  decideSuggestionSchema,
  removeProviderSchema,
  saveProviderSchema,
} from "./schema";

/**
 * AI actions (PRD 22).
 *
 * The error handling is worth reading rather than skimming. An `AiError` is
 * almost always a DECISION rather than a fault: the classification gate
 * refused, no provider is configured, the case is not opted in, a quota is
 * met. Each of those has a sentence written for the person reading it, so the
 * sentence is shown. Only something that is genuinely not one of those gets
 * "something went wrong", because telling somebody that when the real answer
 * is "this case has not been opted in" would send them looking for a fault
 * that does not exist.
 */
function run(work: () => Promise<FormState>, what: string): Promise<FormState> {
  return work().catch((error) => {
    if (isAiError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error(`ai action failed: ${what}`, error);
    return unexpectedFailure(error, what);
  });
}

/* ------------------------------------------------------------ asking */

export async function askAssistant(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "ai", "create");

    const parsed = askSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const result = await ask(actor, {
      caseId: parsed.data.caseRecordId,
      question: parsed.data.question,
      retrieval: createRetrieval(actor),
    });

    refreshPath(`/cases/${parsed.data.caseRecordId}`);

    if (result.outcome === "blocked") {
      // Not an error: the gate did its job, and the reason is on the record.
      return {
        ...EMPTY_FORM_STATE,
        error: result.reason,
      };
    }

    if (result.outcome === "cached") {
      return {
        ...EMPTY_FORM_STATE,
        success:
          "That question has been asked before on this case, so the answer below cost nothing to produce.",
      };
    }

    const withheld = result.withheld.length;
    return {
      ...EMPTY_FORM_STATE,
      success:
        withheld === 0
          ? "Queued. The answer will appear here once a provider has replied, usually within a minute."
          : `Queued. ${withheld} record${withheld === 1 ? "" : "s"} on this case ${
              withheld === 1 ? "was" : "were"
            } withheld because PRD 22.4 keeps anything above INTERNAL inside the platform, so the answer will not be grounded in ${
              withheld === 1 ? "it" : "them"
            }.`,
    };
  }, "asking the assistant");
}

/**
 * Accepting or rejecting a suggestion (PRD 22.3).
 *
 * Accepting does NOT create a finding. It records that a named person judged
 * the suggestion sound, with the model version, which is what PRD 22.3 asks
 * to be audited. Writing the finding is a separate, deliberate act on the
 * findings screen, because a suggestion that became a finding by being
 * approved would be a conclusion the platform drew.
 */
export async function decideSuggestion(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "ai", "view");

    const parsed = decideSuggestionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const job = await ai(actor).jobs.decide({
      id: parsed.data.jobId,
      accept: parsed.data.decision === "accept",
      note: parsed.data.note,
    });

    if (job.caseId) refreshPath(`/cases/${job.caseId}`);

    return {
      ...EMPTY_FORM_STATE,
      success:
        parsed.data.decision === "accept"
          ? "Recorded as accepted. It is not a finding until you write one: open the findings tab and cite the same records."
          : "Recorded as rejected, with your note.",
    };
  }, "recording that decision");
}

/* --------------------------------------------------- AI on or off per case */

export async function decideCaseAi(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    // PRD 22.4 names the Supervisor and the Operations Manager, which is who
    // `ai:approve` is granted to.
    await requirePermission(actor, "ai", "approve");

    const parsed = decideCaseAiSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const enabled = parsed.data.enabled === "on";

    await ai(actor).caseSettings.decide({
      caseId: parsed.data.caseRecordId,
      isEnabled: enabled,
      reason: parsed.data.reason,
      clientConsentRecorded: parsed.data.clientConsent,
      expectedVersion: parsed.data.expectedVersion,
    });

    refreshPath(`/cases/${parsed.data.caseRecordId}`);

    return {
      ...EMPTY_FORM_STATE,
      success: enabled
        ? "AI is on for this case. Only PUBLIC and INTERNAL material will ever leave, with names and identifiers replaced by tokens first."
        : "AI is off for this case. Nothing further will be sent to a provider.",
    };
  }, "recording that decision");
}

/* ------------------------------------------------------------- providers */

export async function saveAiProvider(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "ai", "configure");

    const parsed = saveProviderSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { enabled, ...input } = parsed.data;

    // The database refuses this too, and the CHECK is the guarantee. This is
    // the version that says what to do about it.
    if (enabled && !input.retentionTerms) {
      return {
        ...EMPTY_FORM_STATE,
        error:
          "Record what this provider's terms say about retaining and training on what it receives before enabling it. PRD 22.4 makes that reading the condition of using a free provider at all, because a free tier usually carries no data-processing agreement.",
        fieldErrors: { retentionTerms: "Required before enabling." },
      };
    }

    const saved = await ai(actor).providers.save({ ...input, isEnabled: enabled });

    refreshPath("/admin/ai");

    return {
      ...EMPTY_FORM_STATE,
      success: saved.isEnabled
        ? `${saved.label} is on the allow-list and enabled. Make sure ${saved.apiKeyEnv} is set in the environment.`
        : `${saved.label} is on the allow-list and disabled.`,
    };
  }, "saving that provider");
}

export async function removeAiProvider(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "ai", "configure");

    const parsed = removeProviderSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await ai(actor).providers.remove(parsed.data.key);
    refreshPath("/admin/ai");

    return { ...EMPTY_FORM_STATE, success: "Removed from the allow-list." };
  }, "removing that provider");
}

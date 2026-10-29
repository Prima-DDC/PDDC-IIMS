"use server";

import { refreshPath } from "@/lib/revalidate";
import { EMPTY_FORM_STATE, invalidForm, type FormState } from "@/lib/forms";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import {
  assertEngagementApprovable,
  assertEngagementDates,
  assertEngagementRemovable,
  assertEngagementTransition,
  crm,
  isCrmError,
} from "@/modules/crm";
import { isIamError } from "@/modules/iam";
import {
  createEngagementSchema,
  engagementStatusSchema,
  removeEngagementSchema,
  updateEngagementSchema,
} from "./schema";

/**
 * Engagement actions (PRD 8.2, 8.4).
 *
 * The one that carries the weight is `changeEngagementStatus` when the target
 * is `approved`. Three things must hold, and none of them is a matter of
 * permission: a conflict check has been run and decided, the decision was not
 * "declined", and the approver is not the person who raised it. All three live
 * in assertEngagementApprovable, so they are applied here and testable without
 * a database.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isCrmError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("engagements action failed", error);
    return {
      ...EMPTY_FORM_STATE,
      error: "Something went wrong saving that. Nothing was changed.",
    };
  }
}

function revalidateEngagement(engagementId?: string, clientId?: string) {
  refreshPath("/engagements");
  if (engagementId) refreshPath(`/engagements/${engagementId}`);
  if (clientId) refreshPath(`/clients/${clientId}`);
}

export async function createEngagement(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "engagements", "create");

    const parsed = createEngagementSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    assertEngagementDates(parsed.data.startDate, parsed.data.endDate);
    await requirePermission(actor, "engagements", "create", parsed.data.classification);

    const engagement = await crm(actor).engagements.create(parsed.data);

    revalidateEngagement(engagement.id, engagement.clientId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${engagement.engagementId} created as a draft. Submit it for approval once the scope and terms are settled.`,
    };
  });
}

export async function updateEngagement(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "engagements", "edit");

    const parsed = updateEngagementSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    assertEngagementDates(parsed.data.startDate, parsed.data.endDate);
    await requirePermission(actor, "engagements", "edit", parsed.data.classification);

    const { engagementId, ...input } = parsed.data;
    const engagement = await crm(actor).engagements.update(engagementId, input);

    revalidateEngagement(engagementId, engagement.clientId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

export async function changeEngagementStatus(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();

    const parsed = engagementStatusSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { engagementId, status, reason } = parsed.data;
    const approving = status === "approved";

    // Approving is a different permission from editing, because approval is
    // what commits PDDC to the work (PRD 16).
    await requirePermission(actor, "engagements", approving ? "approve" : "edit");

    const api = crm(actor);
    const engagement = await api.engagements.findById(engagementId);
    if (!engagement) {
      return { ...EMPTY_FORM_STATE, error: "That engagement no longer exists." };
    }

    if (approving) {
      assertEngagementApprovable(engagement, actor.userId);
    } else {
      assertEngagementTransition(engagement.status, status);
    }

    const updated = await api.engagements.setStatus({
      id: engagementId,
      status,
      reason,
      approve: approving,
    });

    revalidateEngagement(engagementId, updated.clientId);
    return {
      ...EMPTY_FORM_STATE,
      success: approving
        ? `${updated.engagementId} approved. Cases can now be opened against it.`
        : `${updated.engagementId} is now ${status.replace(/_/g, " ")}.`,
    };
  });
}

export async function removeEngagement(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "engagements", "delete");

    const parsed = removeEngagementSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { engagementId, reason } = parsed.data;
    const api = crm(actor);

    const engagement = await api.engagements.findById(engagementId);
    if (!engagement) {
      return { ...EMPTY_FORM_STATE, error: "That engagement no longer exists." };
    }

    // An engagement with cases under it is cancelled rather than removed, so
    // the cases keep something to point at.
    assertEngagementRemovable(engagement);

    await api.engagements.softDelete(engagementId, reason);

    revalidateEngagement(engagementId, engagement.clientId);
    refreshPath("/admin/recycle-bin");
    return {
      ...EMPTY_FORM_STATE,
      success: "Engagement removed. It can be restored from the recycle bin.",
    };
  });
}

export async function restoreEngagement(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "engagements", "edit");

    const parsed = removeEngagementSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { engagementId, reason } = parsed.data;
    await crm(actor).engagements.restore(engagementId, reason);

    revalidateEngagement(engagementId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Engagement restored." };
  });
}

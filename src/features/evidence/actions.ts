"use server";

import { refreshPath } from "@/lib/revalidate";
import {
  EMPTY_FORM_STATE,
  invalidForm,
  unexpectedFailure,
  type FormState,
} from "@/lib/forms";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import {
  assertCollectedInThePast,
  assertCollectionRecorded,
  assertCopyIsOfAnOriginal,
  assertCustodyCorrectionUsable,
  assertCustodyPurpose,
  assertEvidenceRemovable,
  assertEvidenceTransition,
  assertMovementHasBothEnds,
  assertOriginalFileImmutable,
  assertStatusMatchesCustody,
  evidence,
  isEvidenceError,
} from "@/modules/evidence";
import { isIamError } from "@/modules/iam";
import {
  attachFileSchema,
  correctCustodySchema,
  custodyEventSchema,
  evidenceStatusSchema,
  registerEvidenceSchema,
  removeEvidenceSchema,
  restoreEvidenceSchema,
  takeWorkingCopySchema,
  updateEvidenceSchema,
} from "./schema";

/**
 * Evidence and chain-of-custody actions (PRD 6).
 *
 * There is no action that edits or deletes a custody event, and there could
 * not be: the database refuses the mutation with a trigger and no policy
 * would let the application reach it. A mistake is put right by recording a
 * correcting event, which is what `correctCustody` does.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isEvidenceError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("evidence action failed", error);
    return unexpectedFailure(error, "saving that");
  }
}

function revalidateEvidence(caseRecordId: string, evidenceRecordId?: string) {
  refreshPath("/evidence");
  refreshPath(`/cases/${caseRecordId}`);
  if (evidenceRecordId) refreshPath(`/evidence/${evidenceRecordId}`);
}

/* ------------------------------------------------------------ the register */

export async function registerEvidence(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "evidence", "create");

    const parsed = registerEvidenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "evidence", "create", parsed.data.classification);

    const { caseRecordId, ...input } = parsed.data;
    assertCollectionRecorded(input);
    assertCollectedInThePast(input.collectedAt, new Date());

    const item = await evidence(actor).items.register({
      caseId: caseRecordId,
      ...input,
    });

    revalidateEvidence(caseRecordId, item.id);
    return {
      ...EMPTY_FORM_STATE,
      success: `${item.evidenceId} registered, and its first custody event recorded.`,
    };
  });
}

export async function updateEvidence(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "evidence", "edit");

    const parsed = updateEvidenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "evidence", "edit", parsed.data.classification);

    const { evidenceRecordId, caseRecordId, expectedVersion, ...input } = parsed.data;
    await evidence(actor).items.update(evidenceRecordId, input, expectedVersion);

    revalidateEvidence(caseRecordId, evidenceRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

/**
 * Takes a working copy of an original (PRD 6.3).
 *
 * The copy inherits the original's type and classification, because a copy of
 * a restricted item is restricted, and it carries its own collection record
 * saying when and how the copy was made.
 */
export async function takeWorkingCopy(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "evidence", "create");

    const parsed = takeWorkingCopySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { originalEvidenceId, caseRecordId, ...input } = parsed.data;
    const api = evidence(actor);

    const original = await api.items.findById(originalEvidenceId);
    if (!original) {
      return { ...EMPTY_FORM_STATE, error: "That original no longer exists." };
    }
    assertCopyIsOfAnOriginal(original);
    await requirePermission(actor, "evidence", "create", original.classification);

    const copy = await api.items.register({
      caseId: caseRecordId,
      evidenceType: original.evidenceType,
      description: input.description,
      collectedBy: actor.userId,
      collectedAt: new Date().toISOString(),
      collectionLocation: `Copied from ${original.evidenceId}`,
      collectionMethod: input.collectionMethod,
      // A copy of a restricted item is restricted: taking a copy is not a way
      // to lower what may be seen.
      classification: original.classification,
      currentCustodian: input.custodian ?? actor.userId,
      copyStatus: "working_copy",
      originalEvidenceId,
    });

    revalidateEvidence(caseRecordId, copy.id);
    return {
      ...EMPTY_FORM_STATE,
      success: `${copy.evidenceId} is a working copy of ${original.evidenceId}. The original stays as it was.`,
    };
  });
}

export async function setEvidenceStatus(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "evidence", "edit");

    const parsed = evidenceStatusSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { evidenceRecordId, caseRecordId, status, custodian, ...movement } =
      parsed.data;
    const api = evidence(actor);

    const item = await api.items.findById(evidenceRecordId);
    if (!item) {
      return { ...EMPTY_FORM_STATE, error: "That evidence item no longer exists." };
    }

    assertEvidenceTransition(item.status, status);

    // A release is a movement, and a movement is a custody event. The rule
    // refuses a status that says released with nobody holding it.
    const needsCustody = status === "released" || status === "returned";
    if (needsCustody) {
      assertStatusMatchesCustody(status, {
        eventType: status === "released" ? "released" : "returned",
        receivedBy: custodian ?? null,
      });
      assertCustodyPurpose(movement.purpose);
      assertMovementHasBothEnds(
        status === "released" ? "released" : "returned",
        item.currentCustodian,
        custodian,
      );
    }

    if (needsCustody) {
      await api.custody.record({
        evidenceItemId: evidenceRecordId,
        eventType: status === "released" ? "released" : "returned",
        releasedBy: item.currentCustodian,
        receivedBy: custodian,
        purpose: movement.purpose ?? "",
        location: movement.location,
        condition: movement.condition,
      });
    }

    const updated = await api.items.setStatus({
      id: evidenceRecordId,
      status,
      custodian: custodian === undefined ? undefined : custodian,
    });

    revalidateEvidence(caseRecordId, evidenceRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${updated.evidenceId} is now ${status.replace(/_/g, " ")}.`,
    };
  });
}

export async function removeEvidence(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    // PRD 16: only the Administrator removes evidence, and the policy that
    // reveals a removed item keys on the same permission, so whoever can
    // remove it can still see it afterwards.
    await requirePermission(actor, "evidence", "delete");

    const parsed = removeEvidenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = evidence(actor);
    const item = await api.items.findById(parsed.data.evidenceRecordId);
    if (!item) {
      return { ...EMPTY_FORM_STATE, error: "That evidence item no longer exists." };
    }
    assertEvidenceRemovable(item, parsed.data.reason);

    await api.items.softDelete(parsed.data.evidenceRecordId, parsed.data.reason);

    revalidateEvidence(parsed.data.caseRecordId, parsed.data.evidenceRecordId);
    refreshPath("/admin/recycle-bin");
    return {
      ...EMPTY_FORM_STATE,
      success:
        "Removed to the recycle bin. Its custody ledger and audit entries stay exactly as they were.",
    };
  });
}

export async function restoreEvidence(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "evidence", "delete");

    const parsed = restoreEvidenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await evidence(actor).items.restore(
      parsed.data.evidenceRecordId,
      parsed.data.reason,
    );

    revalidateEvidence(parsed.data.caseRecordId, parsed.data.evidenceRecordId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Evidence restored." };
  });
}

/* ------------------------------------------------------- chain of custody */

export async function recordCustodyEvent(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "custody", "create");

    const parsed = custodyEventSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { evidenceRecordId, caseRecordId, ...input } = parsed.data;
    assertCustodyPurpose(input.purpose);
    assertMovementHasBothEnds(input.eventType, input.releasedBy, input.receivedBy);

    const event = await evidence(actor).custody.record({
      evidenceItemId: evidenceRecordId,
      ...input,
    });

    revalidateEvidence(caseRecordId, evidenceRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `Recorded. The ledger is append-only: a mistake is put right by a correcting event, never by changing this one.${
        event.receivedByName ? ` ${event.receivedByName} now holds it.` : ""
      }`,
    };
  });
}

export async function correctCustodyEvent(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "custody", "create");

    const parsed = correctCustodySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { correctsEventId, evidenceRecordId, caseRecordId, ...input } = parsed.data;
    const api = evidence(actor);

    const original = await api.custody.findEventById(correctsEventId);
    assertCustodyCorrectionUsable(original, input.correctionReason);
    assertCustodyPurpose(input.purpose);

    await api.custody.correct({ correctsEventId, ...input });

    revalidateEvidence(caseRecordId, evidenceRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success:
        "Correction recorded. The original event stays exactly as it was, which is what makes the ledger worth anything.",
    };
  });
}

/* ------------------------------------------------------------- the file */

/**
 * Records the file the browser has just uploaded, with the hash it computed.
 *
 * The item moves to "awaiting verification": nothing here trusts a hash
 * computed on the client. The server reads the stored object back and
 * computes its own, which is what `verifyEvidence` does.
 */
export async function attachEvidenceFile(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "evidence", "upload");

    const parsed = attachFileSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { evidenceRecordId, caseRecordId, storagePath, ...file } = parsed.data;
    const api = evidence(actor);

    const item = await api.items.findById(evidenceRecordId);
    if (!item) {
      return { ...EMPTY_FORM_STATE, error: "That evidence item no longer exists." };
    }
    assertOriginalFileImmutable(item);

    await api.items.attachFile(evidenceRecordId, {
      ...file,
      storageBucket: item.copyStatus === "original" ? "evidence-originals" : "evidence-copies",
      storagePath,
    });

    revalidateEvidence(caseRecordId, evidenceRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success:
        "File recorded, awaiting verification. The server will read it back and compute its own hash.",
    };
  });
}

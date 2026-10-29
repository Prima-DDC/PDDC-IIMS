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
  assertNotApprovingOwnVersion,
  assertVersionChangeNote,
  assertVersionEditable,
  evidence,
  isEvidenceError,
  nextVersionLabel,
} from "@/modules/evidence";
import { isIamError } from "@/modules/iam";
import {
  addVersionSchema,
  approveVersionSchema,
  createDocumentSchema,
  removeDocumentSchema,
  updateDocumentSchema,
} from "./schema";

/**
 * Case document actions (PRD 7).
 *
 * The rule that shapes all of this is PRD 7.2: an approved version is locked,
 * and a change produces the next version with a recorded reason and needs
 * approving again. So there is no action that replaces a file, and the
 * database refuses it as well through a trigger.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isEvidenceError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("document action failed", error);
    return unexpectedFailure(error, "saving that");
  }
}

function revalidateDocuments(caseRecordId: string, documentRecordId?: string) {
  refreshPath(`/cases/${caseRecordId}`);
  if (documentRecordId) refreshPath(`/documents/${documentRecordId}`);
}

export async function createDocument(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "documents", "create");

    const parsed = createDocumentSchema.safeParse({
      ...Object.fromEntries(formData),
      tags: formData.getAll("tag").map(String),
    });
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "documents", "create", parsed.data.classification);

    const {
      caseRecordId,
      fileName,
      mimeType,
      fileSize,
      sha256,
      storagePath,
      changeNote,
      ...document
    } = parsed.data;

    const created = await evidence(actor).documents.create({
      caseId: caseRecordId,
      ...document,
      version: {
        // The first version is always a draft: approving is a separate,
        // deliberate act by somebody else (PRD 7.2, PRD 16).
        versionLabel: nextVersionLabel(null),
        changeNote,
        fileName,
        mimeType,
        fileSize,
        sha256,
        storageBucket: "documents",
        storagePath,
      },
    });

    revalidateDocuments(caseRecordId, created.id);
    return {
      ...EMPTY_FORM_STATE,
      success: `${created.documentId} filed as ${created.current?.versionLabel}. Somebody other than you has to approve it.`,
    };
  });
}

export async function updateDocument(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "documents", "edit");

    const parsed = updateDocumentSchema.safeParse({
      ...Object.fromEntries(formData),
      tags: formData.getAll("tag").map(String),
    });
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "documents", "edit", parsed.data.classification);

    const { documentRecordId, caseRecordId, expectedVersion, ...input } = parsed.data;
    await evidence(actor).documents.update(
      documentRecordId,
      input,
      expectedVersion,
    );

    revalidateDocuments(caseRecordId, documentRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

/**
 * The next version (PRD 7.2).
 *
 * Replacing an approved version needs a note saying what changed, because the
 * version it replaces is one that somebody signed off and a report may cite.
 */
export async function addDocumentVersion(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "documents", "upload");

    const parsed = addVersionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const {
      documentRecordId,
      caseRecordId,
      intent,
      changeNote,
      fileName,
      mimeType,
      fileSize,
      sha256,
      storagePath,
    } = parsed.data;

    const api = evidence(actor);
    const document = await api.documents.findById(documentRecordId);
    if (!document) {
      return { ...EMPTY_FORM_STATE, error: "That document no longer exists." };
    }

    assertVersionChangeNote(document.current, changeNote);

    const version = await api.documents.addVersion({
      documentId: documentRecordId,
      versionLabel: nextVersionLabel(document.current, intent),
      changeNote,
      fileName,
      mimeType,
      fileSize,
      sha256,
      storageBucket: "documents",
      storagePath,
    });

    revalidateDocuments(caseRecordId, documentRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${version.versionLabel} is now the current version. The one it replaced is still there, with its own approval.`,
    };
  });
}

export async function approveDocumentVersion(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    // Approving a document is the reviewer's act, which is what `approve`
    // distinguishes from being able to edit one.
    await requirePermission(actor, "documents", "edit");

    const parsed = approveVersionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { versionId, documentRecordId, caseRecordId } = parsed.data;
    const api = evidence(actor);

    const versions = await api.documents.versions(documentRecordId);
    const version = versions.find((candidate) => candidate.id === versionId);
    if (!version) {
      return { ...EMPTY_FORM_STATE, error: "That version no longer exists." };
    }

    assertVersionEditable(version);
    // PRD 16: nobody approves their own work.
    assertNotApprovingOwnVersion(version, actor.userId);

    const approved = await api.documents.approveVersion(versionId);

    revalidateDocuments(caseRecordId, documentRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${approved.versionLabel} approved and locked. A change from here is a new version, with a reason and another approval.`,
    };
  });
}

export async function removeDocument(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "documents", "edit");

    const parsed = removeDocumentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await evidence(actor).documents.softDelete(
      parsed.data.documentRecordId,
      parsed.data.reason,
    );

    revalidateDocuments(parsed.data.caseRecordId, parsed.data.documentRecordId);
    refreshPath("/admin/recycle-bin");
    return {
      ...EMPTY_FORM_STATE,
      success:
        "Removed to the recycle bin. Its versions and their files are untouched.",
    };
  });
}

export async function restoreDocument(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "documents", "edit");

    const parsed = removeDocumentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await evidence(actor).documents.restore(
      parsed.data.documentRecordId,
      parsed.data.reason,
    );

    revalidateDocuments(parsed.data.caseRecordId, parsed.data.documentRecordId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Document restored." };
  });
}

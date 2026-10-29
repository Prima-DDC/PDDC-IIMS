import { z } from "zod";
import {
  expectedVersion,
  optionalText,
  optionalUuid,
  reasonField,
  requiredText,
  uuidField,
} from "@/lib/forms";
import { CLASSIFICATION_LEVELS } from "@/modules/iam/shared";
import { DOCUMENT_TYPES } from "@/modules/evidence/shared";

/** Contracts for the case document screens (PRD 7). */

const sha256 = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{64}$/i, "That is not a SHA-256 hash.")
  .transform((v) => v.toLowerCase());

/** The file half of a form, as the upload component posts it. */
const fileFields = {
  fileName: requiredText(400, "The file needs a name."),
  mimeType: requiredText(200, "The file needs a type."),
  fileSize: z.coerce.number().int().min(1, "An empty file is not a document."),
  sha256,
  storagePath: requiredText(1000, "Where the file was stored."),
};

/**
 * Tags, as the form posts them.
 *
 * One field holding "banking, kyc" and several fields each holding one tag
 * both arrive here, so each value is split before it is normalised. Without
 * the split a comma-separated field would become the single tag
 * "banking--kyc", which is the kind of thing nobody notices until a search
 * for "kyc" returns nothing.
 */
const tagList = z
  .array(z.string())
  .default([])
  .transform((values) =>
    values
      .flatMap((value) => value.split(","))
      .map((value) => value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-"))
      .map((value) => value.replace(/^-+|-+$/g, ""))
      .filter((value) => value.length > 0)
      .slice(0, 20),
  );

export const createDocumentSchema = z.object({
  caseRecordId: uuidField,
  folderId: optionalUuid,
  title: requiredText(300, "Give the document a title."),
  documentType: z.enum(DOCUMENT_TYPES),
  classification: z.enum(CLASSIFICATION_LEVELS),
  relatedEvidenceId: optionalUuid,
  relatedTaskId: optionalUuid,
  tags: tagList,
  changeNote: optionalText(2000),
  ...fileFields,
});

export const updateDocumentSchema = z.object({
  documentRecordId: uuidField,
  caseRecordId: uuidField,
  expectedVersion,
  folderId: optionalUuid,
  title: requiredText(300, "Give the document a title."),
  documentType: z.enum(DOCUMENT_TYPES),
  classification: z.enum(CLASSIFICATION_LEVELS),
  relatedEvidenceId: optionalUuid,
  relatedTaskId: optionalUuid,
  tags: tagList,
});

/**
 * The next version of a document (PRD 7.2).
 *
 * `intent` decides the label: a draft steps the minor number, a final one
 * produces the next whole number. The label itself is derived rather than
 * typed, so a document's history cannot acquire two v1.0s.
 */
export const addVersionSchema = z.object({
  documentRecordId: uuidField,
  caseRecordId: uuidField,
  intent: z.enum(["draft", "final"]).default("draft"),
  changeNote: optionalText(2000),
  ...fileFields,
});

export const approveVersionSchema = z.object({
  versionId: uuidField,
  documentRecordId: uuidField,
  caseRecordId: uuidField,
});

export const removeDocumentSchema = z.object({
  documentRecordId: uuidField,
  caseRecordId: uuidField,
  reason: reasonField(5),
});

export { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "@/lib/forms";

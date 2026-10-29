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
import {
  COPY_STATUSES,
  CUSTODY_EVENT_TYPES,
  EVIDENCE_STATUSES,
  EVIDENCE_TYPES,
} from "@/modules/evidence/shared";

/** Contracts for the evidence register and the custody ledger (PRD 6). */

/** A moment, as a datetime-local input posts it. */
const requiredDateTime = z
  .string()
  .trim()
  .min(1, "Say when.")
  .transform((v) => new Date(v).toISOString())
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "Use the date picker.");

const optionalDateTime = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? new Date(v).toISOString() : null));

/** A SHA-256, as the browser's WebCrypto produces it. */
const sha256 = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{64}$/i, "That is not a SHA-256 hash.")
  .transform((v) => v.toLowerCase());

export const registerEvidenceSchema = z.object({
  caseRecordId: uuidField,
  evidenceType: z.enum(EVIDENCE_TYPES),
  description: z
    .string()
    .trim()
    .min(10, "Describe the item, in at least 10 characters.")
    .max(4000),
  exhibitNo: optionalText(40),
  // PRD 6.1 marks all four mandatory: who, when, where and how.
  collectedBy: uuidField,
  collectedAt: requiredDateTime,
  collectionLocation: requiredText(400, "Say where it was collected."),
  collectionMethod: requiredText(400, "Say how it was collected."),
  classification: z.enum(CLASSIFICATION_LEVELS),
  currentCustodian: optionalUuid,
  sourceId: optionalUuid,
});

export const updateEvidenceSchema = z.object({
  evidenceRecordId: uuidField,
  caseRecordId: uuidField,
  expectedVersion,
  evidenceType: z.enum(EVIDENCE_TYPES),
  description: z
    .string()
    .trim()
    .min(10, "Describe the item, in at least 10 characters.")
    .max(4000),
  exhibitNo: optionalText(40),
  collectionLocation: requiredText(400, "Say where it was collected."),
  collectionMethod: requiredText(400, "Say how it was collected."),
  classification: z.enum(CLASSIFICATION_LEVELS),
  sourceId: optionalUuid,
});

/** Taking a working copy of an original (PRD 6.3). */
export const takeWorkingCopySchema = z.object({
  originalEvidenceId: uuidField,
  caseRecordId: uuidField,
  description: z
    .string()
    .trim()
    .min(10, "Say what the copy is for, in at least 10 characters.")
    .max(4000),
  collectionMethod: requiredText(400, "Say how the copy was made."),
  custodian: optionalUuid,
});

export const evidenceStatusSchema = z.object({
  evidenceRecordId: uuidField,
  caseRecordId: uuidField,
  status: z.enum(EVIDENCE_STATUSES),
  custodian: optionalUuid,
  /** A release needs somebody to release it to, which the rule enforces. */
  purpose: optionalText(1000),
  location: optionalText(400),
  condition: optionalText(400),
});

export const removeEvidenceSchema = z.object({
  evidenceRecordId: uuidField,
  caseRecordId: uuidField,
  reason: reasonField(10),
});

export const restoreEvidenceSchema = z.object({
  evidenceRecordId: uuidField,
  caseRecordId: uuidField,
  reason: reasonField(),
});

/* ------------------------------------------------------- chain of custody */

export const custodyEventSchema = z.object({
  evidenceRecordId: uuidField,
  caseRecordId: uuidField,
  eventType: z.enum(CUSTODY_EVENT_TYPES),
  occurredAt: optionalDateTime,
  releasedBy: optionalUuid,
  receivedBy: optionalUuid,
  purpose: requiredText(1000, "Say what the item was moved for."),
  location: optionalText(400),
  condition: optionalText(400),
  confirmation: optionalText(1000),
});

export const correctCustodySchema = z.object({
  correctsEventId: uuidField,
  evidenceRecordId: uuidField,
  caseRecordId: uuidField,
  correctionReason: z
    .string()
    .trim()
    .min(5, "Say what was wrong with the original event.")
    .max(2000),
  eventType: z.enum(CUSTODY_EVENT_TYPES),
  occurredAt: optionalDateTime,
  releasedBy: optionalUuid,
  receivedBy: optionalUuid,
  purpose: requiredText(1000, "Say what the item was moved for."),
  location: optionalText(400),
  condition: optionalText(400),
  confirmation: optionalText(1000),
});

/* ------------------------------------------------------------- the file */

/**
 * Recording a file the browser has just uploaded.
 *
 * The hash is computed in the browser before the upload and declared here.
 * Nothing trusts it: the server computes its own from the stored object and
 * the two are compared (PRD 6.3), which is what `verifyEvidence` is for.
 */
export const attachFileSchema = z.object({
  evidenceRecordId: uuidField,
  caseRecordId: uuidField,
  fileName: requiredText(400, "The file needs a name."),
  fileType: requiredText(200, "The file needs a type."),
  fileSize: z.coerce.number().int().min(1, "An empty file is not evidence."),
  declaredSha256: sha256,
  storagePath: requiredText(1000, "Where the file was stored."),
});

export const verifyEvidenceSchema = z.object({
  evidenceRecordId: uuidField,
  caseRecordId: uuidField,
});

export const copyStatusValues = COPY_STATUSES;

export { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "@/lib/forms";

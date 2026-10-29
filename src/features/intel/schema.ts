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
  ALIAS_TYPES,
  CONFIDENCE_LEVELS,
  ENTITY_TYPES,
  FINDING_LINK_TYPES,
  FINDING_STATUSES,
  INFORMATION_CREDIBILITIES,
  INFORMATION_VERIFICATION_STATUSES,
  MATCH_FLAG_STATUSES,
  MATCH_FLAG_TYPES,
  RELATIONSHIP_TYPES,
  SOURCE_RELIABILITIES,
  SOURCE_TYPES,
  SUBJECT_ROLES,
  VERIFICATION_STATUSES,
} from "@/modules/intel/shared";

/** Contracts for the intelligence screens (PRD 6.4, 8.4, 15). */

const optionalDate = z
  .string()
  .trim()
  .max(10)
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

const requiredDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Give a date.");

/**
 * A percentage, as a form posts it.
 *
 * Empty means "not recorded", which is different from zero: a shareholding
 * of nothing is a statement, and a shareholding whose size is unknown is
 * another.
 */
const optionalPercentage = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.length > 0 ? Number(value) : null))
  .refine(
    (value) => value === null || (Number.isFinite(value) && value >= 0 && value <= 100),
    "A percentage is between 0 and 100.",
  );

/* ------------------------------------------------------------- entities */

const entityFields = {
  entityType: z.enum(ENTITY_TYPES),
  name: requiredText(400, "Give the subject a name."),
  registrationNo: optionalText(100),
  idReference: optionalText(100),
  nationality: optionalText(2),
  country: optionalText(2),
  address: optionalText(1000),
  dateOfBirth: optionalDate,
  incorporatedOn: optionalDate,
  notes: optionalText(4000),
  classification: z.enum(CLASSIFICATION_LEVELS),
};

export const createEntitySchema = z.object({
  ...entityFields,
  /** Present when the subject is being added to a case in the same step. */
  caseRecordId: optionalUuid,
  subjectRole: z.enum(SUBJECT_ROLES).optional(),
  relationshipToCase: optionalText(1000),
});

export const updateEntitySchema = z.object({
  entityRecordId: uuidField,
  expectedVersion,
  ...entityFields,
});

export const entityReasonSchema = z.object({
  entityRecordId: uuidField,
  reason: reasonField(5),
});

export const addAliasSchema = z.object({
  entityRecordId: uuidField,
  alias: requiredText(400, "Give the alias."),
  aliasType: z.enum(ALIAS_TYPES),
  sourceNote: optionalText(500),
});

export const removeAliasSchema = z.object({
  entityRecordId: uuidField,
  aliasId: uuidField,
});

export const revealIdReferenceSchema = z.object({
  entityRecordId: uuidField,
});

/* -------------------------------------------------------- case subjects */

export const addSubjectSchema = z.object({
  caseRecordId: uuidField,
  entityRecordId: uuidField,
  subjectRole: z.enum(SUBJECT_ROLES),
  relationshipToCase: optionalText(1000),
});

export const updateSubjectSchema = z.object({
  caseRecordId: uuidField,
  subjectId: uuidField,
  expectedVersion,
  subjectRole: z.enum(SUBJECT_ROLES),
  relationshipToCase: optionalText(1000),
});

export const removeSubjectSchema = z.object({
  caseRecordId: uuidField,
  subjectId: uuidField,
  reason: reasonField(5),
});

/* --------------------------------------------------------- relationships */

const relationshipFields = {
  relationshipType: z.enum(RELATIONSHIP_TYPES),
  description: optionalText(1000),
  percentage: optionalPercentage,
  heldFrom: optionalDate,
  heldTo: optionalDate,
  sourceId: optionalUuid,
  evidenceItemId: optionalUuid,
  confidence: z.enum(CONFIDENCE_LEVELS),
};

export const createRelationshipSchema = z.object({
  fromEntityId: uuidField,
  toEntityId: uuidField,
  ...relationshipFields,
});

export const updateRelationshipSchema = z.object({
  entityRecordId: uuidField,
  relationshipId: uuidField,
  expectedVersion,
  ...relationshipFields,
});

export const removeRelationshipSchema = z.object({
  entityRecordId: uuidField,
  relationshipId: uuidField,
  reason: reasonField(5),
});

/* ----------------------------------------------- resolution (PRD 8.4) */

export const flagMatchSchema = z.object({
  entityRecordId: uuidField,
  otherEntityId: uuidField,
  flagType: z.enum(MATCH_FLAG_TYPES),
  notes: optionalText(1000),
});

export const decideMatchSchema = z.object({
  entityRecordId: uuidField,
  flagId: uuidField,
  status: z.enum(MATCH_FLAG_STATUSES).refine((value) => value !== "open", {
    message: "Pick a decision.",
  }),
  reason: reasonField(10),
});

export const mergeEntitiesSchema = z.object({
  survivingEntityId: uuidField,
  mergedEntityId: uuidField,
  reason: reasonField(10),
});

export const reverseMergeSchema = z.object({
  entityRecordId: uuidField,
  mergeId: uuidField,
  reason: reasonField(10),
});

/* -------------------------------------------------------------- sources */

const sourceFields = {
  sourceType: z.enum(SOURCE_TYPES),
  description: requiredText(4000, "Say what the source is."),
  sourceReliability: z.enum(SOURCE_RELIABILITIES),
  accessRestrictions: optionalText(1000),
  identityName: optionalText(400),
  identityContact: optionalText(400),
  identityNotes: optionalText(2000),
  classification: z.enum(CLASSIFICATION_LEVELS),
};

export const createSourceSchema = z.object({
  caseRecordId: uuidField,
  dateObtained: requiredDate,
  obtainedBy: uuidField,
  ...sourceFields,
});

export const updateSourceSchema = z.object({
  caseRecordId: uuidField,
  sourceRecordId: uuidField,
  expectedVersion,
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  ...sourceFields,
});

export const sourceReasonSchema = z.object({
  caseRecordId: uuidField,
  sourceRecordId: uuidField,
  reason: reasonField(5),
});

/* ---------------------------------------------------------- information */

export const createInformationSchema = z.object({
  caseRecordId: uuidField,
  sourceRecordId: uuidField,
  dateObtained: requiredDate,
  description: requiredText(8000, "Say what the information is."),
  informationCredibility: z.enum(INFORMATION_CREDIBILITIES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  entityRecordId: optionalUuid,
  classification: z.enum(CLASSIFICATION_LEVELS),
});

export const updateInformationSchema = z.object({
  caseRecordId: uuidField,
  informationRecordId: uuidField,
  expectedVersion,
  description: requiredText(8000, "Say what the information is."),
  informationCredibility: z.enum(INFORMATION_CREDIBILITIES),
  verificationStatus: z.enum(INFORMATION_VERIFICATION_STATUSES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  entityRecordId: optionalUuid,
  classification: z.enum(CLASSIFICATION_LEVELS),
});

export const informationReasonSchema = z.object({
  caseRecordId: uuidField,
  informationRecordId: uuidField,
  reason: reasonField(5),
});

export const addCorroborationSchema = z.object({
  caseRecordId: uuidField,
  informationRecordId: uuidField,
  corroboratingInformationId: uuidField,
  note: optionalText(1000),
});

export const linkInformationEvidenceSchema = z.object({
  caseRecordId: uuidField,
  informationRecordId: uuidField,
  evidenceItemId: uuidField,
  note: optionalText(1000),
});

export const unlinkSchema = z.object({
  caseRecordId: uuidField,
  informationRecordId: uuidField,
  linkId: uuidField,
});

/* ------------------------------------------------------------- findings */

export const createFindingSchema = z.object({
  caseRecordId: uuidField,
  statement: requiredText(4000, "State the finding."),
  detail: optionalText(8000),
  analyst: uuidField,
  confidence: z.enum(CONFIDENCE_LEVELS),
  findingDate: optionalDate,
  classification: z.enum(CLASSIFICATION_LEVELS),
});

export const updateFindingSchema = z.object({
  caseRecordId: uuidField,
  findingRecordId: uuidField,
  expectedVersion,
  statement: requiredText(4000, "State the finding."),
  detail: optionalText(8000),
  confidence: z.enum(CONFIDENCE_LEVELS),
  findingDate: optionalDate,
  classification: z.enum(CLASSIFICATION_LEVELS),
});

export const findingStatusSchema = z.object({
  caseRecordId: uuidField,
  findingRecordId: uuidField,
  status: z.enum(FINDING_STATUSES),
  reviewNotes: optionalText(4000),
});

export const linkFindingSchema = z.object({
  caseRecordId: uuidField,
  findingRecordId: uuidField,
  linkType: z.enum(FINDING_LINK_TYPES),
  targetId: uuidField,
  relevance: optionalText(1000),
});

export const unlinkFindingSchema = z.object({
  caseRecordId: uuidField,
  findingRecordId: uuidField,
  linkId: uuidField,
});

export const findingReasonSchema = z.object({
  caseRecordId: uuidField,
  findingRecordId: uuidField,
  reason: reasonField(5),
});

export { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "@/lib/forms";

import { z } from "zod";
import {
  expectedVersion,
  optionalCountry,
  optionalText,
  optionalUuid,
  reasonField,
  requiredText,
  uuidField,
} from "@/lib/forms";
import { CLASSIFICATION_LEVELS } from "@/modules/iam/shared";
import {
  ASSIGNMENT_ROLES,
  CASE_PRIORITIES,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_DIRECTIONS,
  COMMUNICATION_KINDS,
  RISK_LEVELS,
} from "@/modules/casework/shared";

/**
 * Contracts for the case screens (PRD 5).
 *
 * The case type and the lifecycle stage are NOT enums here, unlike every other
 * vocabulary in this file. Both are administrator-configurable (PRD 4.3, 5.2),
 * so validating them against a list compiled into the bundle would make
 * configuring them impossible. They are validated as identifiers and checked
 * against the database by the repository, which is the only place that knows
 * what is currently configured.
 */

/** An optional ISO date-time, as a datetime-local input posts it. */
const optionalDateTime = z
  .string()
  .trim()
  .min(1)
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? new Date(v).toISOString() : null));

export const caseFields = {
  title: requiredText(200, "Give the case a title."),
  // A key from config.case_types, checked by the foreign key rather than here.
  caseType: z.string().trim().min(1, "Choose a case type.").max(60),
  jurisdictionCountry: optionalCountry,
  jurisdictionRegion: optionalText(120),
  officeId: optionalUuid,
  priority: z.enum(CASE_PRIORITIES),
  openedAt: optionalDateTime,
  targetCompletionAt: optionalDateTime,
  classification: z.enum(CLASSIFICATION_LEVELS),
};

export const createCaseSchema = z.object({
  clientId: uuidField,
  engagementId: uuidField,
  ...caseFields,
});

export const updateCaseSchema = z.object({
  caseRecordId: uuidField,
  expectedVersion,
  ...caseFields,
});

/** Moving along the lifecycle. The target stage is an id, not a name. */
export const moveStageSchema = z.object({
  caseRecordId: uuidField,
  toStageId: uuidField,
  reason: optionalText(1000),
});

export const removeCaseSchema = z.object({
  caseRecordId: uuidField,
  reason: reasonField(),
});

export const objectiveOverrideSchema = z.object({
  caseRecordId: uuidField,
  reason: z
    .string()
    .trim()
    .min(10, "Give a reason of at least 10 characters: this is a decision somebody owns.")
    .max(1000),
});

/* ------------------------------------------------------------ objectives */

/**
 * Questions and deliverables arrive as repeated fields.
 *
 * A browser posts repeated inputs of the same name, which is what the form
 * uses, so the action collects them with formData.getAll rather than parsing
 * an array syntax the browser does not produce.
 */
const listField = z
  .array(z.string().trim())
  .default([])
  .transform((values) => values.filter((v) => v.length > 0).slice(0, 50));

export const setObjectiveSchema = z.object({
  caseRecordId: uuidField,
  clientInstruction: optionalText(4000),
  objective: z
    .string()
    .trim()
    .min(10, "Say what this case is for, in at least 10 characters.")
    .max(4000),
  questions: listField,
  deliverables: listField,
  deadline: optionalDateTime,
  expectedVersion: z.coerce.number().int().min(1).optional(),
});

/* ------------------------------------------------------------------ risk */

export const riskAssessmentSchema = z.object({
  caseRecordId: uuidField,
  operationalRisk: z.enum(RISK_LEVELS),
  legalRisk: z.enum(RISK_LEVELS),
  reputationalRisk: z.enum(RISK_LEVELS),
  safetyRisk: z.enum(RISK_LEVELS),
  sensitivityRisk: z.enum(RISK_LEVELS),
  overallRisk: z.enum(RISK_LEVELS),
  rationale: z
    .string()
    .trim()
    .min(10, "Explain the rating in at least 10 characters. The rationale is the assessment.")
    .max(4000),
});

export const approveRiskSchema = z.object({
  assessmentId: uuidField,
  caseRecordId: uuidField,
});

/* ----------------------------------------------------------------- scope */

export const setScopeSchema = z.object({
  caseRecordId: uuidField,
  scope: z
    .string()
    .trim()
    .min(10, "Describe what is in scope, in at least 10 characters.")
    .max(8000),
  outOfScope: optionalText(8000),
});

export const scopeChangeSchema = z.object({
  caseRecordId: uuidField,
  reason: z
    .string()
    .trim()
    .min(10, "Say why the scope needs to change, in at least 10 characters.")
    .max(4000),
  proposedScope: z
    .string()
    .trim()
    .min(10, "Describe the revised scope, in at least 10 characters.")
    .max(8000),
  proposedOutOfScope: optionalText(8000),
  additionalCost: z
    .union([z.coerce.number().min(0).max(99_999_999), z.literal("")])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : Number(v))),
  additionalCostCurrency: z
    .string()
    .trim()
    .length(3, "A currency code is three letters.")
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v.toUpperCase() : null)),
  additionalDays: z
    .union([z.coerce.number().int().min(0).max(3650), z.literal("")])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : Number(v))),
  clientApprovalReference: optionalText(400),
});

export const decideScopeChangeSchema = z.object({
  requestId: uuidField,
  caseRecordId: uuidField,
  decision: z.enum(["approve", "reject"]),
  decisionReason: z
    .string()
    .trim()
    .min(10, "Give a reason of at least 10 characters.")
    .max(2000),
});

export const withdrawScopeChangeSchema = z.object({
  requestId: uuidField,
  caseRecordId: uuidField,
  reason: reasonField(),
});

/* ------------------------------------------------------------ assignment */

export const assignSchema = z.object({
  caseRecordId: uuidField,
  userId: uuidField,
  role: z.enum(ASSIGNMENT_ROLES),
  reason: optionalText(1000),
});

export const unassignSchema = z.object({
  assignmentId: uuidField,
  caseRecordId: uuidField,
  reason: reasonField(),
});

/* -------------------------------------------------------- communications */

export const logCommunicationSchema = z.object({
  caseRecordId: uuidField,
  occurredAt: optionalDateTime,
  direction: z.enum(COMMUNICATION_DIRECTIONS),
  kind: z.enum(COMMUNICATION_KINDS),
  channel: z.enum(COMMUNICATION_CHANNELS),
  sender: requiredText(200, "Who sent it?"),
  recipient: requiredText(200, "Who received it?"),
  subject: requiredText(200, "Give it a subject."),
  body: optionalText(8000),
  attachmentReference: optionalText(400),
  classification: z.enum(CLASSIFICATION_LEVELS),
});

export const updateCommunicationSchema = z.object({
  communicationId: uuidField,
  caseRecordId: uuidField,
  expectedVersion,
  subject: requiredText(200, "Give it a subject."),
  body: optionalText(8000),
  attachmentReference: optionalText(400),
});

export const removeCommunicationSchema = z.object({
  communicationId: uuidField,
  caseRecordId: uuidField,
  reason: reasonField(),
});

export { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "@/lib/forms";

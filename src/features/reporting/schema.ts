import { z } from "zod";
import {
  expectedVersion,
  optionalText,
  reasonField,
  requiredText,
  uuidField,
} from "@/lib/forms";
import { CLASSIFICATION_LEVELS } from "@/modules/iam/shared";
import {
  CITATION_TYPES,
  DELIVERY_METHODS,
  QA_RESULTS,
  REPORT_STATUSES,
  REPORT_TYPES,
  SECTION_TYPES,
} from "@/modules/reporting/shared";

/** Contracts for the report builder, QA, delivery and closure (PRD 5.9, 10). */

const optionalDate = z
  .string()
  .trim()
  .max(10)
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

/* -------------------------------------------------------------- reports */

export const createReportSchema = z.object({
  caseRecordId: uuidField,
  title: requiredText(300, "Give the report a title."),
  reportType: z.enum(REPORT_TYPES),
  author: uuidField,
  classification: z.enum(CLASSIFICATION_LEVELS),
  executiveSummary: optionalText(8000),
  scopeStatement: optionalText(8000),
  methodology: optionalText(8000),
});

export const updateReportSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  expectedVersion,
  title: requiredText(300, "Give the report a title."),
  reportType: z.enum(REPORT_TYPES),
  classification: z.enum(CLASSIFICATION_LEVELS),
});

export const reportStatusSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  status: z.enum(REPORT_STATUSES),
  notes: optionalText(4000),
});

export const reportReasonSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  reason: reasonField(5),
});

/* ------------------------------------------------------------- versions */

export const updateVersionSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  versionId: uuidField,
  expectedVersion,
  executiveSummary: optionalText(8000),
  scopeStatement: optionalText(8000),
  methodology: optionalText(8000),
  limitations: optionalText(8000),
  conclusion: optionalText(8000),
});

/**
 * The next version (PRD 10.2).
 *
 * `intent` decides the label: a draft steps the minor number, a final one
 * takes the next whole number. Derived rather than typed, so a report's
 * history cannot acquire two v1.0s.
 */
export const addVersionSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  intent: z.enum(["draft", "final"]).default("draft"),
  changeNote: optionalText(4000),
});

/* ------------------------------------------------------------- sections */

export const addSectionSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  versionId: uuidField,
  heading: requiredText(300, "Give the section a heading."),
  body: optionalText(40000),
  sectionType: z.enum(SECTION_TYPES),
});

export const updateSectionSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  sectionId: uuidField,
  expectedVersion,
  heading: requiredText(300, "Give the section a heading."),
  body: optionalText(40000),
  sectionType: z.enum(SECTION_TYPES),
});

export const moveSectionSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  sectionId: uuidField,
  direction: z.enum(["up", "down"]),
});

export const removeSectionSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  sectionId: uuidField,
});

export const citeSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  sectionId: uuidField,
  citationType: z.enum(CITATION_TYPES),
  targetId: uuidField,
  note: optionalText(1000),
});

export const unciteSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  citationId: uuidField,
});

/* ------------------------------------------------------------------- QA */

export const openQaSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  versionId: uuidField,
});

export const answerQaSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  reviewId: uuidField,
  itemKey: requiredText(100, "Which item."),
  result: z.enum(QA_RESULTS),
  comment: optionalText(4000),
});

export const completeQaSchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  reviewId: uuidField,
  summary: optionalText(4000),
});

/* -------------------------------------------------------------- delivery */

export const recordDeliverySchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  versionId: uuidField,
  deliveredTo: requiredText(400, "Say who it went to."),
  deliveryMethod: z.enum(DELIVERY_METHODS),
  notes: optionalText(2000),
});

export const acknowledgeDeliverySchema = z.object({
  reportRecordId: uuidField,
  caseRecordId: uuidField,
  deliveryId: uuidField,
  acknowledgement: requiredText(2000, "Record what the client said."),
  acknowledgedByName: optionalText(400),
});

/* --------------------------------------------------------------- closure */

const closureFields = {
  objectivesOutcome: requiredText(
    8000,
    "Say against each objective whether it was met, and how.",
  ),
  evidenceDisposition: requiredText(
    8000,
    "Say where every item is now, and what will happen to it.",
  ),
  outstandingIssues: optionalText(8000),
  financialStatus: requiredText(
    4000,
    "Say what was billed, written off and outstanding.",
  ),
  retentionClass: requiredText(100, "Choose a retention class."),
  whatWorked: optionalText(8000),
  whatDidNotWork: optionalText(8000),
  challenges: optionalText(8000),
  newSources: optionalText(8000),
  newTypologies: optionalText(8000),
  methodologicalLessons: optionalText(8000),
  recommendations: optionalText(8000),
  contributeToKnowledgeBase: z
    .union([z.literal("on"), z.literal("true"), z.undefined()])
    .transform((value) => value !== undefined),
};

export const proposeClosureSchema = z.object({
  caseRecordId: uuidField,
  ...closureFields,
});

export const decideClosureSchema = z.object({
  caseRecordId: uuidField,
  status: z.enum(["approved", "returned"]),
  reviewNotes: optionalText(4000),
});

export const closureDateSchema = z.object({
  caseRecordId: uuidField,
  date: optionalDate,
});

export { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "@/lib/forms";

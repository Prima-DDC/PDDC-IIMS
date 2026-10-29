import { z } from "zod";
import {
  expectedVersion,
  optionalDate,
  optionalText,
  optionalUuid,
  reasonField,
  requiredText,
  uuidField,
} from "@/lib/forms";
import { CLASSIFICATION_LEVELS } from "@/modules/iam/shared";
import {
  ACTIVITY_TYPES,
  CASE_PRIORITIES,
  TASK_STATUSES,
} from "@/modules/casework/shared";

/** Contracts for the task, activity and investigation-plan screens (PRD 9). */

export const taskFields = {
  title: requiredText(200, "Say what needs doing."),
  description: optionalText(4000),
  assignedTo: optionalUuid,
  priority: z.enum(CASE_PRIORITIES),
  startDate: optionalDate,
  dueDate: optionalDate,
  methodologyStage: optionalText(60),
  parentTaskId: optionalUuid,
};

export const createTaskSchema = z.object({
  // Its own message rather than `uuidField`, because on the cross-case screen
  // this is a dropdown somebody can leave unchosen.
  caseRecordId: z.string().uuid("Choose a case."),
  ...taskFields,
});

export const updateTaskSchema = z.object({
  taskId: uuidField,
  expectedVersion,
  ...taskFields,
});

/**
 * A status change.
 *
 * The reason is optional here and required by the domain rule for `blocked`
 * and `cancelled`, so the message comes from one place rather than being
 * duplicated as a zod refinement.
 */
export const taskStatusSchema = z.object({
  taskId: uuidField,
  status: z.enum(TASK_STATUSES),
  reason: optionalText(1000),
});

export const reassignTaskSchema = z.object({
  taskId: uuidField,
  assignedTo: optionalUuid,
  reason: reasonField(),
});

export const removeTaskSchema = z.object({
  taskId: uuidField,
  reason: reasonField(),
});

export const taskCommentSchema = z.object({
  taskId: uuidField,
  body: requiredText(4000, "Write something."),
});

export const updateTaskCommentSchema = z.object({
  commentId: uuidField,
  taskId: uuidField,
  expectedVersion,
  body: requiredText(4000, "Write something."),
});

export const removeTaskCommentSchema = z.object({
  commentId: uuidField,
  taskId: uuidField,
  reason: reasonField(),
});

/* ------------------------------------------------------------ activities */

/** An optional ISO date-time, as a datetime-local input posts it. */
const optionalDateTime = z
  .string()
  .trim()
  .min(1)
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? new Date(v).toISOString() : null));

export const recordActivitySchema = z.object({
  caseRecordId: uuidField,
  occurredAt: optionalDateTime,
  activityType: z.enum(ACTIVITY_TYPES),
  description: z
    .string()
    .trim()
    .min(10, "Describe what was done, in at least 10 characters.")
    .max(8000),
  location: optionalText(400),
  relatedTaskId: optionalUuid,
  classification: z.enum(CLASSIFICATION_LEVELS),
});

/**
 * A correction (PRD 9.4).
 *
 * The log is append-only, so this writes a new entry pointing at the original.
 * The reason is what makes the correction believable, so it is required here
 * as well as by the domain rule and the CHECK constraint.
 */
export const correctActivitySchema = z.object({
  caseRecordId: uuidField,
  correctsActivityId: uuidField,
  correctionReason: z
    .string()
    .trim()
    .min(5, "Say what was wrong with the original entry.")
    .max(2000),
  occurredAt: optionalDateTime,
  activityType: z.enum(ACTIVITY_TYPES),
  description: z
    .string()
    .trim()
    .min(10, "Describe what actually happened, in at least 10 characters.")
    .max(8000),
  location: optionalText(400),
  classification: z.enum(CLASSIFICATION_LEVELS),
});

/* -------------------------------------------------- investigation plans */

const listField = z
  .array(z.string().trim())
  .default([])
  .transform((values) => values.filter((v) => v.length > 0).slice(0, 50));

export const planFields = {
  objective: z
    .string()
    .trim()
    .min(10, "State the objective, in at least 10 characters.")
    .max(4000),
  scope: optionalText(4000),
  methodology: z
    .string()
    .trim()
    .min(10, "Say how the work will be done, in at least 10 characters.")
    .max(4000),
  sourcesToConsult: listField,
  assignedPersonnel: listField,
  timeline: optionalText(2000),
  risks: optionalText(2000),
  resources: optionalText(2000),
  expectedDeliverables: listField,
};

export const createPlanVersionSchema = z.object({
  caseRecordId: uuidField,
  ...planFields,
});

export const updatePlanVersionSchema = z.object({
  versionId: uuidField,
  caseRecordId: uuidField,
  expectedVersion,
  ...planFields,
});

export const submitPlanSchema = z.object({
  versionId: uuidField,
  caseRecordId: uuidField,
});

export const reviewPlanSchema = z.object({
  versionId: uuidField,
  caseRecordId: uuidField,
  decision: z.enum(["approve", "return"]),
  notes: optionalText(2000),
});

export { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "@/lib/forms";

import { z } from "zod";
import {
  expectedVersion,
  optionalText,
  optionalUuid,
  requiredText,
  uuidField,
} from "@/lib/forms";
import { CLASSIFICATION_LEVELS } from "@/modules/iam/shared";
import {
  CHECK_IN_EVENTS,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  SITE_RISK_LEVELS,
} from "@/modules/casework/shared";

/** Contracts for the investigator-safety screens (PRD 5.8). */

/** A number from a form, where an empty field means "not set". */
const optionalPositiveInt = (max: number) =>
  z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? Number(v) : null))
    .refine(
      (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= max),
      `Give a whole number between 1 and ${max}.`,
    );

/** An optional coordinate, which the field screen posts from the browser. */
const optionalCoordinate = (limit: number) =>
  z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? Number(v) : null))
    .refine(
      (v) => v === null || (Number.isFinite(v) && Math.abs(v) <= limit),
      "That is not a valid coordinate.",
    );

export const safetyPlanFields = {
  location: requiredText(400, "Say where the work is being done."),
  siteVisitRisk: z.enum(SITE_RISK_LEVELS),
  knownHazards: optionalText(4000),
  safetyInstructions: optionalText(4000),
  emergencyContactName: requiredText(200, "Name somebody to ring."),
  emergencyContactPhone: requiredText(60, "Give a number that will be answered."),
  emergencyContactNote: optionalText(1000),
  checkInFrequencyHours: optionalPositiveInt(168),
  checkInInstructions: optionalText(2000),
  isActive: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
};

export const createSafetyPlanSchema = z.object({
  caseRecordId: uuidField,
  ...safetyPlanFields,
});

export const updateSafetyPlanSchema = z.object({
  planId: uuidField,
  caseRecordId: uuidField,
  expectedVersion,
  ...safetyPlanFields,
});

/**
 * A check-in or check-out.
 *
 * `userId` is optional: left out it means the person submitting, which is the
 * ordinary case. Supplying it is a supervisor logging a call relayed by
 * somebody in the field, which the row-level policy allows only with
 * cases:edit.
 */
export const checkInSchema = z.object({
  caseRecordId: uuidField,
  userId: optionalUuid,
  event: z.enum(CHECK_IN_EVENTS),
  location: optionalText(400),
  latitude: optionalCoordinate(90),
  longitude: optionalCoordinate(180),
  isSafe: z
    .string()
    .optional()
    .transform((v) => v !== "no"),
  notes: optionalText(2000),
});

const incidentFields = {
  occurredAt: z
    .string()
    .trim()
    .min(1, "Say when it happened.")
    .transform((v) => new Date(v).toISOString())
    .refine((v) => !Number.isNaN(new Date(v).getTime()), "Use the date picker."),
  incidentType: z.enum(INCIDENT_TYPES),
  severity: z.enum(SITE_RISK_LEVELS),
  location: optionalText(400),
  description: z
    .string()
    .trim()
    .min(20, "Describe what happened, in at least 20 characters.")
    .max(8000),
  immediateAction: optionalText(4000),
  injuries: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  injuryDetail: optionalText(2000),
  policeNotified: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  policeReference: optionalText(200),
  affectedUserId: optionalUuid,
  classification: z.enum(CLASSIFICATION_LEVELS),
};

export const reportIncidentSchema = z.object({
  caseRecordId: uuidField,
  ...incidentFields,
});

export const updateIncidentSchema = z.object({
  incidentId: uuidField,
  caseRecordId: uuidField,
  expectedVersion,
  ...incidentFields,
});

export const incidentStatusSchema = z.object({
  incidentId: uuidField,
  caseRecordId: uuidField,
  status: z.enum(INCIDENT_STATUSES),
  resolution: optionalText(4000),
});

export { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "@/lib/forms";

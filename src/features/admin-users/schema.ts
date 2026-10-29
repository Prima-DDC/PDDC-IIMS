import { z } from "zod";
import { optionalText, uuidField as uuid } from "@/lib/forms";
import {
  CLASSIFICATION_LEVELS,
  ROLE_SCOPE_TYPES,
  USER_STATUSES,
} from "@/modules/iam/shared";

/**
 * Contracts for user administration.
 *
 * Shared between the forms and the server actions, so validation cannot differ
 * between the two (PRD 21.2). The form-state shape and the generic field
 * helpers live in @/lib/forms, because every feature needs them.
 */

export const clearanceSchema = z.enum(CLASSIFICATION_LEVELS);
export const statusSchema = z.enum(USER_STATUSES);

export const provisionUserSchema = z.object({
  userId: uuid,
  clearance: clearanceSchema,
  status: z.enum(["invited", "active"]),
  employeeId: optionalText(40),
  workPhone: optionalText(40),
  jobTitle: optionalText(120),
  officeId: uuid.optional().or(z.literal("")).transform((v) => (v ? v : null)),
  departmentId: uuid.optional().or(z.literal("")).transform((v) => (v ? v : null)),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v.toUpperCase() : null)),
  sessionTimeoutMinutes: z.coerce
    .number()
    .int()
    .min(5, "Five minutes is the shortest sensible timeout.")
    .max(1440, "A day is the longest permitted timeout.")
    .default(480),
  notes: optionalText(2000),
  roleIds: z.array(uuid).default([]),
});

export const inviteUserSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter an email address.")
    .email("That does not look like an email address.")
    .toLowerCase(),
  clearance: clearanceSchema,
  jobTitle: optionalText(120),
  officeId: uuid.optional().or(z.literal("")).transform((v) => (v ? v : null)),
  departmentId: uuid.optional().or(z.literal("")).transform((v) => (v ? v : null)),
  roleIds: z.array(uuid).default([]),
});

export const updateUserSchema = z.object({
  userId: uuid,
  expectedVersion: z.coerce.number().int().min(1),
  employeeId: optionalText(40),
  workPhone: optionalText(40),
  jobTitle: optionalText(120),
  officeId: uuid.optional().or(z.literal("")).transform((v) => (v ? v : null)),
  departmentId: uuid.optional().or(z.literal("")).transform((v) => (v ? v : null)),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v.toUpperCase() : null)),
  clearance: clearanceSchema,
  sessionTimeoutMinutes: z.coerce.number().int().min(5).max(1440),
  notes: optionalText(2000),
});

export const changeStatusSchema = z.object({
  userId: uuid,
  status: statusSchema,
  reason: z
    .string()
    .trim()
    .min(3, "Give a reason. It is recorded in the audit trail."),
});

export const removeUserSchema = z.object({
  userId: uuid,
  reason: z.string().trim().min(3, "Give a reason for removing this account."),
});

export const assignRoleSchema = z.object({
  userId: uuid,
  roleId: uuid,
  scopeType: z.enum(ROLE_SCOPE_TYPES).default("all"),
  scopeId: optionalText(200),
  isPrimary: z.coerce.boolean().default(false),
  validFrom: z.string().trim().optional().transform((v) => (v ? v : null)),
  validTo: z.string().trim().optional().transform((v) => (v ? v : null)),
  reason: optionalText(500),
});

export const overrideSchema = z.object({
  userId: uuid,
  permissionId: uuid,
  effect: z.enum(["allow", "deny"]),
  reason: z
    .string()
    .trim()
    .min(3, "A reason is required for every override."),
  expiresAt: z.string().trim().optional().transform((v) => (v ? v : null)),
});

export const featureOverrideSchema = z.object({
  userId: uuid,
  featureKey: z.string().trim().min(1),
  enabled: z.coerce.boolean(),
  reason: z.string().trim().min(3, "A reason is required."),
});

/** CSV bulk import (PRD 3.3 "CSV bulk import is supported"). */
export const csvRowSchema = z.object({
  email: z.string().trim().email(),
  clearance: clearanceSchema.default("INTERNAL"),
  employee_id: z.string().trim().optional(),
  job_title: z.string().trim().optional(),
  roles: z.string().trim().optional(),
});

// The form-state shape and toFieldErrors are re-exported so the screens in
// this feature keep one import, while there is still only one definition.
export {
  EMPTY_FORM_STATE,
  toFieldErrors,
  type FormState,
} from "@/lib/forms";

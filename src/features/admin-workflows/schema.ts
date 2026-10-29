import { z } from "zod";
import { optionalText, requiredText, uuidField } from "@/lib/forms";
import { METHODOLOGY_STAGES } from "@/modules/casework/shared";

/** Contracts for administering the case lifecycle (PRD 4.3, 3.5). */

/**
 * A stage key.
 *
 * Lower case with underscores, because it appears in permission grants, in
 * saved filters and in the URL of the case register. It is also the one thing
 * about a stage that cannot be changed afterwards, for exactly that reason.
 */
const stageKey = z
  .string()
  .trim()
  .min(2, "Give the stage a key.")
  .max(60)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Lower case letters, digits and underscores, starting with a letter.",
  );

export const addStageSchema = z.object({
  definitionId: uuidField,
  key: stageKey,
  name: requiredText(100, "Give the stage a name people will read."),
  methodologyStage: z
    .enum(METHODOLOGY_STAGES)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : null)),
  isTerminal: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  requiresApproval: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  description: optionalText(1000),
});

export const renameStageSchema = z.object({
  stageId: uuidField,
  name: requiredText(100, "Give the stage a name people will read."),
});

export const reorderStagesSchema = z.object({
  definitionId: uuidField,
  stageId: uuidField,
  direction: z.enum(["up", "down"]),
});

export const addTransitionSchema = z.object({
  definitionId: uuidField,
  fromStageId: uuidField,
  toStageId: uuidField,
  requiredPermission: optionalText(80),
  requiresReason: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
});

export const removeTransitionSchema = z.object({
  transitionId: uuidField,
  definitionId: uuidField,
});

/* ----------------------------------------------------------- case types */

export const caseTypeSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2, "Give the type a key.")
    .max(60)
    .regex(
      /^[a-z][a-z0-9_]*$/,
      "Lower case letters, digits and underscores, starting with a letter.",
    ),
  name: requiredText(100, "Give the type a name people will read."),
  description: optionalText(1000),
  isActive: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
});

export const caseTypeActiveSchema = z.object({
  key: z.string().trim().min(2),
  isActive: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "@/lib/forms";

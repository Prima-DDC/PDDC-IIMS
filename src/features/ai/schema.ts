import { z } from "zod";
import { expectedVersion, optionalText, reasonField, uuidField } from "@/lib/forms";

/** What the AI screens post (PRD 22). */

export const askSchema = z.object({
  caseRecordId: uuidField,
  question: z
    .string()
    .trim()
    .min(8, "Ask a question of at least eight characters.")
    .max(500, "Keep the question under 500 characters."),
});

export const decideSuggestionSchema = z.object({
  jobId: uuidField,
  /** A select rather than two buttons, so the choice is explicit in the post. */
  decision: z.enum(["accept", "reject"], {
    message: "Accept or reject it.",
  }),
  note: optionalText(1000),
});

/**
 * Turning AI on or off for a case (PRD 22.4).
 *
 * The reason is required in both directions. Enabling is a decision to send
 * material about this case to a third party, and disabling is one somebody
 * may later need to explain, so neither is a toggle without a sentence.
 */
export const decideCaseAiSchema = z.object({
  caseRecordId: uuidField,
  enabled: z.enum(["on", "off"]),
  reason: reasonField(10),
  /*
   * An unticked checkbox posts NOTHING, so the KEY is absent rather than the
   * value being false, and `.optional()` on the union is what makes the key
   * optional. A schema that merely allowed the value `undefined` would still
   * require the property and refuse every submission where the box was left
   * clear, with nothing highlighted to explain why. That exact mistake made
   * the closure gate unsubmittable earlier in this build.
   */
  clientConsent: z
    .union([z.literal("on"), z.literal("true")])
    .optional()
    .transform((value) => value !== undefined),
  expectedVersion: expectedVersion.optional(),
});

export const saveProviderSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(
      /^[a-z][a-z0-9_]{1,30}$/,
      "Lower-case letters, digits and underscores, starting with a letter.",
    ),
  label: z.string().trim().min(2, "Give it a name.").max(80),
  baseUrl: z
    .string()
    .trim()
    .url("That is not a URL.")
    .refine(
      (value) => value.startsWith("https://"),
      "It has to be https: a prompt leaving PDDC over plain http would be readable in transit.",
    ),
  model: z.string().trim().min(1, "Name the model.").max(120),
  apiKeyEnv: z
    .string()
    .trim()
    .regex(
      /^[A-Z][A-Z0-9_]{2,60}$/,
      "The NAME of an environment variable, in upper case. Never the key itself.",
    ),
  retentionTerms: optionalText(4000),
  position: z.coerce.number().int().min(1).max(999),
  maxClassification: z.enum(["PUBLIC", "INTERNAL"], {
    message:
      "PRD 22.4 caps what may be sent at INTERNAL, so a provider can be capped at PUBLIC or at INTERNAL and no higher.",
  }),
  notes: optionalText(2000),
  enabled: z
    .union([z.literal("on"), z.literal("true")])
    .optional()
    .transform((value) => value !== undefined),
  expectedVersion: expectedVersion.optional(),
});

export const removeProviderSchema = z.object({
  key: z.string().trim().min(1),
});

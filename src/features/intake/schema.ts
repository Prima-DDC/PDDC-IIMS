import { z } from "zod";
import {
  expectedVersion,
  optionalCountry,
  optionalEmail,
  optionalText,
  optionalUuid,
  reasonField,
  requiredText,
  uuidField,
} from "@/lib/forms";
import { CLASSIFICATION_LEVELS } from "@/modules/iam/shared";
import {
  CONFLICT_DECISIONS,
  ENQUIRY_CHANNELS,
  ENQUIRY_STATUSES,
  URGENCY_LEVELS,
} from "@/modules/crm/shared";

/** Contracts for intake: enquiries and conflict screening (PRD 4.1, 8.3). */

export const enquiryFields = {
  receivedVia: z.enum(ENQUIRY_CHANNELS),
  clientId: optionalUuid,
  prospectName: optionalText(200),
  contactName: optionalText(160),
  contactEmail: optionalEmail,
  contactPhone: optionalText(40),
  subject: requiredText(200, "Say what the enquiry is about."),
  summary: optionalText(4000),
  requestedService: optionalText(200),
  urgency: z.enum(URGENCY_LEVELS),
  assignedTo: optionalUuid,
  countryCode: optionalCountry,
  officeId: optionalUuid,
  classification: z.enum(CLASSIFICATION_LEVELS),
};

/**
 * An enquiry names a party: an existing client, or a prospect.
 *
 * Checked here as well as by the database's enquiry_has_a_party constraint, so
 * the message points at the field rather than at a constraint name.
 */
const hasAParty = <T extends { clientId: string | null; prospectName: string | null }>(
  value: T,
  ctx: z.RefinementCtx,
) => {
  if (!value.clientId && !(value.prospectName ?? "").trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["prospectName"],
      message: "Pick an existing client, or give the prospect's name.",
    });
  }
};

export const createEnquirySchema = z
  .object(enquiryFields)
  .superRefine(hasAParty);

export const updateEnquirySchema = z
  .object({
    enquiryId: uuidField,
    expectedVersion,
    ...enquiryFields,
  })
  .superRefine(hasAParty);

export const enquiryStageSchema = z.object({
  enquiryId: uuidField,
  status: z.enum(ENQUIRY_STATUSES),
  // Required only when declining, which the action checks through the domain
  // rule rather than here, so the message comes from one place.
  reason: optionalText(1000),
});

export const assignEnquirySchema = z.object({
  enquiryId: uuidField,
  assignedTo: optionalUuid,
  reason: reasonField(),
});

/* ------------------------------------------------------ conflict checks */

/**
 * The terms to screen.
 *
 * Posted as repeated `term` fields, so the form can add rows without an array
 * syntax the browser does not natively produce.
 */
export const runCheckSchema = z.object({
  enquiryId: optionalUuid,
  engagementId: optionalUuid,
  clientId: optionalUuid,
  terms: z
    .array(z.string().trim())
    .min(1, "Add at least one name to screen.")
    .max(25, "Screen at most 25 names at a time."),
  threshold: z.coerce
    .number()
    .min(0.1, "A threshold below 0.1 matches almost everything.")
    .max(1, "A threshold above 1 matches nothing.")
    .default(0.3),
});

export const decideCheckSchema = z.object({
  checkId: uuidField,
  decision: z.enum(CONFLICT_DECISIONS),
  // The decision is immutable once recorded, so the reason has to carry its
  // own weight. The 10-character floor is enforced in the domain layer too.
  reason: z
    .string()
    .trim()
    .min(10, "Give a reason of at least 10 characters: this cannot be changed later.")
    .max(2000, "Keep the reason under 2000 characters."),
});

export { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "@/lib/forms";

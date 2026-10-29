import { z } from "zod";
import {
  expectedVersion,
  optionalCountry,
  optionalDate,
  optionalText,
  optionalUuid,
  reasonField,
  requiredText,
  uuidField,
} from "@/lib/forms";
import { CLASSIFICATION_LEVELS } from "@/modules/iam/shared";
import { ENGAGEMENT_STATUSES, ENGAGEMENT_TYPES } from "@/modules/crm/shared";

/** Contracts for the engagement screens (PRD 8.2, 8.4). */

export const engagementFields = {
  title: requiredText(200, "Give the engagement a title."),
  engagementType: z.enum(ENGAGEMENT_TYPES),
  enquiryId: optionalUuid,
  startDate: optionalDate,
  endDate: optionalDate,
  contractReference: optionalText(120),
  ndaReference: optionalText(120),
  scopeOfServices: optionalText(8000),
  commercialTerms: optionalText(8000),
  responsibleManagerId: optionalUuid,
  countryCode: optionalCountry,
  officeId: optionalUuid,
  classification: z.enum(CLASSIFICATION_LEVELS),
};

export const createEngagementSchema = z.object({
  clientId: uuidField,
  ...engagementFields,
});

export const updateEngagementSchema = z.object({
  engagementId: uuidField,
  expectedVersion,
  ...engagementFields,
});

/**
 * A status change, including approval.
 *
 * Approval is this same action with `status: "approved"`, not a separate
 * endpoint, so the state machine and the approval gate are applied on one path
 * rather than two that could diverge.
 */
export const engagementStatusSchema = z.object({
  engagementId: uuidField,
  status: z.enum(ENGAGEMENT_STATUSES),
  reason: reasonField(),
});

export const removeEngagementSchema = z.object({
  engagementId: uuidField,
  reason: reasonField(),
});

export { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "@/lib/forms";

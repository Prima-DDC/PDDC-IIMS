import { z } from "zod";
import {
  expectedVersion,
  optionalCountry,
  optionalDate,
  optionalEmail,
  optionalText,
  optionalUuid,
  reasonField,
  requiredText,
  uuidField,
} from "@/lib/forms";
import { CLASSIFICATION_LEVELS } from "@/modules/iam/shared";
import {
  CLIENT_STATUSES,
  CLIENT_TYPES,
  DOCUMENT_TYPES,
  KYC_CHECK_TYPES,
  KYC_OUTCOMES,
  RISK_RATINGS,
} from "@/modules/crm/shared";

/**
 * Contracts for the client screens (PRD 8.1, 8.2).
 *
 * One definition per form, used by the form and by the action behind it. The
 * enums come from the CRM module's vocabularies, which are the same lists the
 * database enforces as CHECK constraints, so a value the interface offers can
 * always be stored and a value it does not offer can never be.
 */

export const clientFields = {
  organisationName: requiredText(200, "Enter the organisation's name."),
  clientType: z.enum(CLIENT_TYPES),
  contactPerson: optionalText(160),
  position: optionalText(120),
  telephone: optionalText(40),
  email: optionalEmail,
  address: optionalText(500),
  countryCode: optionalCountry,
  officeId: optionalUuid,
  industry: optionalText(120),
  riskRating: z.enum(RISK_RATINGS),
  accountManagerId: optionalUuid,
  dateOnboarded: optionalDate,
  status: z.enum(CLIENT_STATUSES),
  classification: z.enum(CLASSIFICATION_LEVELS),
  notes: optionalText(4000),
};

export const createClientSchema = z.object(clientFields);

export const updateClientSchema = z.object({
  clientId: uuidField,
  expectedVersion,
  ...clientFields,
});

export const clientStatusSchema = z.object({
  clientId: uuidField,
  status: z.enum(CLIENT_STATUSES),
  reason: reasonField(),
});

export const removeClientSchema = z.object({
  clientId: uuidField,
  reason: reasonField(),
});

/* ---------------------------------------------------------------- contacts */

export const contactFields = {
  fullName: requiredText(160, "Enter the contact's name."),
  position: optionalText(120),
  email: optionalEmail,
  telephone: optionalText(40),
  isPrimary: z
    .union([z.literal("on"), z.literal("true"), z.literal("")])
    .optional()
    .transform((v) => v === "on" || v === "true"),
  notes: optionalText(2000),
};

export const addContactSchema = z.object({
  clientId: uuidField,
  ...contactFields,
});

export const updateContactSchema = z.object({
  contactId: uuidField,
  expectedVersion,
  ...contactFields,
});

export const removeContactSchema = z.object({
  contactId: uuidField,
  reason: reasonField(),
});

/* --------------------------------------------------------------- documents */

export const addDocumentSchema = z.object({
  clientId: uuidField,
  documentType: z.enum(DOCUMENT_TYPES),
  title: requiredText(200, "Give the document a title."),
  fileName: optionalText(260),
  // Recorded, not computed here: the file itself is uploaded direct to storage
  // in M4, and this screen registers what was uploaded (PRD 7.3).
  sha256Hash: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, "A SHA-256 hash is 64 hexadecimal characters.")
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v.toLowerCase() : null)),
  storageKey: optionalText(400),
  classification: z.enum(CLASSIFICATION_LEVELS),
  expiresAt: optionalDate,
});

export const removeDocumentSchema = z.object({
  documentId: uuidField,
  reason: reasonField(),
});

/* --------------------------------------------------------------------- KYC */

export const addKycSchema = z.object({
  clientId: uuidField,
  checkType: z.enum(KYC_CHECK_TYPES),
  outcome: z.enum(KYC_OUTCOMES),
  summary: optionalText(2000),
  evidenceDocumentId: optionalUuid,
  expiresAt: optionalDate,
});

export const updateKycSchema = z.object({
  kycId: uuidField,
  expectedVersion,
  outcome: z.enum(KYC_OUTCOMES),
  summary: optionalText(2000),
  expiresAt: optionalDate,
});

export { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "@/lib/forms";

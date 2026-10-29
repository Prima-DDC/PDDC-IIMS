import { z } from "zod";
import {
  expectedVersion,
  optionalText,
  optionalUuid,
  requiredText,
  uuidField,
} from "@/lib/forms";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  PAYMENT_STATUSES,
  TIME_UNITS,
  WORK_KINDS,
} from "@/modules/casework/shared";

/** Contracts for the finance, time and expense screens (PRD 5.6, 5.7). */

/**
 * Money from a form.
 *
 * Two decimal places, no thousands separators and no currency symbol: the
 * currency is its own field, and a form that silently accepted "GHS 1,200.00"
 * would store something nobody could add up.
 */
function requiredMoney(label: string) {
  return z
    .string()
    .trim()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, `${label} is an amount, such as 1200 or 1200.50.`)
    .transform((v) => Number(v));
}

/** The same, where an empty field means "not agreed yet" rather than zero. */
function money(label: string) {
  return z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : null))
    .refine(
      (v) => v === null || /^\d{1,12}(\.\d{1,2})?$/.test(v),
      `${label} is an amount, such as 1200 or 1200.50.`,
    )
    .transform((v) => (v === null ? null : Number(v)));
}

/** An amount that defaults to zero rather than to nothing. */
function moneyOrZero(label: string) {
  return z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : "0"))
    .pipe(
      z
        .string()
        .regex(/^\d{1,12}(\.\d{1,2})?$/, `${label} is an amount, such as 1200 or 1200.50.`)
        .transform((v) => Number(v)),
    );
}

const currency = z
  .string()
  .trim()
  .length(3, "A currency code is three letters, such as GHS.")
  .transform((v) => v.toUpperCase());

const financialsFields = {
  currency,
  quotedFee: money("The quoted fee"),
  approvedFee: money("The approved fee"),
  additionalFees: moneyOrZero("Additional fees"),
  invoiceNumber: optionalText(100),
  amountInvoiced: moneyOrZero("The amount invoiced"),
  amountPaid: moneyOrZero("The amount paid"),
  paymentStatus: z.enum(PAYMENT_STATUSES),
  notes: optionalText(4000),
};

export const createFinancialsSchema = z.object({
  caseRecordId: uuidField,
  ...financialsFields,
});

export const updateFinancialsSchema = z.object({
  financialsId: uuidField,
  caseRecordId: uuidField,
  expectedVersion,
  ...financialsFields,
});

/* ------------------------------------------------------------------ time */

/** A date input posts yyyy-mm-dd, and a timesheet entry needs one. */
const requiredDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker.");

const quantity = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, "Record a number of hours or days, such as 3.5.")
  .transform((v) => Number(v));

const timeFields = {
  workedOn: requiredDate,
  quantity,
  unit: z.enum(TIME_UNITS),
  workKind: z.enum(WORK_KINDS),
  description: optionalText(2000),
  taskId: optionalUuid,
  isBillable: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
};

export const logTimeSchema = z.object({
  caseRecordId: uuidField,
  /** Left out it means the person submitting, which is the ordinary case. */
  userId: optionalUuid,
  ...timeFields,
});

export const updateTimeSchema = z.object({
  timeEntryId: uuidField,
  caseRecordId: uuidField,
  expectedVersion,
  ...timeFields,
});

export const approveTimeSchema = z.object({
  timeEntryId: uuidField,
  caseRecordId: uuidField,
});

/* -------------------------------------------------------------- expenses */

const expenseFields = {
  incurredOn: requiredDate,
  category: z.enum(EXPENSE_CATEGORIES),
  description: requiredText(2000, "Say what the cost was for."),
  amount: requiredMoney("The amount"),
  currency,
  receiptReference: optionalText(200),
  isBillable: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
};

export const claimExpenseSchema = z.object({
  caseRecordId: uuidField,
  ...expenseFields,
});

export const updateExpenseSchema = z.object({
  expenseRecordId: uuidField,
  caseRecordId: uuidField,
  expectedVersion,
  ...expenseFields,
});

export const decideExpenseSchema = z.object({
  expenseRecordId: uuidField,
  caseRecordId: uuidField,
  status: z.enum(EXPENSE_STATUSES),
  reason: optionalText(1000),
});

export { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "@/lib/forms";

import { z } from "zod";

/**
 * The shape every server action returns, and the zod helpers every feature's
 * schema needs.
 *
 * This started life inside the user administration feature and was imported
 * from there by three others, which is the signal that it belongs here: the
 * contract is "what a form posts and what comes back", not anything about
 * users. Keeping one copy means a form cannot validate differently from the
 * action behind it (PRD 21.2), and that each new feature adds its own schemas
 * rather than its own plumbing.
 */

export interface FormState {
  error: string | null;
  success: string | null;
  fieldErrors?: Record<string, string>;
}

export const EMPTY_FORM_STATE: FormState = { error: null, success: null };

/** Collapses a zod error into the flat map the forms render. */
export function toFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

/** The standard "check the highlighted fields" reply. */
/**
 * What to tell somebody when an action failed for a reason that is not
 * theirs.
 *
 * Almost always "something went wrong", which is the honest summary of an
 * unexpected fault: a message naming a constraint or a stack frame tells a
 * user nothing they can act on and tells an attacker something they can.
 *
 * The one exception is a lost database connection, which is worth separating
 * because the remedy is different and the user can apply it. The Supavisor
 * transaction-mode pooler closes a connection mid-transaction from time to
 * time; `withActor` retries once, so reaching here means it went twice. A
 * lost connection means nothing was written, so "try again" is both true and
 * useful, where "something went wrong" leaves somebody wondering whether half
 * of it landed.
 */
export function unexpectedFailure(error: unknown, what: string): FormState {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;

  const lostConnection =
    code === "CONNECTION_CLOSED" ||
    code === "CONNECTION_ENDED" ||
    code === "CONNECTION_DESTROYED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "57P01";

  return {
    ...EMPTY_FORM_STATE,
    error: lostConnection
      ? "The connection to the database dropped before that could be saved, so nothing was changed. Try again."
      : `Something went wrong ${what}. Nothing was changed.`,
  };
}

export function invalidForm(error: z.ZodError): FormState {
  return {
    error: "Check the highlighted fields.",
    success: null,
    fieldErrors: toFieldErrors(error),
  };
}

export const uuidField = z.string().uuid("Not a valid identifier.");

/**
 * An optional free-text field.
 *
 * An HTML form posts "" for an untouched input, which is not the same thing as
 * "leave this alone", so it is normalised to null: the repositories read null
 * as "clear this" and `undefined` as "do not touch".
 */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .optional()
    .transform((v) => (v === "" ? null : (v ?? null)));
}

/** An optional reference to another record, posted as "" when unset. */
export const optionalUuid = uuidField
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null));

/** A required free-text field, with its own message. */
export function requiredText(max: number, message: string) {
  return z.string().trim().min(1, message).max(max, `Keep this under ${max} characters.`);
}

/** An optional ISO date (yyyy-mm-dd), as a date input posts it. */
export const optionalDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker.")
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null));

/** An optional two-letter country code. */
export const optionalCountry = z
  .string()
  .trim()
  .length(2, "A country code is two letters.")
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v.toUpperCase() : null));

/** An optional email address. */
export const optionalEmail = z
  .string()
  .trim()
  .email("That does not look like an email address.")
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v.toLowerCase() : null));

/** Optimistic concurrency, posted as a hidden field (PRD 21.7). */
export const expectedVersion = z.coerce.number().int().min(1);

/**
 * A reason that is actually a reason.
 *
 * Several of these go straight into the audit trail or into an immutable
 * decision, where "asdf" is worse than nothing because it looks like a record.
 */
export function reasonField(min = 3) {
  return z
    .string()
    .trim()
    .min(min, `Give a reason of at least ${min} characters.`)
    .max(1000, "Keep the reason under 1000 characters.");
}

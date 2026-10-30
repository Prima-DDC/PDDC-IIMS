/**
 * Notification errors.
 *
 * Its own type rather than a shared one, for the reason the other modules'
 * are: a bounded context that imported another's codes would be coupled to
 * its vocabulary. Codes that overlap do so because they mean the same thing
 * to the presentation layer, which maps a code to an HTTP status.
 */

export type NotifyErrorCode =
  | "not_found"
  | "validation_failed"
  | "illegal_transition"
  | "mandatory_category"
  | "email_would_leak";

export class NotifyError extends Error {
  readonly code: NotifyErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: NotifyErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NotifyError";
    this.code = code;
    this.details = details;
  }
}

export const NOTIFY_ERROR_STATUS: Record<NotifyErrorCode, number> = {
  not_found: 404,
  validation_failed: 422,
  illegal_transition: 409,
  mandatory_category: 422,
  // 500, not 422: a caller that tried to put case content in an email has a
  // bug rather than bad input, and the request should not look like the
  // reader's fault.
  email_would_leak: 500,
};

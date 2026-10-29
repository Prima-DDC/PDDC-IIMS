/**
 * Reporting, QA and closure errors.
 *
 * Its own type rather than a shared one, for the reason the other modules'
 * are: a bounded context that imported another's codes would be coupled to
 * its vocabulary. Codes that overlap do so because they mean the same thing
 * to the presentation layer, which maps a code to an HTTP status.
 */

export type ReportingErrorCode =
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "stale_version"
  | "illegal_transition"
  | "approved_locked"
  | "self_approval_forbidden"
  | "not_citable"
  | "qa_incomplete"
  | "closure_blocked";

export class ReportingError extends Error {
  readonly code: ReportingErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ReportingErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReportingError";
    this.code = code;
    this.details = details;
  }
}

export const REPORTING_ERROR_STATUS: Record<ReportingErrorCode, number> = {
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  stale_version: 409,
  illegal_transition: 409,
  approved_locked: 409,
  self_approval_forbidden: 403,
  not_citable: 422,
  qa_incomplete: 422,
  closure_blocked: 409,
};

export function isReportingError(error: unknown): error is ReportingError {
  return error instanceof ReportingError;
}

/**
 * Intelligence errors.
 *
 * Its own type rather than a shared one, for the reason the other modules'
 * are: a bounded context that imported another's codes would be coupled to
 * its vocabulary. Codes that overlap do so because they mean the same thing
 * to the presentation layer, which maps a code to an HTTP status.
 */

export type IntelErrorCode =
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "stale_version"
  | "illegal_transition"
  | "unsupported_finding"
  | "self_review_forbidden"
  | "merge_refused"
  | "source_protected";

export class IntelError extends Error {
  readonly code: IntelErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: IntelErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IntelError";
    this.code = code;
    this.details = details;
  }
}

export const INTEL_ERROR_STATUS: Record<IntelErrorCode, number> = {
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  stale_version: 409,
  illegal_transition: 409,
  unsupported_finding: 422,
  self_review_forbidden: 403,
  merge_refused: 409,
  source_protected: 403,
};

export function isIntelError(error: unknown): error is IntelError {
  return error instanceof IntelError;
}

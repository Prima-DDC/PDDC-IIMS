/**
 * CRM domain errors.
 *
 * Same shape as the IAM module's, and deliberately its own type rather than a
 * shared one: a bounded context that imported another's error codes would be
 * coupled to its vocabulary. The codes that overlap do so because they mean
 * the same thing to the presentation layer, which maps code to HTTP status.
 */

export type CrmErrorCode =
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "stale_version"
  | "illegal_transition"
  | "conflict_check_required"
  | "conflict_declined"
  | "decision_immutable"
  | "kyc_incomplete"
  | "self_approval_forbidden"
  | "in_use";

export class CrmError extends Error {
  readonly code: CrmErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CrmErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CrmError";
    this.code = code;
    this.details = details;
  }
}

export const CRM_ERROR_STATUS: Record<CrmErrorCode, number> = {
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  stale_version: 409,
  illegal_transition: 409,
  conflict_check_required: 409,
  conflict_declined: 409,
  decision_immutable: 409,
  kyc_incomplete: 409,
  self_approval_forbidden: 403,
  in_use: 409,
};

export function isCrmError(error: unknown): error is CrmError {
  return error instanceof CrmError;
}

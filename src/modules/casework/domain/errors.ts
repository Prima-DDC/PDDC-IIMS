/**
 * Casework domain errors.
 *
 * Its own type rather than a shared one, for the reason the CRM module's is:
 * a bounded context that imported another's error codes would be coupled to
 * its vocabulary. Codes that overlap do so because they mean the same thing to
 * the presentation layer, which maps a code to an HTTP status.
 */

export type CaseworkErrorCode =
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "stale_version"
  | "illegal_transition"
  | "objective_required"
  | "risk_approval_required"
  | "scope_immutable"
  | "closure_blocked"
  | "self_approval_forbidden"
  | "not_assigned"
  | "engagement_not_active"
  | "in_use";

export class CaseworkError extends Error {
  readonly code: CaseworkErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CaseworkErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CaseworkError";
    this.code = code;
    this.details = details;
  }
}

export const CASEWORK_ERROR_STATUS: Record<CaseworkErrorCode, number> = {
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  stale_version: 409,
  illegal_transition: 409,
  objective_required: 409,
  risk_approval_required: 409,
  scope_immutable: 409,
  closure_blocked: 409,
  self_approval_forbidden: 403,
  not_assigned: 403,
  engagement_not_active: 409,
  in_use: 409,
};

export function isCaseworkError(error: unknown): error is CaseworkError {
  return error instanceof CaseworkError;
}

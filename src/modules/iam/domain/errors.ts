/**
 * Domain errors.
 *
 * Each carries a stable `code` so the presentation layer can map it to an HTTP
 * status and a message without string matching, and so an API contract can
 * name it.
 */

export type IamErrorCode =
  | "not_authenticated"
  | "no_iims_access"
  | "mfa_required"
  | "account_suspended"
  | "account_locked"
  | "session_revoked"
  | "forbidden"
  | "clearance_insufficient"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "stale_version"
  | "self_approval_forbidden"
  | "second_approval_required"
  | "last_administrator"
  | "incompatible_roles"
  | "baseline_role_immutable"
  | "role_in_use"
  | "illegal_transition";

export class IamError extends Error {
  readonly code: IamErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: IamErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "IamError";
    this.code = code;
    this.details = details;
  }
}

/** HTTP status for each code, used by route handlers and server actions. */
export const IAM_ERROR_STATUS: Record<IamErrorCode, number> = {
  not_authenticated: 401,
  no_iims_access: 403,
  mfa_required: 401,
  account_suspended: 403,
  account_locked: 423,
  session_revoked: 401,
  forbidden: 403,
  clearance_insufficient: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  stale_version: 409,
  self_approval_forbidden: 403,
  second_approval_required: 403,
  last_administrator: 409,
  incompatible_roles: 409,
  baseline_role_immutable: 409,
  role_in_use: 409,
  illegal_transition: 409,
};

export function isIamError(error: unknown): error is IamError {
  return error instanceof IamError;
}

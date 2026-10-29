/**
 * Evidence and document errors.
 *
 * Its own type rather than a shared one, for the reason the other modules'
 * are: a bounded context that imported another's codes would be coupled to
 * its vocabulary. Codes that overlap do so because they mean the same thing
 * to the presentation layer, which maps a code to an HTTP status.
 */

export type EvidenceErrorCode =
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "stale_version"
  | "illegal_transition"
  | "integrity_mismatch"
  | "original_immutable"
  | "approved_locked"
  | "custody_required"
  | "self_approval_forbidden"
  | "legal_hold";

export class EvidenceError extends Error {
  readonly code: EvidenceErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: EvidenceErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EvidenceError";
    this.code = code;
    this.details = details;
  }
}

export const EVIDENCE_ERROR_STATUS: Record<EvidenceErrorCode, number> = {
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  stale_version: 409,
  illegal_transition: 409,
  integrity_mismatch: 409,
  original_immutable: 409,
  approved_locked: 409,
  custody_required: 409,
  self_approval_forbidden: 403,
  legal_hold: 423,
};

export function isEvidenceError(error: unknown): error is EvidenceError {
  return error instanceof EvidenceError;
}

/**
 * AI errors.
 *
 * `blocked` is separated from `failed` throughout this module, and these codes
 * are where that starts. A request the classification gate refused did not go
 * wrong: it was correctly not sent, and telling somebody "something went
 * wrong" would teach them to try again.
 */

export type AiErrorCode =
  | "not_found"
  | "validation_failed"
  | "no_provider"
  | "case_not_enabled"
  | "classification_blocked"
  | "quota_exceeded"
  | "nothing_to_ground_on"
  | "all_providers_exhausted"
  | "already_decided";

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.details = details;
  }
}

export function isAiError(error: unknown): error is AiError {
  return error instanceof AiError;
}

export const AI_ERROR_STATUS: Record<AiErrorCode, number> = {
  not_found: 404,
  validation_failed: 422,
  // 409 rather than 503: nothing is broken, the platform is configured not to
  // do this, and that is a state the caller can resolve.
  no_provider: 409,
  case_not_enabled: 409,
  // 403: the request was understood and refused on policy grounds, which is
  // exactly what PRD 22.4's gate is.
  classification_blocked: 403,
  quota_exceeded: 429,
  nothing_to_ground_on: 422,
  // 503: the providers are genuinely unavailable, which is the one AI failure
  // that is nobody's fault and will probably pass.
  all_providers_exhausted: 503,
  already_decided: 409,
};

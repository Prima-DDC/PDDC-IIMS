/**
 * The client-safe half of the AI module.
 *
 * Types and pure rules, with nothing that reaches a database or a provider,
 * so a client component can import this without pulling the server in.
 */

export * from "./domain/types";
export {
  DAILY_JOBS_PER_CASE,
  DAILY_JOBS_PER_USER,
  MAX_OUTPUT_TOKENS,
  MAX_PASSAGES,
  PROMPT_VERSION,
  SENDABLE_CLASSIFICATIONS,
  SYSTEM_PROMPT,
  assertNothingAboveInternal,
  assertSomethingToGroundOn,
  assertWithinQuota,
  breakerDelayMs,
  buildRequest,
  gateByClassification,
  keepOnlyGrounded,
  maySend,
  parseSuggestion,
  providerIsAvailable,
  redact,
  restore,
  shouldTryNextProvider,
} from "./domain/policies";
export { AI_ERROR_STATUS, AiError, isAiError } from "./domain/errors";
export type { AiErrorCode } from "./domain/errors";

/**
 * The client-safe half of the notify module.
 *
 * Types and pure rules, with nothing that reaches a database or a mail relay,
 * so a client component can import this without pulling the server in. The
 * same split every other module here uses, and eslint enforces it.
 */

export * from "./domain/types";
export {
  MAX_SEND_ATTEMPTS,
  assertCanBeDisabled,
  assertDeliveryTransition,
  assertEmailCarriesNoCaseContent,
  idempotencyKeyFor,
  isDeadLettered,
  isMandatory,
  nextAttemptDelayMs,
  shouldDeliver,
} from "./domain/policies";
export { NOTIFY_ERROR_STATUS, NotifyError } from "./domain/errors";
export type { NotifyErrorCode } from "./domain/errors";

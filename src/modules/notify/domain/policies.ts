import { NotifyError } from "./errors";
import {
  MANDATORY_CATEGORIES,
  type DeliveryStatus,
  type EmailParams,
  type NotificationCategory,
} from "./types";

/**
 * The rules of notification (PRD 12).
 *
 * Pure functions over plain data. Four things live here, and each is a rule
 * somebody at PDDC would recognise rather than a convenience.
 */

/** The keys an email may carry. Anything else is case content. */
const PERMITTED_EMAIL_KEYS = [
  "caseReference",
  "link",
  "categoryLabel",
  "recipientName",
  "dueAt",
] as const;

/**
 * Refuses an email parameter set that carries case content (PRD 12.2).
 *
 * The database enforces this too, and deliberately: migration 0053's CHECK
 * is what makes it true of the data, and this is what makes the refusal
 * legible to whoever wrote the call. A constraint violation surfacing from
 * the pooler tells a developer far less than being told, here, that they
 * tried to put a subject's name in an email.
 *
 * The rule is worth restating because it is easy to think of as excessive. An
 * email leaves the platform. It sits in a mailbox, gets forwarded, is read on
 * a phone on a bus, and is outside every permission this system enforces. A
 * case identifier and a link are enough for the recipient to come and look,
 * under their own clearance, at what they are allowed to see.
 */
export function assertEmailCarriesNoCaseContent(params: EmailParams): void {
  const offending = Object.keys(params).filter(
    (key) => !PERMITTED_EMAIL_KEYS.includes(key as (typeof PERMITTED_EMAIL_KEYS)[number]),
  );

  if (offending.length === 0) return;

  throw new NotifyError(
    "email_would_leak",
    `An email may only carry ${PERMITTED_EMAIL_KEYS.join(", ")}. It cannot carry ${offending.join(", ")}: PRD 12.2 keeps evidence, findings and subject names out of email bodies, because an email is read outside everything this platform enforces. Put the detail on the screen the link points at.`,
    { offending },
  );
}

/** PRD 12.2: a security alert is not a preference. */
export function isMandatory(category: NotificationCategory): boolean {
  return MANDATORY_CATEGORIES.includes(category);
}

export function assertCanBeDisabled(category: NotificationCategory): void {
  if (!isMandatory(category)) return;

  throw new NotifyError(
    "mandatory_category",
    "This one cannot be switched off. PRD 12.2 makes security alerts, missed safety check-ins and integrity failures mandatory: each of them is something you have to know whether you want to or not.",
    { category },
  );
}

/**
 * Whether to send, given somebody's preferences.
 *
 * Absence means on. A preferences table that had to hold a row per person per
 * category before anybody could be notified would mean a new employee
 * silently receiving nothing, which is the worst possible default for a
 * safety alert.
 */
export function shouldDeliver(
  category: NotificationCategory,
  channel: "inApp" | "email",
  preference: { inApp: boolean; email: boolean } | undefined,
): boolean {
  if (isMandatory(category)) return true;
  if (!preference) return true;
  return channel === "inApp" ? preference.inApp : preference.email;
}

/**
 * When to try again after a failed send (PRD 12.2: exponential backoff).
 *
 * 1, 4, 16 and 64 minutes, then dead-lettered. Four attempts over about an
 * hour and a half is long enough to ride out a provider incident and short
 * enough that a genuinely undeliverable address is visible the same working
 * day. Jitter is deliberately absent: these are per-row and drained by one
 * worker, so there is no thundering herd to spread.
 */
export const MAX_SEND_ATTEMPTS = 4;

export function nextAttemptDelayMs(attempts: number): number {
  const minutes = 4 ** Math.max(0, attempts - 1);
  return minutes * 60_000;
}

export function isDeadLettered(attempts: number): boolean {
  return attempts >= MAX_SEND_ATTEMPTS;
}

/**
 * The statuses a delivery may move between.
 *
 * `delivered` and `bounced` are what the provider tells us afterwards, so
 * both are reachable from `sent`. Nothing leaves `delivered`: a message that
 * arrived has arrived. `failed` is the dead letter, and the only way out of
 * it is somebody re-queueing deliberately.
 */
const DELIVERY_TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  queued: ["sent", "failed"],
  sent: ["delivered", "bounced", "failed"],
  delivered: [],
  bounced: ["queued"],
  failed: ["queued"],
};

export function assertDeliveryTransition(
  from: DeliveryStatus,
  to: DeliveryStatus,
): void {
  if (DELIVERY_TRANSITIONS[from].includes(to)) return;

  throw new NotifyError(
    "illegal_transition",
    from === "delivered"
      ? "That message was delivered. A delivered message cannot change state: if something else happened to it, that is a new message."
      : `A delivery cannot go from ${from} to ${to}.`,
    { from, to },
  );
}

/**
 * The idempotency key a send is made under (PRD 12.2).
 *
 * Built from the notification's own id, so a retry of the same notification
 * presents the same key to Resend and cannot produce a second email, while
 * two notifications about the same event to the same person remain distinct.
 * Deriving it from the recipient and the category instead would have
 * collapsed a genuine second alert into the first.
 */
export function idempotencyKeyFor(notificationId: string): string {
  return `pddc-iims:${notificationId}`;
}

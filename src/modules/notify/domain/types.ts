/**
 * Notifications (PRD 12).
 *
 * The categories are PRD 12.1's list, and three of them are mandatory because
 * PRD 12.2 says security alerts cannot be switched off. "Security alert" is
 * the obvious one; a missed safety check-in and a failed integrity check are
 * the other two, and they belong in the same class for the same reason: one
 * means somebody in the field may be in trouble, the other means an exhibit
 * can no longer be relied on. Neither is a preference.
 */

export const NOTIFICATION_CATEGORIES = [
  "case_assigned",
  "task_assigned",
  "deadline_approaching",
  "task_overdue",
  "evidence_review",
  "report_review",
  "report_returned",
  "case_status_change",
  "case_closure",
  "conflict_detected",
  "safety_check_in_missed",
  "integrity_failure",
  "security_alert",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** PRD 12.2: these cannot be disabled, in app or by email. */
export const MANDATORY_CATEGORIES: readonly NotificationCategory[] = [
  "safety_check_in_missed",
  "integrity_failure",
  "security_alert",
];

export const DELIVERY_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "failed",
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * The only parameters an email may carry.
 *
 * PRD 12.2: an email carries "no case detail beyond Case ID and a secure
 * link; evidence, findings and subject names are never put in email bodies".
 * This type is the application's half of that rule and migration 0053's
 * CHECK constraint is the database's half. Both exist because one of them
 * alone is a convention.
 */
export interface EmailParams {
  /** The human-readable case identifier, never the title. */
  caseReference?: string;
  /** A path within the platform. The reader signs in to follow it. */
  link?: string;
  /** Which kind of notification this is, for the subject line. */
  categoryLabel?: string;
  /** Who it is addressed to. */
  recipientName?: string;
  /** An ISO date, for a deadline. */
  dueAt?: string;
}

export interface Notification {
  id: string;
  recipientId: string;
  category: NotificationCategory;
  title: string;
  detail: string | null;
  caseId: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreference {
  category: NotificationCategory;
  label: string;
  description: string;
  isMandatory: boolean;
  inApp: boolean;
  email: boolean;
}

export interface OutboxEntry {
  id: string;
  notificationId: string;
  idempotencyKey: string;
  recipientEmail: string;
  template: string;
  params: EmailParams;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
}

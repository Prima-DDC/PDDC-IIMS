import type {
  DeliveryStatus,
  EmailParams,
  Notification,
  NotificationCategory,
  NotificationPreference,
  OutboxEntry,
} from "../domain/types";

/** Ports for notifications (PRD 12). */

export interface Page<T> {
  rows: T[];
  total: number;
}

/**
 * What a business action passes when it notifies somebody.
 *
 * `title` and `detail` are for the in-app feed and may say what happened:
 * they are read inside the platform by somebody whose permissions were
 * checked. `email` is separate and restricted, because that one leaves.
 * Keeping them as two fields rather than one body is what makes the
 * distinction impossible to forget.
 */
export interface NotifyInput {
  recipientId: string;
  category: NotificationCategory;
  title: string;
  detail?: string | null;
  caseId?: string | null;
  link?: string | null;
  /** Omitted when this category should never be emailed. */
  email?: EmailParams | null;
}

export interface NotificationRepository {
  /**
   * Writes the in-app record and, if the recipient wants it, the outbox row.
   *
   * Called INSIDE the business action's transaction (PRD 12.2), so a rolled
   * back action notifies nobody and a committed one always does. That is the
   * whole reason the outbox exists, and it is why this takes a transaction
   * rather than opening its own.
   */
  notify(input: NotifyInput): Promise<Notification>;

  /** Several at once, for an event with an audience rather than a recipient. */
  notifyAll(inputs: NotifyInput[]): Promise<Notification[]>;

  /** The signed-in person's own feed. Nobody can read another's. */
  feed(filter: {
    unreadOnly?: boolean;
    page?: number;
    pageSize?: number;
  }): Promise<Page<Notification>>;

  unreadCount(): Promise<number>;

  markRead(id: string): Promise<void>;
  markAllRead(): Promise<number>;

  /** The catalogue with this person's choices applied. */
  preferences(): Promise<NotificationPreference[]>;

  setPreference(input: {
    category: NotificationCategory;
    inApp: boolean;
    email: boolean;
  }): Promise<void>;
}

/**
 * The worker's side of the outbox.
 *
 * Separate from the repository above because it is a different caller with
 * different rights: a scheduled job draining a queue, not a person reading
 * their feed.
 */
export interface OutboxRepository {
  /** Rows whose time has come, oldest first. */
  due(limit: number): Promise<OutboxEntry[]>;

  recordAttempt(input: {
    id: string;
    status: DeliveryStatus;
    providerId?: string | null;
    error?: string | null;
  }): Promise<void>;

  /** A status reported by the provider's webhook. */
  recordProviderEvent(input: {
    idempotencyKey: string;
    status: DeliveryStatus;
    detail?: string | null;
    providerId?: string | null;
  }): Promise<void>;
}

/**
 * Sending an email, behind a port.
 *
 * Resend in production, a recording stub in tests. PRD 12 names Resend, but
 * the point of the port is that nothing above it knows: the worker asks for a
 * template and some parameters to be sent to an address, and what happens
 * after that is somebody else's problem.
 */
export interface EmailPort {
  send(input: {
    to: string;
    template: string;
    params: EmailParams;
    /** Passed to the provider, so a retry cannot duplicate (PRD 12.2). */
    idempotencyKey: string;
  }): Promise<{ providerId: string | null }>;
}

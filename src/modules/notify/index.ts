import "server-only";
import type postgres from "postgres";
import { withSystemActor } from "@/lib/db/client";
import type { Actor } from "@/lib/auth/session";
import { actorContext } from "@/lib/auth/session";
import { drainOutbox, type DrainResult } from "./application/drain-outbox";
import { createNotificationRepository } from "./infrastructure/notification-repository";
import { createOutboxRepository } from "./infrastructure/outbox-repository";
import { createSmtpEmail } from "./infrastructure/smtp-email";

/**
 * The notify module's public surface, and its composition root.
 *
 * Two entry points, because there are two callers with nothing in common.
 *
 * `notify(actor)` is for a request: a business action telling somebody
 * something, or a person reading their own feed. It takes the transaction the
 * action already holds, which is what makes PRD 12.2's guarantee true: the
 * notification is written with the change that caused it, so an action that
 * rolls back tells nobody and one that commits always does.
 *
 * `outboxWorker()` is for the scheduler, and takes no actor because there
 * isn't one. It runs under `withSystemActor`, which is the only context the
 * queue functions accept.
 */

export function notify(actor: Actor, tx?: postgres.TransactionSql) {
  return createNotificationRepository(actorContext(actor), tx);
}

export type Notify = ReturnType<typeof notify>;

/**
 * Sends whatever is due, and returns what it did.
 *
 * The email port is constructed here rather than passed in, so the one place
 * that knows the platform sends mail over SMTP is the composition root. A
 * test drives `drainOutbox` with its own port instead, which is the point of
 * the port.
 */
export async function drainEmailOutbox(limit?: number): Promise<DrainResult> {
  return drainOutbox(createOutboxRepository(), createSmtpEmail(), limit);
}

/** For a provider delivery callback, which has no actor either. */
export function outboxWorker() {
  return createOutboxRepository();
}

export { drainOutbox };
export type { DrainResult };

/* ------------------------------------------- domain, types and pure rules */

// Re-exported from the client-safe barrel so server code needs one import. A
// client component must import "@/modules/notify/shared" directly, because
// this file pulls in the database client and the mail relay.
export * from "./shared";

/* ------------------------------------------------------------------ ports */

export type {
  EmailPort,
  NotificationRepository,
  NotifyInput,
  OutboxRepository,
  Page,
} from "./application/ports";

/**
 * The notifications nobody triggers (PRD 5.8, 12.1).
 *
 * Overdue tasks, approaching deadlines and missed safety check-ins are found
 * by looking rather than by anybody acting, so they run on a schedule. Each
 * scan is a SECURITY DEFINER function because it has to see across every
 * case, which no role-level policy permits, and each is keyed so running it
 * again tells nobody twice. Migration 0058 has the reasoning.
 *
 * Returns how many people were told by each, so a quiet scan is
 * distinguishable from a broken one in the logs.
 */
export async function runScheduledScans(): Promise<{
  overdueTasks: number;
  approachingDeadlines: number;
  missedCheckIns: number;
}> {
  return withSystemActor("notification-scan", crypto.randomUUID(), async (sql) => {
    // One transaction for all three. They are independent, but a partial run
    // would leave the keys from the scans that did fire and quietly skip
    // those events next time round.
    const [row] = await sql<
      {
        overdue_tasks: number;
        approaching_deadlines: number;
        missed_check_ins: number;
      }[]
    >`
      select
        notify.scan_overdue_tasks()         as overdue_tasks,
        notify.scan_approaching_deadlines() as approaching_deadlines,
        notify.scan_missed_check_ins()      as missed_check_ins
    `;

    return {
      overdueTasks: row.overdue_tasks,
      approachingDeadlines: row.approaching_deadlines,
      missedCheckIns: row.missed_check_ins,
    };
  });
}

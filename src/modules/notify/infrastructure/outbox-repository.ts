import "server-only";
import { withSystemActor } from "@/lib/db/client";
import type { DeliveryStatus, EmailParams, OutboxEntry } from "../domain/types";
import type { OutboxRepository } from "../application/ports";

/**
 * The worker's side of the outbox.
 *
 * Every call here runs under `withSystemActor`, which publishes
 * `iims.system_process` and no user id. That is not decoration: migration
 * 0054's functions refuse a caller that has a signed-in user, so this is the
 * only shape of transaction that can reach the queue at all. A page that
 * somehow called these methods would be refused by the database rather than
 * by a convention.
 *
 * `iims_app` holds no SELECT or UPDATE on `notify.outbox`, so there is no
 * alternative path to fall back on and nothing here can drift into reading
 * the table directly.
 */

const PROCESS = "outbox-drain";

interface ClaimedRow {
  id: string;
  notification_id: string;
  idempotency_key: string;
  recipient_email: string;
  template: string;
  params: EmailParams;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}

export function createOutboxRepository(): OutboxRepository {
  return {
    async due(limit): Promise<OutboxEntry[]> {
      return withSystemActor(PROCESS, crypto.randomUUID(), async (sql) => {
        const rows = await sql<ClaimedRow[]>`
          select * from notify.claim_due_emails(${limit}::integer)
        `;

        return rows.map((row) => ({
          id: row.id,
          notificationId: row.notification_id,
          idempotencyKey: row.idempotency_key,
          recipientEmail: row.recipient_email,
          template: row.template,
          params: row.params,
          status: row.status,
          attempts: row.attempts,
          nextAttemptAt: row.next_attempt_at,
          lastError: row.last_error,
        }));
      });
    },

    async recordAttempt(input): Promise<void> {
      await withSystemActor(PROCESS, crypto.randomUUID(), async (sql) => {
        await sql`
          select notify.record_send_outcome(
            ${input.id}::uuid,
            ${input.status},
            ${input.providerId ?? null},
            ${input.error ?? null},
            ${input.retryAt ?? null}::timestamptz
          )
        `;
      });
    },

    async recordProviderEvent(input): Promise<void> {
      await withSystemActor(PROCESS, crypto.randomUUID(), async (sql) => {
        await sql`
          select notify.record_provider_event(
            ${input.idempotencyKey},
            ${input.status},
            ${input.detail ?? null},
            ${input.providerId ?? null}
          )
        `;
      });
    },
  };
}

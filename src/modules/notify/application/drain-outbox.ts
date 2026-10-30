import {
  MAX_SEND_ATTEMPTS,
  isDeadLettered,
  nextAttemptDelayMs,
} from "../domain/policies";
import type { EmailPort, OutboxRepository } from "./ports";

/**
 * Draining the outbox (PRD 12.2).
 *
 * Claim a batch, send each one, record what happened. The ordering is the
 * whole design and it is the pessimistic one on purpose: the attempt is
 * counted when the row is claimed, before anything is sent, so a message that
 * kills the worker still runs out of attempts. Counting it on a clean failure
 * instead would mean a poison message retried for ever and a queue that never
 * drained past it.
 *
 * One send at a time rather than in parallel. The relay is the slow part and
 * it is also the part that dislikes being hammered; a batch of twenty-five
 * sequential sends over a pooled SMTP connection is well inside a cron minute,
 * and a failure is attributable to one row rather than to a wave.
 */

export interface DrainResult {
  claimed: number;
  sent: number;
  requeued: number;
  deadLettered: number;
}

export async function drainOutbox(
  outbox: OutboxRepository,
  email: EmailPort,
  limit = 25,
): Promise<DrainResult> {
  const batch = await outbox.due(limit);
  const result: DrainResult = {
    claimed: batch.length,
    sent: 0,
    requeued: 0,
    deadLettered: 0,
  };

  for (const entry of batch) {
    try {
      const { providerId } = await email.send({
        to: entry.recipientEmail,
        template: entry.template,
        params: entry.params,
        idempotencyKey: entry.idempotencyKey,
      });

      await outbox.recordAttempt({
        id: entry.id,
        status: "sent",
        providerId,
      });
      result.sent += 1;
    } catch (error) {
      // The reason, with no address and no parameters in it. `last_error` is
      // read by an administrator looking at delivery health, so it says what
      // went wrong and nothing about who it was going to.
      const reason = error instanceof Error ? error.message : String(error);

      if (isDeadLettered(entry.attempts)) {
        await outbox.recordAttempt({
          id: entry.id,
          status: "failed",
          error: `${reason} (gave up after ${MAX_SEND_ATTEMPTS} attempts)`,
        });
        result.deadLettered += 1;
        // Deliberately logged: a dead letter is the one outcome nobody is
        // told about by the platform itself, since the thing that failed was
        // the telling.
        console.error(
          `[notify] outbox ${entry.id} dead-lettered after ${entry.attempts} attempts: ${reason}`,
        );
        continue;
      }

      const retryAt = new Date(
        Date.now() + nextAttemptDelayMs(entry.attempts),
      ).toISOString();

      await outbox.recordAttempt({
        id: entry.id,
        status: "queued",
        error: reason,
        retryAt,
      });
      result.requeued += 1;
    }
  }

  return result;
}

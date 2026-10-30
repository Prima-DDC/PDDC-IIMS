import { afterAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { testSql } from "../helpers/sql";
import { createNotificationRepository } from "@/modules/notify/infrastructure/notification-repository";
import { drainOutbox } from "@/modules/notify/application/drain-outbox";
import type { EmailPort, OutboxRepository } from "@/modules/notify/application/ports";
import type {
  DeliveryStatus,
  EmailParams,
  OutboxEntry,
} from "@/modules/notify/domain/types";
import { MAX_SEND_ATTEMPTS } from "@/modules/notify/domain/policies";
import type { ActorContext } from "@/lib/db/client";

/**
 * Notifications against the real Postgres (PRD 12).
 *
 * Everything runs in a transaction that is always rolled back, so no email
 * address is ever queued for a real employee.
 *
 * What is worth proving here rather than in the domain tests is the half only
 * the database can answer. The domain tests already cover the rules; these
 * cover whether the rules are actually in force:
 *
 *   that an email genuinely cannot be given case content, at the constraint
 *   and not only at the function that checks before it;
 *
 *   that a producer who is not the recipient can still honour the
 *   recipient's preferences, which is the whole reason `publish` is a
 *   SECURITY DEFINER function;
 *
 *   that a mandatory category ignores a preference that says no;
 *
 *   that the same source key twice produces one notification, which is what
 *   makes the scheduled scans safe to repeat;
 *
 *   and that the worker's claim, requeue and dead-letter path moves the row
 *   the way the backoff says it should.
 */

const hasDb = Boolean(process.env.SUPABASE_DB_URL);
const suite = describe.skipIf(!hasDb);

const sql = hasDb ? testSql() : null;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

class Rollback extends Error {}

/**
 * Runs something that is expected to be refused, without taking the
 * transaction with it.
 *
 * Postgres aborts a whole transaction on a failed statement, so a test that
 * asserted one refusal and then carried on saw "current transaction is
 * aborted" for everything after it: a cascade of failures describing nothing.
 * A savepoint is the scope that can be rolled back on its own, and
 * postgres.js exposes it, so every expected refusal below runs inside one.
 */
async function refused(
  tx: postgres.TransactionSql,
  body: () => Promise<unknown>,
): Promise<Error> {
  try {
    await tx.savepoint(async () => {
      await body();
    });
  } catch (error) {
    return error as Error;
  }
  throw new Error("that was expected to be refused, and was not");
}

async function inRolledBackTx(
  body: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  try {
    await sql!.begin(async (tx) => {
      await body(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

async function seedUser(
  tx: postgres.TransactionSql,
  name: string,
  roles: string[] = ["investigator"],
): Promise<string> {
  const [{ id }] = await tx<{ id: string }[]>`
    select extensions.gen_random_uuid() as id
  `;
  const email = `pddc-notify-${id}@example.invalid`;

  await tx`
    insert into auth.users
      (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${id}::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${email}, 'fixture', now(), now())
  `;
  // The profile is where the address and the name come from: `publish` reads
  // the shared primaddc.com directory, not iam.users.
  await tx`
    insert into public.profiles (id, email, full_name)
    values (${id}::uuid, ${email}, ${name})
    on conflict (id) do update set email = excluded.email, full_name = excluded.full_name
  `;
  await tx`
    insert into iam.users (id, clearance, status)
    values (${id}::uuid, 'INTERNAL', 'active')
  `;
  for (const key of roles) {
    await tx`
      insert into iam.user_roles (user_id, role_id)
      select ${id}::uuid, r.id from iam.roles r where r.key = ${key}
    `;
  }
  return id;
}

function actorFor(userId: string): ActorContext {
  return {
    userId,
    clearance: "INTERNAL",
    requestId: crypto.randomUUID(),
    aal: "aal2",
    ip: "203.0.113.10",
    userAgent: "vitest",
  };
}

/** Reads the queue as `postgres`, which the application deliberately cannot. */
async function outboxFor(tx: postgres.TransactionSql, notificationId: string) {
  const rows = await tx<
    {
      id: string;
      status: DeliveryStatus;
      attempts: number;
      params: Record<string, string>;
      recipient_email: string;
      idempotency_key: string;
      last_error: string | null;
      next_attempt_at: string;
    }[]
  >`
    select id, status, attempts, params, recipient_email, idempotency_key,
           last_error, next_attempt_at
    from notify.outbox
    where notification_id = ${notificationId}::uuid
  `;
  return rows;
}

suite("publishing a notification (PRD 12.2)", () => {
  it("writes the in-app record and the email, with the labels filled in", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const recipient = await seedUser(tx, "Kwame Mensah");

      const repo = createNotificationRepository(actorFor(sender), tx);
      const created = await repo.notify({
        recipientId: recipient,
        category: "task_assigned",
        title: "TSK-2026-000001: Interview the warehouse manager",
        detail: "On case PDDC-2026-000001, due 2026-11-02.",
        link: "/tasks/abc",
        email: { caseReference: "PDDC-2026-000001", link: "/tasks/abc" },
      });

      expect(created).not.toBeNull();

      const queued = await outboxFor(tx, created!.id);
      expect(queued).toHaveLength(1);
      expect(queued[0].status).toBe("queued");
      expect(queued[0].attempts).toBe(0);
      expect(queued[0].recipient_email).toContain("@example.invalid");
      expect(queued[0].idempotency_key).toBe(`pddc-iims:${created!.id}`);

      // Filled by the database from the catalogue and the directory, so an
      // email cannot disagree with the platform about either.
      expect(queued[0].params.categoryLabel).toBe("New task");
      expect(queued[0].params.recipientName).toBe("Kwame Mensah");
      expect(queued[0].params.caseReference).toBe("PDDC-2026-000001");
    });
  });

  it("refuses an email that would carry case content, at the constraint", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const recipient = await seedUser(tx, "Kwame Mensah");

      // Straight at the function, bypassing the domain check, because the
      // point is whether the DATABASE refuses it. The actor has to be
      // published by hand here: nothing has gone through a repository yet,
      // and `publish` refuses a caller it cannot identify at all, which
      // would be the wrong refusal to be asserting.
      await tx`select set_config('iims.user_id', ${sender}, true)`;

      const fromDatabase = await refused(tx, () => tx`
        select notify.publish(
          ${recipient}::uuid, 'task_assigned', 'A task',
          null, null, '/tasks/abc',
          '{"subjectName": "Someone Real"}'::jsonb
        )
      `);
      expect(fromDatabase.message).toMatch(/outbox_params_only_safe_keys/);

      // And through the repository, where the refusal says what to remove.
      const repo = createNotificationRepository(actorFor(sender), tx);
      const fromDomain = await refused(tx, () =>
        repo.notify({
          recipientId: recipient,
          category: "task_assigned",
          title: "A task",
          email: { subjectName: "Someone Real" } as never,
        }),
      );
      expect(fromDomain.message).toMatch(/subjectName/);
    });
  });

  it("tells nobody about what they did themselves", async () => {
    await inRolledBackTx(async (tx) => {
      const person = await seedUser(tx, "Ama Darko", ["operations_manager"]);

      const repo = createNotificationRepository(actorFor(person), tx);
      const created = await repo.notify({
        recipientId: person,
        category: "case_status_change",
        title: "You moved this yourself",
      });

      expect(created).toBeNull();
    });
  });

  it("tells nobody who is no longer active", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const recipient = await seedUser(tx, "Kwame Mensah");

      await tx`update iam.users set status = 'suspended' where id = ${recipient}::uuid`;

      const repo = createNotificationRepository(actorFor(sender), tx);
      const created = await repo.notify({
        recipientId: recipient,
        category: "task_assigned",
        title: "A task for somebody who has gone",
      });

      expect(created).toBeNull();
    });
  });
});

suite("preferences (PRD 12.2)", () => {
  it("lets a recipient switch email off, and the producer honours it", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const recipient = await seedUser(tx, "Kwame Mensah");

      // The recipient sets their own preference, as themselves.
      await createNotificationRepository(actorFor(recipient), tx).setPreference({
        category: "task_assigned",
        inApp: true,
        email: false,
      });

      // The producer is somebody else entirely, and cannot read that row
      // under `preferences_select`. This is the case `publish` exists for.
      const created = await createNotificationRepository(
        actorFor(sender),
        tx,
      ).notify({
        recipientId: recipient,
        category: "task_assigned",
        title: "A task",
        email: { link: "/tasks/abc" },
      });

      expect(created).not.toBeNull();
      expect(await outboxFor(tx, created!.id)).toHaveLength(0);
    });
  });

  it("records an in-app refusal on the row rather than losing the event", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const recipient = await seedUser(tx, "Kwame Mensah");

      await createNotificationRepository(actorFor(recipient), tx).setPreference({
        category: "case_status_change",
        inApp: false,
        email: true,
      });

      const created = await createNotificationRepository(
        actorFor(sender),
        tx,
      ).notify({
        recipientId: recipient,
        category: "case_status_change",
        title: "The case moved",
      });

      expect(created).not.toBeNull();

      const [row] = await tx<{ in_app_suppressed: boolean }[]>`
        select in_app_suppressed from notify.notifications
        where id = ${created!.id}::uuid
      `;
      expect(row.in_app_suppressed).toBe(true);

      // And it does not appear in their feed, which is what "off" means.
      const feed = await createNotificationRepository(
        actorFor(recipient),
        tx,
      ).feed({});
      expect(feed.rows.map((n) => n.id)).not.toContain(created!.id);
    });
  });

  it("will not let a mandatory category be switched off at all", async () => {
    await inRolledBackTx(async (tx) => {
      const person = await seedUser(tx, "Kwame Mensah");
      const repo = createNotificationRepository(actorFor(person), tx);

      const fromDomain = await refused(tx, () =>
        repo.setPreference({
          category: "safety_check_in_missed",
          inApp: false,
          email: false,
        }),
      );
      expect(fromDomain.message).toMatch(/cannot be switched off/i);

      // Refused by the database too, not only by the application.
      const fromDatabase = await refused(tx, () => tx`
        insert into notify.preferences (user_id, category, in_app, email)
        values (${person}::uuid, 'security_alert', false, false)
      `);
      expect(fromDatabase.message).toMatch(/mandatory/i);
    });
  });

  it("sends a mandatory category even to somebody who asked for nothing", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const recipient = await seedUser(tx, "Kwame Mensah");

      // Everything they CAN switch off, switched off.
      await tx`
        insert into notify.preferences (user_id, category, in_app, email)
        select ${recipient}::uuid, key, false, false
        from notify.categories where not is_mandatory
      `;

      const created = await createNotificationRepository(
        actorFor(sender),
        tx,
      ).notify({
        recipientId: recipient,
        category: "integrity_failure",
        title: "EV-2026-000001-001 no longer matches its recorded hash",
        email: { link: "/evidence/abc" },
      });

      expect(created).not.toBeNull();
      expect(await outboxFor(tx, created!.id)).toHaveLength(1);

      const feed = await createNotificationRepository(
        actorFor(recipient),
        tx,
      ).feed({});
      expect(feed.rows.map((n) => n.id)).toContain(created!.id);
    });
  });
});

suite("the feed", () => {
  it("shows a person their own and nobody else's", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const mine = await seedUser(tx, "Kwame Mensah");
      const theirs = await seedUser(tx, "Akosua Boateng");

      const producer = createNotificationRepository(actorFor(sender), tx);
      const forMe = await producer.notify({
        recipientId: mine,
        category: "task_assigned",
        title: "Mine",
      });
      const forThem = await producer.notify({
        recipientId: theirs,
        category: "task_assigned",
        title: "Theirs",
      });

      const feed = await createNotificationRepository(actorFor(mine), tx).feed({});
      const ids = feed.rows.map((n) => n.id);

      expect(ids).toContain(forMe!.id);
      expect(ids).not.toContain(forThem!.id);
    });
  });

  it("counts and clears unread without moving the moment it was first read", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const recipient = await seedUser(tx, "Kwame Mensah");

      const producer = createNotificationRepository(actorFor(sender), tx);
      const first = await producer.notify({
        recipientId: recipient,
        category: "task_assigned",
        title: "One",
      });
      await producer.notify({
        recipientId: recipient,
        category: "report_review",
        title: "Two",
      });

      const mine = createNotificationRepository(actorFor(recipient), tx);
      expect(await mine.unreadCount()).toBe(2);

      await mine.markRead(first!.id);
      expect(await mine.unreadCount()).toBe(1);

      const [read] = await tx<{ read_at: string }[]>`
        select read_at from notify.notifications where id = ${first!.id}::uuid
      `;

      // Marking it read again must not move the timestamp: when somebody
      // first saw something is a fact about the past.
      await mine.markRead(first!.id);
      const [again] = await tx<{ read_at: string }[]>`
        select read_at from notify.notifications where id = ${first!.id}::uuid
      `;
      expect(again.read_at).toBe(read.read_at);

      expect(await mine.markAllRead()).toBe(1);
      expect(await mine.unreadCount()).toBe(0);
    });
  });

  it("refuses to mark somebody else's notification as read", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const theirs = await seedUser(tx, "Akosua Boateng");
      const intruder = await seedUser(tx, "Kwame Mensah");

      const created = await createNotificationRepository(
        actorFor(sender),
        tx,
      ).notify({
        recipientId: theirs,
        category: "task_assigned",
        title: "Not yours",
      });

      const error = await refused(tx, () =>
        createNotificationRepository(actorFor(intruder), tx).markRead(created!.id),
      );
      expect(error.message).toMatch(/not in your feed/i);
    });
  });
});

suite("the source key, which makes a scan repeatable", () => {
  it("publishes once however many times it is asked", async () => {
    await inRolledBackTx(async (tx) => {
      const recipient = await seedUser(tx, "Kwame Mensah");

      // As a system process, which is how the scans run.
      await tx`select set_config('iims.system_process', 'test-scan', true)`;
      await tx`select set_config('iims.user_id', '', true)`;

      const publish = () => tx<{ id: string | null }[]>`
        select notify.publish(
          ${recipient}::uuid, 'task_overdue', 'TSK-1 is late',
          null, null, '/tasks/one', null, 'task-overdue:one'
        ) as id
      `;

      const [first] = await publish();
      const [second] = await publish();

      expect(first.id).not.toBeNull();
      expect(second.id).toBeNull();

      const [{ n }] = await tx<{ n: string }[]>`
        select count(*)::text as n from notify.notifications
        where recipient_id = ${recipient}::uuid and category = 'task_overdue'
      `;
      expect(Number(n)).toBe(1);
    });
  });

  it("keeps the scans out of reach of a request", async () => {
    await inRolledBackTx(async (tx) => {
      const person = await seedUser(tx, "Kwame Mensah");

      await tx`select set_config('iims.system_process', 'pretending', true)`;
      await tx`select set_config('iims.user_id', ${person}, true)`;

      const scan = await refused(tx, () => tx`select notify.scan_overdue_tasks()`);
      expect(scan.message).toMatch(/schedule, not from a request/i);

      const claim = await refused(tx, () => tx`select notify.claim_due_emails(5)`);
      expect(claim.message).toMatch(/system process, not by a request/i);
    });
  });
});

/* ------------------------------------------------------------- the worker */

/**
 * The worker driven against the real queue, with the relay stubbed.
 *
 * The outbox repository is reimplemented here over the test transaction
 * rather than used from the module, because the real one opens its own
 * connection through `withSystemActor` and that would commit outside the
 * rollback. The SQL it runs is the same SQL.
 */
function outboxOver(tx: postgres.TransactionSql): OutboxRepository {
  return {
    async due(limit) {
      await tx`select set_config('iims.system_process', 'outbox-drain', true)`;
      await tx`select set_config('iims.user_id', '', true)`;
      const rows = await tx<
        {
          id: string;
          notification_id: string;
          idempotency_key: string;
          recipient_email: string;
          template: string;
          params: Record<string, string>;
          status: DeliveryStatus;
          attempts: number;
          next_attempt_at: string;
          last_error: string | null;
        }[]
      >`select * from notify.claim_due_emails(${limit}::integer)`;

      return rows.map(
        (row): OutboxEntry => ({
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
        }),
      );
    },

    async recordAttempt(input) {
      await tx`
        select notify.record_send_outcome(
          ${input.id}::uuid, ${input.status}, ${input.providerId ?? null},
          ${input.error ?? null}, ${input.retryAt ?? null}::timestamptz
        )
      `;
    },

    async recordProviderEvent(input) {
      await tx`
        select notify.record_provider_event(
          ${input.idempotencyKey}, ${input.status},
          ${input.detail ?? null}, ${input.providerId ?? null}
        )
      `;
    },
  };
}

function recordingEmail(behaviour: "accept" | "refuse"): EmailPort & {
  sent: Array<{ to: string; params: EmailParams }>;
} {
  const sent: Array<{ to: string; params: EmailParams }> = [];
  return {
    sent,
    async send({ to, params }) {
      if (behaviour === "refuse") throw new Error("relay refused the message");
      sent.push({ to, params });
      return { providerId: `stub-${sent.length}` };
    },
  };
}

suite("draining the outbox", () => {
  it("sends what is due, records the provider id, and leaves nothing behind", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const recipient = await seedUser(tx, "Kwame Mensah");

      const created = await createNotificationRepository(
        actorFor(sender),
        tx,
      ).notify({
        recipientId: recipient,
        category: "task_assigned",
        title: "A task",
        email: { caseReference: "PDDC-2026-000001", link: "/tasks/abc" },
      });

      const email = recordingEmail("accept");
      const result = await drainOutbox(outboxOver(tx), email, 50);

      expect(result.sent).toBeGreaterThanOrEqual(1);
      expect(email.sent.some((m) => m.to.includes("@example.invalid"))).toBe(true);

      const [row] = await outboxFor(tx, created!.id);
      expect(row.status).toBe("sent");
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBeNull();

      // The history is written with the status, never after it.
      const [{ n }] = await tx<{ n: string }[]>`
        select count(*)::text as n from notify.delivery_events
        where outbox_id = ${row.id}::uuid and status = 'sent'
      `;
      expect(Number(n)).toBe(1);

      // And a second drain finds nothing: the row is no longer queued.
      const again = await drainOutbox(outboxOver(tx), recordingEmail("accept"), 50);
      expect(again.claimed).toBe(0);
    });
  });

  it("requeues a refused send with its reason and backs off", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const recipient = await seedUser(tx, "Kwame Mensah");

      const created = await createNotificationRepository(
        actorFor(sender),
        tx,
      ).notify({
        recipientId: recipient,
        category: "task_assigned",
        title: "A task",
        email: { link: "/tasks/abc" },
      });

      const result = await drainOutbox(outboxOver(tx), recordingEmail("refuse"), 50);
      expect(result.requeued).toBeGreaterThanOrEqual(1);

      const [row] = await outboxFor(tx, created!.id);
      expect(row.status).toBe("queued");
      expect(row.attempts).toBe(1);
      // Kept rather than cleared, which migration 0055 corrected: the reason
      // a message is still waiting is the useful part.
      expect(row.last_error).toMatch(/relay refused/i);
      // And it is not due again immediately.
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    });
  });

  it("dead-letters rather than retrying for ever, and says why", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const recipient = await seedUser(tx, "Kwame Mensah");

      const created = await createNotificationRepository(
        actorFor(sender),
        tx,
      ).notify({
        recipientId: recipient,
        category: "task_assigned",
        title: "A task",
        email: { link: "/tasks/abc" },
      });

      const outbox = outboxOver(tx);
      const [row] = await outboxFor(tx, created!.id);

      // Drive it to the last attempt directly rather than waiting out four
      // backoffs: the question is what happens at the limit, not how long
      // the limit takes to reach.
      await tx`
        update notify.outbox
        set attempts = ${MAX_SEND_ATTEMPTS - 1}, last_error = 'earlier failure'
        where id = ${row.id}::uuid
      `;

      const result = await drainOutbox(outbox, recordingEmail("refuse"), 50);
      expect(result.deadLettered).toBe(1);

      const [dead] = await outboxFor(tx, created!.id);
      expect(dead.status).toBe("failed");
      expect(dead.last_error).toMatch(/gave up after/i);

      // A dead letter is not picked up again.
      expect((await drainOutbox(outbox, recordingEmail("accept"), 50)).claimed).toBe(0);
    });
  });

  it("will not move a delivered message, because it has arrived", async () => {
    await inRolledBackTx(async (tx) => {
      const sender = await seedUser(tx, "Ama Darko", ["operations_manager"]);
      const recipient = await seedUser(tx, "Kwame Mensah");

      const created = await createNotificationRepository(
        actorFor(sender),
        tx,
      ).notify({
        recipientId: recipient,
        category: "task_assigned",
        title: "A task",
        email: { link: "/tasks/abc" },
      });

      const outbox = outboxOver(tx);
      await drainOutbox(outbox, recordingEmail("accept"), 50);

      const [row] = await outboxFor(tx, created!.id);
      await outbox.recordProviderEvent({
        idempotencyKey: row.idempotency_key,
        status: "delivered",
        providerId: "stub-1",
      });

      const [delivered] = await outboxFor(tx, created!.id);
      expect(delivered.status).toBe("delivered");

      const error = await refused(tx, () =>
        outbox.recordProviderEvent({
          idempotencyKey: row.idempotency_key,
          status: "bounced",
          detail: "too late",
        }),
      );
      expect(error.message).toMatch(/delivered and cannot be moved/i);
    });
  });

  it("ignores a delivery callback for a message it never sent", async () => {
    await inRolledBackTx(async (tx) => {
      await tx`select set_config('iims.system_process', 'webhook', true)`;
      await tx`select set_config('iims.user_id', '', true)`;

      // Silent rather than an error: a provider may report on a message from
      // another environment sharing the same mailbox.
      await expect(
        tx`select notify.record_provider_event('pddc-iims:nobody', 'bounced')`,
      ).resolves.toBeDefined();
    });
  });
});

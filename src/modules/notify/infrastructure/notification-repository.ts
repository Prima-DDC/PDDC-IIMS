import "server-only";
import type postgres from "postgres";
import {
  applyActorSettings,
  withActor,
  type ActorContext,
} from "@/lib/db/client";
import { NotifyError } from "../domain/errors";
import { assertCanBeDisabled, assertEmailCarriesNoCaseContent } from "../domain/policies";
import type {
  Notification,
  NotificationCategory,
  NotificationPreference,
} from "../domain/types";
import type {
  NotificationRepository,
  NotifyInput,
  Page,
} from "../application/ports";

/**
 * Notifications (PRD 12).
 *
 * Two halves with opposite attitudes to privilege, which is why they read so
 * differently:
 *
 *   PUBLISHING goes through `notify.publish`, a SECURITY DEFINER function,
 *   because notifying somebody means reading their preferences and
 *   `notify.preferences` is readable only by its owner. The function also
 *   reads the recipient's email address and uses it without returning it, so
 *   an address never travels back into application memory to be logged by
 *   accident.
 *
 *   READING is plain SQL, and every statement names the recipient itself:
 *   `recipient_id = iam.current_user_id()`. The policy says the same thing,
 *   so that predicate looks redundant and is not. It states the query's
 *   intent where somebody reading the query can see it, it survives a policy
 *   being widened later for some other purpose, and it is the only version
 *   that is true for the integration tests, which connect as `postgres` and
 *   so bypass row-level security entirely. A test that proved a feed showed
 *   one person's rows while relying on a policy that was not in force would
 *   prove nothing at all, which is how it was written the first time.
 *
 * There is no "read somebody else's feed" path here for an administrator
 * either: PRD 12 makes a notification personal correspondence, and oversight
 * belongs in the audit trail.
 */

interface NotificationRow {
  id: string;
  recipient_id: string;
  category: NotificationCategory;
  title: string;
  detail: string | null;
  case_id: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    recipientId: row.recipient_id,
    category: row.category,
    title: row.title,
    detail: row.detail,
    caseId: row.case_id,
    link: row.link,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export function createNotificationRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): NotificationRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  /**
   * One publish, on a transaction the caller already holds.
   *
   * Kept separate from `notify` so `notifyAll` can send every row down one
   * transaction rather than opening one each: an event with an audience of
   * eight would otherwise cost eight round trips to a database in another
   * region, which is the difference between a page that feels instant and
   * one that does not.
   */
  const publish = async (
    sql: postgres.TransactionSql,
    input: NotifyInput,
  ): Promise<Notification | null> => {
    if (input.email) {
      // Checked here as well as by the database, because this is where the
      // message can name the call site that got it wrong. Migration 0053's
      // CHECK is the guarantee; this is the explanation.
      assertEmailCarriesNoCaseContent(input.email);
    }

    const [row] = await sql<{ id: string | null }[]>`
      select notify.publish(
        ${input.recipientId}::uuid,
        ${input.category},
        ${input.title},
        ${input.detail ?? null},
        ${input.caseId ?? null}::uuid,
        ${input.link ?? null},
        ${
          /*
           * `sql.json`, not `JSON.stringify`.
           *
           * Passing a string here produced a jsonb ARRAY containing that
           * string, because postgres.js serialises the value itself once it
           * has settled on a json type, so a pre-serialised string was
           * serialised a second time. The outbox then refused the row:
           * `["{\"caseReference\":…}"]` strips to itself rather than to
           * `{}` under the constraint that permits five keys.
           *
           * Worth stating what that cost, because it was not an email bug.
           * `publish` runs inside the business action's transaction, so the
           * refusal rolled the action back: creating a task, assigning
           * somebody to a case or moving a report would all have failed
           * outright with "something went wrong", and the thing that
           * actually went wrong was the shape of a parameter. Found by the
           * integration test, and invisible to the type checker because
           * `JSON.stringify` returns a perfectly good string.
           */
          input.email ? sql.json(input.email as Record<string, string>) : null
        }::jsonb
      ) as id
    `;

    // Null means there was nobody to tell: the recipient is the actor, or
    // they are no longer active. Not a failure, and deliberately not an
    // exception, because the business action it hangs off has succeeded.
    if (!row?.id) return null;

    const [created] = await sql<NotificationRow[]>`
      select id, recipient_id, category, title, detail, case_id, link,
             read_at, created_at
      from notify.notifications
      where id = ${row.id}::uuid
        and recipient_id = iam.current_user_id()
    `;

    // The reader is not the recipient, so the select policy hides the row it
    // has just caused to exist. That is the policy working, not a fault, and
    // the id is what a caller needs.
    return created
      ? toNotification(created)
      : {
          id: row.id,
          recipientId: input.recipientId,
          category: input.category,
          title: input.title,
          detail: input.detail ?? null,
          caseId: input.caseId ?? null,
          link: input.link ?? null,
          readAt: null,
          createdAt: new Date().toISOString(),
        };
  };

  return {
    async notify(input): Promise<Notification | null> {
      return tx((sql) => publish(sql, input));
    },

    async notifyAll(inputs): Promise<Notification[]> {
      if (inputs.length === 0) return [];
      return tx(async (sql) => {
        const results: Notification[] = [];
        for (const input of inputs) {
          const created = await publish(sql, input);
          if (created) results.push(created);
        }
        return results;
      });
    },

    async feed(filter): Promise<Page<Notification>> {
      const pageSize = Math.min(Math.max(filter.pageSize ?? 25, 1), 100);
      const page = Math.max(filter.page ?? 1, 1);

      return tx(async (sql) => {
        const unreadOnly = filter.unreadOnly ?? false;

        const [count] = await sql<{ total: string }[]>`
          select count(*)::text as total
          from notify.notifications
          where recipient_id = iam.current_user_id()
            and not in_app_suppressed
            and (read_at is null or not ${unreadOnly}::boolean)
        `;

        const rows = await sql<NotificationRow[]>`
          select id, recipient_id, category, title, detail, case_id, link,
                 read_at, created_at
          from notify.notifications
          where recipient_id = iam.current_user_id()
            and not in_app_suppressed
            and (read_at is null or not ${unreadOnly}::boolean)
          order by created_at desc, id desc
          limit ${pageSize}
          offset ${(page - 1) * pageSize}
        `;

        return { rows: rows.map(toNotification), total: Number(count.total) };
      });
    },

    async unreadCount(): Promise<number> {
      return tx(async (sql) => {
        const [row] = await sql<{ n: string }[]>`
          select count(*)::text as n
          from notify.notifications
          where recipient_id = iam.current_user_id()
            and read_at is null
            and not in_app_suppressed
        `;
        return Number(row.n);
      });
    },

    async markRead(id): Promise<void> {
      return tx(async (sql) => {
        // `read_at is null` keeps the first reading as the true one: marking
        // something read twice should not move the moment it was seen.
        const result = await sql`
          update notify.notifications
          set read_at = now()
          where id = ${id}::uuid
            and recipient_id = iam.current_user_id()
            and read_at is null
        `;

        if (result.count > 0) return;

        const [exists] = await sql<{ one: number }[]>`
          select 1 as one
          from notify.notifications
          where id = ${id}::uuid and recipient_id = iam.current_user_id()
        `;
        // Already read is success; not there at all is either somebody else's
        // notification or none, and from here those are the same thing.
        if (!exists) {
          throw new NotifyError("not_found", "That notification is not in your feed.");
        }
      });
    },

    async markAllRead(): Promise<number> {
      return tx(async (sql) => {
        const result = await sql`
          update notify.notifications
          set read_at = now()
          where recipient_id = iam.current_user_id()
            and read_at is null
            and not in_app_suppressed
        `;
        return result.count;
      });
    },

    async preferences(): Promise<NotificationPreference[]> {
      return tx(async (sql) => {
        // The catalogue is the list, left-joined to the person's choices, so
        // a category they have never touched appears at its default rather
        // than not at all. Absence means on (PRD 12.2).
        const rows = await sql<
          {
            category: NotificationCategory;
            label: string;
            description: string;
            is_mandatory: boolean;
            in_app: boolean;
            email: boolean;
          }[]
        >`
          select
            c.key as category,
            c.label,
            c.description,
            c.is_mandatory,
            coalesce(p.in_app, true) as in_app,
            coalesce(p.email, true) as email
          from notify.categories c
          left join notify.preferences p
            on p.category = c.key and p.user_id = iam.current_user_id()
          order by c.position, c.key
        `;

        return rows.map((row) => ({
          category: row.category,
          label: row.label,
          description: row.description,
          isMandatory: row.is_mandatory,
          inApp: row.is_mandatory || row.in_app,
          email: row.is_mandatory || row.email,
        }));
      });
    },

    async setPreference(input): Promise<void> {
      // Refused here with a sentence somebody can read. The trigger in 0053
      // refuses it too, and that is the guarantee; this is the explanation,
      // and it also means the screen does not have to parse a constraint
      // violation to say something useful.
      if (!input.inApp || !input.email) assertCanBeDisabled(input.category);

      return tx(async (sql) => {
        await sql`
          insert into notify.preferences (user_id, category, in_app, email)
          values (
            iam.current_user_id(), ${input.category}, ${input.inApp}, ${input.email}
          )
          on conflict (user_id, category) do update
          set in_app = excluded.in_app,
              email = excluded.email,
              updated_at = now()
        `;
      });
    },
  };
}

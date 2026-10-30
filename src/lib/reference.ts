import "server-only";
import { cache } from "react";
import type postgres from "postgres";
import { asActor, type Actor } from "@/lib/auth/session";
import { iam } from "@/modules/iam";

/**
 * Reference data a page reads more than once, read once.
 *
 * The case page is built from several independently streamed sections, and
 * each of them needs the same two things: who the active staff are, for an
 * assignee picker, and the classification levels, for a classification
 * select. Asked separately that was four round trips to a database 127ms
 * away, three of them for an answer already in hand.
 *
 * Both take the caller's transaction when there is one, so a screen already
 * reading inside a transaction pays one round trip rather than opening a
 * second connection. `cache` keys on every argument, so the memo is per
 * actor and per transaction: two sections of one page that share a
 * transaction share the answer, and one that opens its own gets its own.
 *
 * `cache` is React's per-request memo, so these are shared across the
 * sections of one render and never across requests or users. The actor is the
 * key, and `requireActor()` is itself memoised per request, so the same
 * object comes back each time and the key is stable. Keying on the actor is
 * not decoration either: both reads go through row-level security, so two
 * people on the same page can legitimately get different answers.
 */

/**
 * The names of active colleagues, for the "who did this" pickers.
 *
 * Reads `iam.staff_directory()` rather than listing `iam.users`, and the
 * difference is not cosmetic. The `iam.users` select policy is
 * `id = current_user_id() OR has_permission('users','view')`, and PRD 16
 * gives `users` rights to CEO/Admin alone, so listing it returned exactly one
 * name to an investigator: their own. A custody entry has to record who
 * released an item and who received it (PRD 6.2), which made the chain of
 * custody unusable by the very people who handle evidence. Every other "who
 * did this" picker was narrowed in the same way, and only looked right
 * because each defaults to the current user.
 *
 * The function returns id and name and nothing else, so nobody gains sight of
 * a colleague's clearance, status or lockout state in order to spell their
 * name. See migration 0052.
 */
export const staffDirectory = cache(
  async (
    actor: Actor,
    tx?: postgres.TransactionSql,
  ): Promise<Array<{ id: string; name: string }>> => {
    // `tx` when a caller already holds one, so this joins their transaction
    // and its actor GUCs rather than opening a second against a pool of one.
    const read = (sql: postgres.TransactionSql) =>
      sql<{ id: string; name: string }[]>`
        select id, name from iam.staff_directory()
      `;

    const rows = tx ? await read(tx) : await asActor(actor, read);
    return rows.map((row) => ({ id: row.id, name: row.name }));
  },
);

export const classificationLevels = cache(
  async (actor: Actor, tx?: postgres.TransactionSql) =>
    iam(actor, tx).org.classificationLevels(),
);

/**
 * Who can do a particular thing, for a notification with an audience rather
 * than a recipient.
 *
 * PRD 8.3 needs a manager to decide a possible conflict and PRD 5.8 needs the
 * supervisor and Operations Manager told about a missed check-in, and in
 * neither case is anybody named in advance: the audience is whoever holds the
 * permission at the time. Reading `iam.users` to work that out is exactly the
 * problem `staffDirectory` above describes, so this goes through
 * `iam.permission_holders`, which returns ids and nothing else. See migration
 * 0057.
 *
 * Ids, deliberately. They are passed straight back into `notify.publish`,
 * which reads the directory itself, so the caller never handles a colleague's
 * name or address in order to send them something.
 */
export const permissionHolders = cache(
  async (
    actor: Actor,
    resource: string,
    action: string,
    tx?: postgres.TransactionSql,
  ): Promise<string[]> => {
    const read = (sql: postgres.TransactionSql) =>
      sql<{ id: string }[]>`
        select id from iam.permission_holders(${resource}, ${action})
      `;

    const rows = tx ? await read(tx) : await asActor(actor, read);
    return rows.map((row) => row.id);
  },
);

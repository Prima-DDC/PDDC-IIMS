import "server-only";
import { cache } from "react";
import type postgres from "postgres";
import type { Actor } from "@/lib/auth/session";
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

export const staffDirectory = cache(
  async (
    actor: Actor,
    tx?: postgres.TransactionSql,
  ): Promise<Array<{ id: string; name: string }>> => {
    const result = await iam(actor, tx).users.list({ status: "active", limit: 200 });
    return result.rows.map((user) => ({
      id: user.id,
      name: user.fullName ?? user.email,
    }));
  },
);

export const classificationLevels = cache(
  async (actor: Actor, tx?: postgres.TransactionSql) =>
    iam(actor, tx).org.classificationLevels(),
);

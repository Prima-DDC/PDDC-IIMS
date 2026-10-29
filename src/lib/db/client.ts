import "server-only";
import postgres from "postgres";
import { SUPABASE_ROOT_CA } from "./supabase-ca";
// Classification is a domain concept, defined in a leaf module with zero
// imports so both the domain layer and this client can use it without a cycle.
import {
  clearsClassification,
  type ClassificationLevel,
} from "@/modules/iam/domain/classification";

/**
 * The IIMS database connection.
 *
 * WHY NOT supabase-js
 * PRD §13 requires the application database role to hold no UPDATE or DELETE
 * privilege on the audit schema. Supabase's `service_role` bypasses RLS and
 * the `postgres` role bypasses it by table ownership, so neither can deliver
 * that guarantee. All data access therefore runs as the restricted `iims_app`
 * role over a direct Postgres connection; supabase-js is used only for auth,
 * storage and realtime.
 *
 * POOLER CONSTRAINTS
 * Transaction-mode pooling (port 6543) does not support prepared statements,
 * so `prepare: false` is mandatory: without it queries fail intermittently
 * and confusingly under load. It also rules out LISTEN/NOTIFY, session
 * advisory locks, WITH HOLD cursors and temp tables; none are used here.
 */

declare global {
  // Reused across hot reloads in development so dev does not exhaust the
  // pooler's client slots (200 on the free plan, shared with the website).
  var __iimsSql: ReturnType<typeof postgres> | undefined;
}

function connectionString(): string {
  const url = process.env.IIMS_APP_DB_URL;
  if (!url) {
    throw new Error(
      "IIMS_APP_DB_URL is not set. Run `npm run db:migrate` then " +
        "`node --env-file=.env.local scripts/bootstrap-app-role.mjs` to create " +
        "the iims_app role, and copy the pooler URL from the Supabase Connect dialog.",
    );
  }
  if (url.includes(":5432/")) {
    // Session mode works, but one long-lived session per serverless instance
    // exhausts the pool quickly. Fail loudly rather than mysteriously later.
    throw new Error(
      "IIMS_APP_DB_URL points at the session-mode pooler (port 5432). Use the " +
        "transaction-mode pooler (port 6543) for the application; 5432 is for migrations.",
    );
  }
  return url;
}

/** Shape-only statement log. Parameters are deliberately not included. */
function logStatement(_connection: number, query: string) {
  const shape = query.replace(/\s+/g, " ").trim().slice(0, 110);
  console.log(`[db] ${shape}`);
}

/**
 * The type parsers the application runs with.
 *
 * Exported so the integration tests can build their client with exactly
 * these. A test that received Date objects where production receives strings
 * would pass while the page it is meant to cover throws, which is how the
 * date handling below came to be wrong in the first place.
 */
export const DB_TYPES = {
  // Keep bigint as a string: audit sequence numbers can exceed 2^53.
  bigint: postgres.BigInt,

  /**
   * Dates and timestamps arrive as strings, not Date objects.
   *
   * postgres.js parses them into Dates by default, while every row type and
   * every domain entity in this codebase declares them as `string`. The two
   * agreed often enough to hide the difference: `new Date(value)` accepts a
   * Date, and so does `toLocaleString`. They disagreed the moment a form
   * prefilled a date input, because `record.dueDate?.slice(0, 10)` on a Date
   * is a TypeError, and a TypeError in a server component is a page that will
   * not load at all. Three features had that latent (tasks, clients and
   * engagements), and nothing would have caught the fourth either.
   *
   * So the declared type becomes the true one, here rather than in a dozen
   * row mappers:
   *
   *   date (1082) stays exactly as Postgres wrote it, "YYYY-MM-DD". A date
   *   has no time and no zone, and turning it into one invents a midnight
   *   that can fall on the previous day.
   *
   *   timestamp and timestamptz (1114, 1184) become ISO 8601 with the "T"
   *   and the zone, which is what `datetime-local` inputs, `new Date()` and
   *   JSON all read without further thought. The wire format is
   *   "2026-10-22 02:30:00.123+00", whose space instead of a "T" a date
   *   input silently rejects.
   */
  date: {
    to: 1082,
    from: [1082],
    serialize: toDateParameter,
    parse: (x: string) => x,
  },
  timestamp: {
    to: 1184,
    from: [1114, 1184],
    serialize: toDateParameter,
    parse: (x: string) => new Date(x).toISOString(),
  },
};

function create() {
  return postgres(connectionString(), {
    // Mandatory for transaction-mode pooling.
    prepare: false,
    // Ten, measured rather than guessed. A single connection serialises every
    // query in the process, so a page that reads several things at once
    // queues them behind each other, and the queue is invisible: it looks
    // like a hang rather than a slow query.
    //
    // A case page opens eighteen transactions, because each repository call
    // opens its own, and two thirds of its statements are the BEGIN,
    // set_config and COMMIT around the reads. Against a database 127ms away
    // that page took 7.5s with five connections, 5.6s with twelve and 5.2s
    // with twenty: the gain flattens once the waves of queueing are gone, so
    // ten is where this sits. Supavisor fans these in, and the free plan
    // allows 200 client connections across the project, which is shared with
    // the primaddc.com website, so this is deliberately not larger.
    //
    // The round trip itself is the real cost and the real fix is deployment
    // in the database's region, where it is single-digit milliseconds. See
    // docs/PROGRESS.md.
    max: Number(process.env.IIMS_DB_MAX_CONNECTIONS ?? 10),
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: {
      ca: SUPABASE_ROOT_CA,
      rejectUnauthorized: true,
    },
    connection: {
      application_name: "pddc-iims",
    },
    // Never log parameter values: they carry subject names and evidence
    // metadata. Shape only, and only when asked for: IIMS_DB_DEBUG=1 prints
    // one line per statement so a slow page can be traced to its round trips,
    // which is the thing that actually costs time against a hosted database.
    debug: process.env.IIMS_DB_DEBUG === "1" ? logStatement : false,
    onnotice: () => {},
    types: DB_TYPES,
  });
}

/**
 * Serialises a date parameter.
 *
 * Registering a parser for an OID registers this as its serialiser too, so a
 * `Date` passed as a parameter would otherwise be sent as whatever
 * `toString()` produces. Everything in this codebase passes ISO strings, and
 * this is here so that the one place that does not stays correct.
 */
function toDateParameter(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export const sql: ReturnType<typeof postgres> =
  globalThis.__iimsSql ?? (globalThis.__iimsSql = create());

if (process.env.NODE_ENV !== "production") {
  globalThis.__iimsSql = sql;
}

/** Who is acting, and at what clearance, for one unit of work. */
export interface ActorContext {
  /** auth.users.id: the shared identity with primaddc.com. */
  userId: string;
  /** Highest classification this user may see (PRD §7.4). */
  clearance: ClassificationLevel;
  /** Correlation id threaded through logs and the audit trail (PRD §21.8). */
  requestId: string;
  /** Authenticator assurance level from the Supabase JWT: aal1 or aal2. */
  aal?: "aal1" | "aal2";
  /** Caller IP and user agent, recorded on every audit row (PRD 13). */
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Runs `work` in a single transaction with the actor's identity published as
 * transaction-local settings, which is what RLS policies and the audit
 * triggers read.
 *
 * Every read and write in the application goes through here. The settings are
 * set with `is_local = true`, so they are scoped to this transaction and
 * cannot leak to the next borrower of a pooled connection.
 *
 * Policies are written to FAIL CLOSED: they read
 * `nullif(current_setting('iims.user_id', true), '')::uuid`, so a query that
 * somehow escapes this wrapper sees a NULL actor and is denied rather than
 * silently granted. Never add a `coalesce(..., '<something>')` fallback.
 */
export async function withActor<T>(
  actor: ActorContext,
  work: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  try {
    return (await sql.begin(async (tx) => {
      await applyActorSettings(tx, actor);
      return work(tx);
    })) as T;
  } catch (error) {
    if (!isLostConnection(error)) throw error;

    // One retry, and only for a lost connection. See the note below for why
    // this is safe and why it is necessary.
    return (await sql.begin(async (tx) => {
      await applyActorSettings(tx, actor);
      return work(tx);
    })) as T;
  }
}

/**
 * Whether a failure is the connection going away rather than the database
 * refusing something.
 *
 * WHY THIS EXISTS
 * The Supavisor transaction-mode pooler closes a client connection from time
 * to time in the middle of a transaction. Measured here: registering a
 * subject failed roughly one attempt in two with
 * `write CONNECTION_CLOSED aws-0-eu-west-1.pooler.supabase.com:6543`, after
 * the INSERT and the audit write had already been sent. The page it was
 * submitted from loaded perfectly either side of it, the auth endpoint
 * answered in under a second, and no SQL error was raised: the socket simply
 * went. It presents to a user as "Something went wrong saving that", with
 * nothing in the record and nothing to act on, which is the worst shape a
 * failure can take.
 *
 * WHY A RETRY IS CORRECT HERE AND NOT A PAPERING-OVER
 * A lost connection means the transaction did not commit. Postgres rolls back
 * everything a dead backend was doing, so there is no half-applied write to
 * reason about and no risk of doing the work twice: the choice is between
 * doing it once and not doing it at all. That is exactly the case where a
 * retry is the honest answer.
 *
 * WHAT IS DELIBERATELY NOT RETRIED
 * Anything the database decided. A constraint violation, an RLS refusal, a
 * serialisation failure or a lock timeout are all answers, and repeating the
 * statement would either get the same answer or, worse, succeed on the second
 * go for a reason nobody understands. Only the codes below are retried, and
 * only once: a pooler that has gone twice in a row is a pooler that is down,
 * and the caller deserves to be told rather than kept waiting.
 */
function isLostConnection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === "CONNECTION_CLOSED" ||
    code === "CONNECTION_ENDED" ||
    code === "CONNECTION_DESTROYED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    // postgres.js reports the pooler terminating a backend as this, which is
    // the same situation seen from the server's side.
    code === "57P01"
  );
}

/**
 * Which actor each open transaction has already been configured for.
 *
 * The settings are transaction-local, so once published for an actor in a
 * transaction they hold until it ends, and publishing them again is a wasted
 * round trip. That matters more than it sounds: a screen that shares one
 * transaction across a dozen repository calls would otherwise pay a
 * `set_config` before each of them, and because each call awaits its own
 * setting first, nothing after it can be pipelined. Measured: a case page
 * went from 6.9s to 18.4s when the reads were batched without this, and the
 * round trips were the whole difference.
 *
 * A WeakMap keyed on the transaction, holding the actor it was configured
 * for, so a transaction reused by a different actor is still configured
 * correctly and an ended transaction is collected with it.
 */
const configuredFor = new WeakMap<object, string>();

/**
 * Publishes the actor as transaction-local settings.
 *
 * Exported because a caller that already holds a transaction (a multi-step use
 * case, or a test harness driving a repository) must be able to establish the
 * same context. Keeping it in one function is what stops the two paths from
 * drifting: the audit triggers and RLS policies read exactly these keys.
 */
export async function applyActorSettings(
  tx: postgres.TransactionSql,
  actor: ActorContext,
): Promise<void> {
  // The request id is part of the key: a second unit of work in the same
  // transaction with a different correlation id genuinely needs re-publishing,
  // because the audit rows it writes carry it.
  const fingerprint = `${actor.userId}|${actor.clearance}|${actor.requestId}`;
  if (configuredFor.get(tx) === fingerprint) return;
  configuredFor.set(tx, fingerprint);

  await tx`
    select
      set_config('iims.user_id',    ${actor.userId},    true),
      set_config('iims.clearance',  ${actor.clearance}, true),
      set_config('iims.request_id', ${actor.requestId}, true),
      set_config('iims.aal',        ${actor.aal ?? "aal1"}, true),
      set_config('iims.ip',         ${actor.ip ?? ""}, true),
      set_config('iims.user_agent', ${actor.userAgent ?? ""}, true)
  `;
}

/**
 * For the few operations that legitimately have no user: cron workers and the
 * outbox drainer. Still a transaction, still auditable: the audit row simply
 * records a null actor and names the system process in `actor_email`.
 */
export async function withSystemActor<T>(
  process_: string,
  requestId: string,
  work: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`
      select
        set_config('iims.system_process', ${process_}, true),
        set_config('iims.request_id',     ${requestId}, true),
        set_config('iims.clearance',      'INTERNAL', true)
    `;
    return work(tx);
  }) as Promise<T>;
}

// Re-exported so callers of the database layer do not need two imports.
export { clearsClassification };
export type { ClassificationLevel };

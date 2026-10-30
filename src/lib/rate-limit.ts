import "server-only";
import { sql } from "@/lib/db/client";

/**
 * Rate limiting (PRD 14).
 *
 * Fixed windows counted in Postgres, because there is no Redis: PRD 21.3 asks
 * for one and Supabase does not provide it. The counter and the decision are
 * one statement in `config.take_rate_limit`, so two requests arriving
 * together cannot both read one-under-the-limit and both proceed.
 *
 * WHERE THIS IS AND IS NOT THE RIGHT TOOL. It defends route handlers, which
 * are reachable by anybody who can reach the application: the cron workers,
 * the export, the webhook. It is NOT the defence for sign-in, which has its
 * own per-account lockout in `iam.login_attempts` because the thing being
 * defended there is one account rather than the service, and an IP limit
 * would let a distributed attempt through while locking out an office that
 * shares an address.
 *
 * Runs outside the actor wrapper on purpose. A rate limit has to be
 * answerable before anybody is identified, which is most of its value: the
 * request that should be refused is often the one with no valid session.
 */

export interface RateLimitResult {
  allowed: boolean;
  hits: number;
  retryAfterSeconds: number;
}

export async function takeRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  try {
    const [row] = await sql<
      { allowed: boolean; hits: number; retry_after_seconds: number }[]
    >`
      select allowed, hits, retry_after_seconds
      from config.take_rate_limit(${bucket}, ${limit}, ${windowSeconds})
    `;

    return {
      allowed: row.allowed,
      hits: row.hits,
      retryAfterSeconds: row.retry_after_seconds,
    };
  } catch (error) {
    /*
     * FAILS OPEN, deliberately, and this is the one decision here worth
     * arguing about.
     *
     * If the database is unreachable, the limiter cannot answer. Failing
     * closed would mean a database blip takes the platform down completely,
     * including for the people trying to diagnose it; failing open means a
     * flood is unthrottled during an outage in which almost nothing else
     * works either. The limiter is not the authorisation layer: every route
     * behind it still checks a secret or a permission, and those do fail
     * closed. So the risk of failing open is extra load, and the risk of
     * failing closed is an outage.
     */
    console.error(`[rate-limit] could not count ${bucket}`, error);
    return { allowed: true, hits: 0, retryAfterSeconds: 0 };
  }
}

/** The caller's address, as far as it can be trusted behind a proxy. */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

/**
 * The limits, in one place so they can be read as a set.
 *
 * Each is generous for its real caller and tight enough to stop a loop. The
 * cron routes are the clearest case: a schedule calls them once a minute, so
 * ten a minute is six times what they need and still stops a stuck scheduler
 * from draining a free email allowance.
 */
export const RATE_LIMITS = {
  cron: { limit: 10, windowSeconds: 60 },
  // An export is one file somebody opens and reads. Twenty an hour is more
  // than anybody does by hand, and it is the route most worth limiting
  // because each one is a full read of the case register.
  export: { limit: 20, windowSeconds: 3_600 },
  webhook: { limit: 300, windowSeconds: 60 },
} as const;

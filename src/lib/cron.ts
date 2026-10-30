import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { RATE_LIMITS, clientAddress, takeRateLimit } from "./rate-limit";

/**
 * Authenticating a scheduled call.
 *
 * `pg_cron` bodies do nothing but `net.http_post` to a route handler here,
 * which is the whole reason this file exists: a cron job runs as the role
 * that scheduled it, `postgres`, which owns every table and bypasses its own
 * policies. Doing the work inside the database would mean doing it with full
 * privileges and no audit identity. So the schedule posts a request, the
 * route connects back as `iims_app` under a named system process, and the
 * normal controls apply.
 *
 * The secret proves the caller is the schedule. It is compared in constant
 * time, because a comparison that returns early leaks the length of the
 * matching prefix to anybody willing to time it.
 */

export type CronOutcome<T> =
  | { ok: true; body: T }
  | { ok: false; response: NextResponse };

export async function authoriseCron(request: Request): Promise<NextResponse | null> {
  const expected = process.env.CRON_WORKER_SECRET;

  if (!expected) {
    // Refusing is the only safe answer. An unset secret with an open route
    // would mean anybody could drive the workers, and a worker that drains a
    // queue is a worker that can send email.
    console.error("[cron] CRON_WORKER_SECRET is not set, so the route refuses");
    return NextResponse.json(
      { error: "This worker is not configured." },
      { status: 503 },
    );
  }

  const presented =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // one bit; comparing the lengths first and then the bytes gives the same
  // answer without the exception.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  /*
   * Counted AFTER the secret is checked, so a flood of unauthenticated
   * requests cannot exhaust the window and lock the real scheduler out of
   * its own route. The secret is the gate; this is the brake behind it, for
   * a scheduler that has got stuck.
   */
  const limit = await takeRateLimit(
    `cron:${new URL(request.url).pathname}:${clientAddress(request)}`,
    RATE_LIMITS.cron.limit,
    RATE_LIMITS.cron.windowSeconds,
  );

  if (!limit.allowed) {
    console.warn(
      `[cron] ${new URL(request.url).pathname} called ${limit.hits} times in a minute, which is more than a schedule does`,
    );
    return NextResponse.json(
      { error: "Called too often.", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  return null;
}

import { afterAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { testSql } from "../helpers/sql";
import { takeRateLimit } from "@/lib/rate-limit";

/**
 * Idempotency and rate limiting against the real Postgres (PRD 14, 21.7).
 *
 * The functions, not the TypeScript wrapper around them. `idempotent()`
 * resolves an actor from a request and opens its own transactions through
 * `withActor`, so driving it from a test would commit outside the rollback
 * and leave keys in the live table. What it does is thin; what the functions
 * decide is the part worth proving, and these call them exactly as it does.
 *
 * The migration asserts the happy path at apply time. These cover the cases a
 * migration cannot conveniently reach: concurrency, expiry, the takeover of a
 * claim whose owner died, and the window boundary.
 */

const hasDb = Boolean(process.env.SUPABASE_DB_URL);
const suite = describe.skipIf(!hasDb);

const sql = hasDb ? testSql() : null;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

class Rollback extends Error {}

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

async function anActiveUser(tx: postgres.TransactionSql): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    select id from iam.users
    where status = 'active' and deleted_at is null
    limit 1
  `;
  return row.id;
}

type Claim = { outcome: string; response: { success?: string } | null };

suite("idempotency (PRD 21.7)", () => {
  const hash = (seed: string) => seed.repeat(64).slice(0, 64);

  it("runs once and replays the same answer", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await anActiveUser(tx);
      await tx`select set_config('iims.user_id', ${user}, true)`;

      const claim = (h: string) => tx<Claim[]>`
        select outcome, response
        from config.claim_idempotency_key('k1', 'probe.create', ${h})
      `;

      const [first] = await claim(hash("a"));
      expect(first.outcome).toBe("proceed");

      await tx`
        select config.complete_idempotency_key(
          'k1', 'probe.create', '{"success":"PDDC-2026-000001 opened"}'::jsonb
        )
      `;

      const [second] = await claim(hash("a"));
      expect(second.outcome).toBe("replay");
      // The same confirmation the first attempt gave, which is the whole
      // point: one record written, and the person sees the same sentence
      // rather than a second case number.
      expect(second.response?.success).toBe("PDDC-2026-000001 opened");
    });
  });

  it("refuses the same key with a different body", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await anActiveUser(tx);
      await tx`select set_config('iims.user_id', ${user}, true)`;

      await tx`
        select outcome from config.claim_idempotency_key('k2', 'probe.create', ${hash("a")})
      `;
      await tx`
        select config.complete_idempotency_key('k2', 'probe.create', '{"success":"done"}'::jsonb)
      `;

      const [again] = await tx<Claim[]>`
        select outcome, response
        from config.claim_idempotency_key('k2', 'probe.create', ${hash("b")})
      `;

      // PRD 21.7's 422 case. Serving the stored answer here would tell
      // somebody their new values were saved when the old ones were.
      expect(again.outcome).toBe("conflict");
      expect(again.response).toBeNull();
    });
  });

  it("scopes a key to its endpoint, so one key is not two answers", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await anActiveUser(tx);
      await tx`select set_config('iims.user_id', ${user}, true)`;

      await tx`
        select outcome from config.claim_idempotency_key('k3', 'cases.create', ${hash("a")})
      `;

      const [other] = await tx<Claim[]>`
        select outcome, response
        from config.claim_idempotency_key('k3', 'clients.create', ${hash("a")})
      `;

      expect(other.outcome).toBe("proceed");
    });
  });

  it("scopes a key to its user, so nobody replays somebody else's answer", async () => {
    await inRolledBackTx(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        select id from iam.users
        where status = 'active' and deleted_at is null
        limit 2
      `;
      if (rows.length < 2) return;

      await tx`select set_config('iims.user_id', ${rows[0].id}, true)`;
      await tx`
        select outcome from config.claim_idempotency_key('k4', 'probe.create', ${hash("a")})
      `;
      await tx`
        select config.complete_idempotency_key('k4', 'probe.create', '{"success":"theirs"}'::jsonb)
      `;

      await tx`select set_config('iims.user_id', ${rows[1].id}, true)`;
      const [mine] = await tx<Claim[]>`
        select outcome, response
        from config.claim_idempotency_key('k4', 'probe.create', ${hash("a")})
      `;

      expect(mine.outcome).toBe("proceed");
      expect(mine.response).toBeNull();
    });
  });

  it("tells a concurrent duplicate to wait rather than doing the work twice", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await anActiveUser(tx);
      await tx`select set_config('iims.user_id', ${user}, true)`;

      const [first] = await tx<Claim[]>`
        select outcome, response
        from config.claim_idempotency_key('k5', 'probe.create', ${hash("a")})
      `;
      expect(first.outcome).toBe("proceed");

      // Still running: the row exists, matches, and has no response. The
      // claim was made more than a second ago as far as the function is
      // concerned only if the clock has moved, so this is nudged back to make
      // the state unambiguous.
      await tx`
        update config.idempotency_keys
        set created_at = now() - interval '5 seconds'
        where key = 'k5' and endpoint = 'probe.create'
      `;

      const [second] = await tx<Claim[]>`
        select outcome, response
        from config.claim_idempotency_key('k5', 'probe.create', ${hash("a")})
      `;
      expect(second.outcome).toBe("running");
    });
  });

  it("lets a caller take over a claim whose owner died", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await anActiveUser(tx);
      await tx`select set_config('iims.user_id', ${user}, true)`;

      await tx`
        select outcome from config.claim_idempotency_key('k6', 'probe.create', ${hash("a")})
      `;

      // A worker that crashed between claiming and completing would otherwise
      // leave the operation unrepeatable for a day.
      await tx`
        update config.idempotency_keys
        set created_at = now() - interval '10 minutes'
        where key = 'k6' and endpoint = 'probe.create'
      `;

      const [retry] = await tx<Claim[]>`
        select outcome, response
        from config.claim_idempotency_key('k6', 'probe.create', ${hash("a")})
      `;
      expect(retry.outcome).toBe("proceed");
    });
  });

  it("releases a claim so a corrected submission is not refused for ever", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await anActiveUser(tx);
      await tx`select set_config('iims.user_id', ${user}, true)`;

      await tx`
        select outcome from config.claim_idempotency_key('k7', 'probe.create', ${hash("a")})
      `;

      // What `idempotent()` does when the action returns an error: somebody
      // was told to check a field, corrects it, and submits the same form
      // again under the same key with a different body. A stored failure
      // would meet that with "conflict" every time.
      await tx`select config.release_idempotency_key('k7', 'probe.create')`;

      const [corrected] = await tx<Claim[]>`
        select outcome, response
        from config.claim_idempotency_key('k7', 'probe.create', ${hash("b")})
      `;
      expect(corrected.outcome).toBe("proceed");
    });
  });

  it("will not release a claim that already succeeded", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await anActiveUser(tx);
      await tx`select set_config('iims.user_id', ${user}, true)`;

      await tx`
        select outcome from config.claim_idempotency_key('k8', 'probe.create', ${hash("a")})
      `;
      await tx`
        select config.complete_idempotency_key('k8', 'probe.create', '{"success":"kept"}'::jsonb)
      `;
      await tx`select config.release_idempotency_key('k8', 'probe.create')`;

      // A completed key is the record that the work was done. Releasing it
      // would let the same submission run a second time.
      const [still] = await tx<Claim[]>`
        select outcome, response
        from config.claim_idempotency_key('k8', 'probe.create', ${hash("a")})
      `;
      expect(still.outcome).toBe("replay");
      expect(still.response?.success).toBe("kept");
    });
  });

  it("refuses a caller it cannot identify", async () => {
    await inRolledBackTx(async (tx) => {
      await tx`select set_config('iims.user_id', '', true)`;

      await expect(
        tx.savepoint(async (sp) => {
          await sp`
            select outcome from config.claim_idempotency_key('k9', 'probe', ${hash("a")})
          `;
        }),
      ).rejects.toThrow(/identified caller/i);
    });
  });
});

suite("rate limiting (PRD 14)", () => {
  /**
   * Counted outside a transaction, because `takeRateLimit` uses the
   * application's own connection rather than the test's.
   *
   * So the bucket name is unique per run and the rows are deleted afterwards.
   * A fixed-window counter is write-only state with no business meaning; the
   * alternative, mocking the clock, would test the mock.
   */
  const bucket = `test:${crypto.randomUUID()}`;

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from config.rate_limits where bucket like 'test:%'`;
  });

  it("allows up to the limit and refuses after it", async () => {
    const first = await takeRateLimit(bucket, 3, 60);
    const second = await takeRateLimit(bucket, 3, 60);
    const third = await takeRateLimit(bucket, 3, 60);
    const fourth = await takeRateLimit(bucket, 3, 60);

    expect([first.allowed, second.allowed, third.allowed]).toEqual([
      true,
      true,
      true,
    ]);
    expect(fourth.allowed).toBe(false);
    expect(fourth.hits).toBe(4);
    // A refusal that does not say when to try again is a refusal somebody
    // retries immediately.
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
    expect(fourth.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("counts each bucket separately", async () => {
    const other = `test:${crypto.randomUUID()}`;
    const result = await takeRateLimit(other, 1, 60);
    expect(result.allowed).toBe(true);
    expect(result.hits).toBe(1);
  });

  it("shares one window between callers rather than giving each their own", async () => {
    const shared = `test:${crypto.randomUUID()}`;

    // Fired together, which is the case a read-then-write limiter gets wrong:
    // both would see one-under-the-limit and both proceed.
    const results = await Promise.all([
      takeRateLimit(shared, 10, 60),
      takeRateLimit(shared, 10, 60),
      takeRateLimit(shared, 10, 60),
      takeRateLimit(shared, 10, 60),
      takeRateLimit(shared, 10, 60),
    ]);

    expect(results.every((r) => r.allowed)).toBe(true);
    expect(Math.max(...results.map((r) => r.hits))).toBe(5);
    // Five distinct counts, so nothing was lost to a race.
    expect(new Set(results.map((r) => r.hits)).size).toBe(5);
  });
});

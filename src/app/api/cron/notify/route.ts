import { NextResponse } from "next/server";
import { authoriseCron } from "@/lib/cron";
import { drainEmailOutbox } from "@/modules/notify";

/**
 * Drains the email outbox (PRD 12.2).
 *
 * Scheduled every minute. Everything it needs to be safe is below it rather
 * than here: the queue functions accept only a system process with no
 * signed-in user, the attempt is counted when a row is claimed, and the
 * outbox cannot hold case content in the first place. This handler proves the
 * caller is the schedule and reports what happened.
 *
 * Returns 200 even when sends failed, because the request succeeded: the
 * schedule asked the worker to run and it ran. A non-200 would make
 * `cron.job_run_details` fill with failures describing a mail relay rather
 * than describing anything about the call.
 */
export async function POST(request: Request) {
  const refusal = authoriseCron(request);
  if (refusal) return refusal;

  const started = Date.now();

  try {
    const result = await drainEmailOutbox();

    // Only worth a line when it did something. A minute-level schedule that
    // logged every empty pass would bury the interesting ones.
    if (result.claimed > 0) {
      console.log(
        `[notify] drained ${result.claimed}: ${result.sent} sent, ` +
          `${result.requeued} requeued, ${result.deadLettered} dead-lettered, ` +
          `${Date.now() - started}ms`,
      );
    }

    return NextResponse.json({ ...result, ms: Date.now() - started });
  } catch (error) {
    // A failure here is the worker itself, not a send: a missing SMTP
    // password, or the database refusing the claim. Claimed rows keep their
    // lease and come back round in five minutes, so nothing is lost.
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[notify] the outbox worker failed to run", error);

    return NextResponse.json(
      { error: reason, note: "Leased rows return when the lease expires." },
      { status: 500 },
    );
  }
}

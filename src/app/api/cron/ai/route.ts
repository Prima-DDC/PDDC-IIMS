import { NextResponse } from "next/server";
import { authoriseCron } from "@/lib/cron";
import { PROMPT_VERSION, buildRequest, drainQueue } from "@/modules/ai";
import { actorForBackgroundWork } from "@/lib/auth/session";
import { createRetrieval } from "@/features/ai/retrieval";

/**
 * Runs the AI queue (PRD 22.1).
 *
 * Every five minutes. Free tiers are rate-limited per minute and per day, so
 * a tighter schedule would spend the day's allowance on the morning, and a
 * looser one would make the assistant feel broken. Five minutes with a small
 * batch is the compromise, and the circuit breaker does the rest.
 *
 * THE PROMPT IS REBUILT HERE, not stored. The queue holds a question and a
 * redaction map and no case material at all, which is the property worth
 * keeping: a table of prompts would be a second copy of everything the
 * platform was about to disclose, sitting outside the records those passages
 * belong to.
 *
 * Rebuilding also re-applies the gate against the case AS IT IS NOW. If an
 * exhibit has been reclassified upward since the question was asked, the
 * rebuild refuses it, and a request that was permissible at 09:00 is not sent
 * at 09:05. A stored prompt could not have noticed.
 */
export async function POST(request: Request) {
  const refusal = authoriseCron(request);
  if (refusal) return refusal;

  const started = Date.now();

  try {
    /*
     * The queue is anonymous; retrieval is not.
     *
     * Claiming a job, recording its result and reading the allow-list all run
     * as a named system process with no user, because work attributed to
     * somebody who did not do it corrupts the audit trail. Retrieval is the
     * opposite case: it HAS to run as the person who asked, or the assistant
     * could ground an answer in a record its user cannot open. So each job's
     * prompt is rebuilt as its requester and nothing else is.
     */
    const result = await drainQueue({
      limit: 5,
      rebuild: async (job) => {
        if (!job.caseId || !job.subject) return null;

        const asker = await actorForBackgroundWork("ai-drain", job.requestedBy);
        const retrieval = createRetrieval(asker);

        const { passages, knownNames } = await retrieval.passagesFor({
          caseId: job.caseId,
          question: job.subject,
        });

        try {
          const built = buildRequest({
            question: job.subject,
            passages,
            knownNames,
          });
          return { sendable: built.sendable, cited: built.cited };
        } catch {
          // The gate refused on the rebuild, which means the case changed.
          // Returning null fails the job with a sentence rather than sending
          // something that is no longer permitted.
          return null;
        }
      },
    });

    if (result.claimed > 0) {
      console.log(
        `[ai] ran ${result.claimed}: ${result.succeeded} answered, ` +
          `${result.failed} failed, ${Date.now() - started}ms, prompt ${PROMPT_VERSION}`,
      );
    }

    return NextResponse.json({ ...result, ms: Date.now() - started });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[ai] the queue worker failed to run", error);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}

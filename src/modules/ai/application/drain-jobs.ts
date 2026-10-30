import { AiError } from "../domain/errors";
import {
  SYSTEM_PROMPT,
  breakerDelayMs,
  parseSuggestion,
  providerIsAvailable,
  restore,
  shouldTryNextProvider,
} from "../domain/policies";
import type { AiProvider, Sendable, Suggestion } from "../domain/types";
import type {
  JobRepository,
  ModelPort,
  ProviderRepository,
} from "./ports";

/**
 * The router and the worker (PRD 22.1).
 *
 * Providers are tried in the order an administrator put them in, skipping any
 * whose breaker is open, until one answers. A provider that fails has its
 * breaker advanced; a provider that answers has it cleared. With no provider
 * available the job fails with a sentence saying so, and the platform carries
 * on: PRD 22 makes AI assistive, so "the assistant is unavailable" is a
 * supported state rather than an incident.
 *
 * What is deliberately NOT here: any attempt to repair a malformed request by
 * trying it elsewhere. `shouldTryNextProvider` sends us on for a rate limit
 * or an outage and stops for a 400, because the same bad request will be
 * refused by every provider and each refusal spends a request from a free
 * allowance that is shared across PDDC.
 */

export interface DrainJobsResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

export async function drainAiJobs(input: {
  jobs: JobRepository;
  providers: ProviderRepository;
  model: ModelPort;
  limit?: number;
  /**
   * Rebuilds the prompt for a claimed job. The queue stores no prompt.
   *
   * `requestedBy` is part of the job because retrieval has to run under that
   * person's permissions: the whole point of grounding is that the assistant
   * cannot read a record its asker could not open, and a worker retrieving as
   * itself would quietly have more reach than any of them.
   */
  rebuild: (job: {
    id: string;
    caseId: string | null;
    subject: string | null;
    requestedBy: string;
  }) => Promise<{ sendable: Sendable; cited: string[] } | null>;
}): Promise<DrainJobsResult> {
  const batch = await input.jobs.claim(input.limit ?? 5);
  const result: DrainJobsResult = {
    claimed: batch.length,
    succeeded: 0,
    failed: 0,
  };

  if (batch.length === 0) return result;

  const allProviders = await input.providers.listForWorker();

  for (const { job, redactions } of batch) {
    try {
      /*
       * The prompt is rebuilt rather than stored.
       *
       * Storing it would mean a table holding the case material that was
       * about to leave the platform, in a schema whose whole purpose is that
       * such material does not accumulate anywhere it need not. Rebuilding
       * costs a retrieval and gets the gate and the redactor applied again,
       * against the case as it is NOW: if an exhibit has been reclassified
       * upward since the question was asked, the rebuild refuses it.
       */
      const rebuilt = await input.rebuild(job);
      if (!rebuilt) {
        await input.jobs.recordResult({
          id: job.id,
          status: "failed",
          error:
            "The case records this question was asked about can no longer be assembled, so nothing was sent.",
        });
        result.failed += 1;
        continue;
      }

      const answer = await callWithFailover({
        providers: allProviders,
        sendable: rebuilt.sendable,
        model: input.model,
        onOutcome: (key, ok, error, nextAttemptAt) =>
          input.providers.recordOutcome({ key, ok, error, nextAttemptAt }),
      });

      // Restored before parsing, so the citations and the text come back in
      // one pass and nothing downstream has to know redaction happened.
      const suggestion: Suggestion = parseSuggestion(
        restore(answer.text, redactions),
        rebuilt.cited,
      );

      await input.jobs.recordResult({
        id: job.id,
        status: "succeeded",
        providerKey: answer.providerKey,
        model: answer.model,
        promptTokens: answer.promptTokens,
        completionTokens: answer.completionTokens,
        output: suggestion,
        // Only worth caching an answer that said something. An empty
        // suggestion cached would make a provider's bad minute permanent.
        cacheIt: suggestion.statements.length > 0,
      });
      result.succeeded += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await input.jobs.recordResult({
        id: job.id,
        status: "failed",
        error: reason,
      });
      result.failed += 1;
    }
  }

  return result;
}

async function callWithFailover(input: {
  providers: AiProvider[];
  sendable: Sendable;
  model: ModelPort;
  onOutcome: (
    key: string,
    ok: boolean,
    error: string | null,
    nextAttemptAt: string | null,
  ) => Promise<void>;
}): Promise<{
  text: string;
  providerKey: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
}> {
  const now = Date.now();

  const candidates = input.providers
    .filter((provider) => providerIsAvailable(provider, now))
    // A provider whose own ceiling is below what we are sending is skipped
    // rather than refused: a free public model capped at PUBLIC must not see
    // INTERNAL material even though PRD 22.4 permits INTERNAL in general.
    .filter(
      (provider) =>
        input.sendable.classification === "PUBLIC" ||
        provider.maxClassification !== "PUBLIC",
    )
    .sort((a, b) => a.position - b.position);

  if (candidates.length === 0) {
    throw new AiError(
      "no_provider",
      input.providers.length === 0
        ? "No AI provider has been added. An administrator records one, with its data-retention terms, before the assistant can be used (PRD 22.4)."
        : "Every allow-listed provider is either disabled or rate-limited at the moment. The platform works without the assistant; try again shortly.",
    );
  }

  const failures: string[] = [];

  for (const provider of candidates) {
    try {
      const answer = await input.model.complete({
        provider,
        sendable: input.sendable,
      });

      await input.onOutcome(provider.key, true, null, null);

      return {
        text: answer.text,
        providerKey: provider.key,
        model: provider.model,
        promptTokens: answer.promptTokens,
        completionTokens: answer.completionTokens,
      };
    } catch (error) {
      const status = (error as { status?: number }).status;
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${provider.key}: ${reason}`);

      const nextAttemptAt = new Date(
        Date.now() + breakerDelayMs(provider.consecutiveFailures + 1),
      ).toISOString();
      await input.onOutcome(provider.key, false, reason, nextAttemptAt);

      if (!shouldTryNextProvider(status)) {
        throw new AiError(
          "validation_failed",
          `${provider.key} refused the request itself rather than being unavailable, so no other provider was tried: ${reason}`,
        );
      }
    }
  }

  throw new AiError(
    "all_providers_exhausted",
    `Every provider was tried and none answered. ${failures.join("; ")}`,
    { failures },
  );
}

/** Exported so the admin screen can show what the gateway would send. */
export { SYSTEM_PROMPT };

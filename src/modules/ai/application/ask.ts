import { createHash } from "node:crypto";
import { AiError } from "../domain/errors";
import {
  PROMPT_VERSION,
  assertWithinQuota,
  buildRequest,
} from "../domain/policies";
import type { AiJob, Suggestion } from "../domain/types";
import type { JobRepository, RetrievalPort } from "./ports";

/**
 * Asking the assistant a question about a case (PRD 22.2, 22.3, 22.4).
 *
 * The order of what happens here is the design, and each step is there
 * because skipping it would break a rule rather than because it is tidy:
 *
 *   1. Quota, before anything else. A request refused for quota should cost
 *      nothing, not a retrieval over four schemas.
 *   2. Retrieval, under the asker's own permissions. The port reads through
 *      the same repositories the screens do, so the assistant can never see
 *      a case, finding or exhibit its user could not open.
 *   3. The request is built, which applies the classification gate and the
 *      redactor. `buildRequest` is the only way to produce the type the
 *      transport accepts.
 *   4. The cache is consulted. An identical question about identical material
 *      under an identical prompt is free (PRD 22.1).
 *   5. Otherwise it is queued. Nothing is sent inline: a free provider takes
 *      seconds to tens of seconds, the queue is where fairness lives, and a
 *      page that waits for a model is a page that times out.
 *
 * A request the gate refuses outright is RECORDED as blocked rather than
 * thrown away. PRD 22.4's audit requirement is about what was sent, and
 * "somebody asked a question that would have required confidential material"
 * is exactly the kind of thing an auditor should be able to find.
 */
export async function askAboutCase(input: {
  caseId: string;
  question: string;
  jobs: JobRepository;
  retrieval: RetrievalPort;
}): Promise<
  | { outcome: "cached"; suggestion: Suggestion; withheld: Array<{ reference: string; classification: string }> }
  | { outcome: "queued"; job: AiJob; withheld: Array<{ reference: string; classification: string }> }
  | { outcome: "blocked"; job: AiJob; reason: string }
> {
  const question = input.question.trim();

  if (question.length < 8) {
    throw new AiError(
      "validation_failed",
      "Ask a question. Eight characters at least: the assistant answers only from this case's records, so it needs to know what to look for.",
    );
  }

  const used = await input.jobs.usageToday(input.caseId);
  assertWithinQuota(used);

  const { passages, knownNames, withheld } = await input.retrieval.passagesFor({
    caseId: input.caseId,
    question,
  });

  let built;
  try {
    built = buildRequest({ question, passages, knownNames });
  } catch (error) {
    // The two refusals that are decisions rather than faults, both worth
    // keeping: nothing to answer from, and something above INTERNAL reached
    // the builder. Either way nothing was sent.
    if (
      error instanceof AiError &&
      (error.code === "classification_blocked" ||
        error.code === "nothing_to_ground_on")
    ) {
      const job = await input.jobs.recordBlocked({
        caseId: input.caseId,
        kind: "assist",
        promptVersion: PROMPT_VERSION,
        inputHash: hashOf(PROMPT_VERSION, question, []),
        subject: question.slice(0, 200),
        reason: error.message,
      });
      return { outcome: "blocked", job, reason: error.message };
    }
    throw error;
  }

  // The hash covers the prompt version, the question and the exact passages,
  // so a case that has changed since the question was last asked produces a
  // different key rather than a stale answer.
  const inputHash = hashOf(PROMPT_VERSION, question, built.cited.map((reference, index) => `${reference}:${passages[index]?.text ?? ""}`));

  const cached = await input.jobs.cached({
    promptVersion: PROMPT_VERSION,
    inputHash,
  });
  if (cached) return { outcome: "cached", suggestion: cached, withheld };

  const job = await input.jobs.enqueue({
    caseId: input.caseId,
    kind: "assist",
    promptVersion: PROMPT_VERSION,
    inputHash,
    subject: question.slice(0, 200),
    recordType: null,
    recordId: null,
    classification: built.sendable.classification,
    redactions: built.redactions,
  });

  return { outcome: "queued", job, withheld };
}

/**
 * The cache key.
 *
 * SHA-256 over the prompt version, the question and the passages, in that
 * order, with a separator that cannot appear in any of them. Concatenating
 * without one would let two different inputs hash the same, which in a cache
 * means one case's answer served for another's question.
 */
export function hashOf(
  promptVersion: string,
  question: string,
  passages: string[],
): string {
  const hash = createHash("sha256");
  hash.update(promptVersion);
  hash.update("\u0000");
  hash.update(question.toLowerCase().replace(/\s+/g, " ").trim());
  for (const passage of passages) {
    hash.update("\u0000");
    hash.update(passage);
  }
  return hash.digest("hex");
}

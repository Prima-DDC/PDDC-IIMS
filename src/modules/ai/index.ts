import "server-only";
import type postgres from "postgres";
import type { Actor } from "@/lib/auth/session";
import { actorContext } from "@/lib/auth/session";
import { askAboutCase } from "./application/ask";
import { drainAiJobs, type DrainJobsResult } from "./application/drain-jobs";
import {
  createCaseSettingRepository,
  createJobRepository,
  createProviderRepository,
} from "./infrastructure/ai-repository";
import { createOpenAiCompatibleModel } from "./infrastructure/openai-compatible";

/**
 * The AI module's public surface, and its composition root.
 *
 * PRD 22's Amendment 12 makes AI assistive and not a V1 dependency, and this
 * module is built so that is literally true rather than aspirational: with no
 * provider in the allow-list every path here refuses with a sentence a person
 * can read, and nothing else in the platform behaves differently.
 *
 * RETRIEVAL IS PASSED IN, not imported. Grounding a question needs findings,
 * information, evidence and documents, which live in four other bounded
 * contexts with four different policies. This module must not reach into any
 * of them, so `RetrievalPort` is a parameter and the caller supplies an
 * implementation built from those modules' own repositories. That keeps the
 * dependency pointing inward, which eslint enforces, and it has a practical
 * consequence worth more than the rule: retrieval runs under the asker's own
 * permissions, so the assistant cannot read a record its user could not open.
 */

export function ai(actor: Actor, tx?: postgres.TransactionSql) {
  const ctx = actorContext(actor);

  return {
    providers: createProviderRepository(ctx, tx),
    caseSettings: createCaseSettingRepository(ctx, tx),
    jobs: createJobRepository(ctx, tx),
  };
}

export type Ai = ReturnType<typeof ai>;

/**
 * Asks a question about a case.
 *
 * Takes the retrieval implementation because of the note above. Everything
 * else it needs it builds.
 */
export async function ask(
  actor: Actor,
  input: {
    caseId: string;
    question: string;
    retrieval: import("./application/ports").RetrievalPort;
  },
) {
  return askAboutCase({
    caseId: input.caseId,
    question: input.question,
    jobs: ai(actor).jobs,
    retrieval: input.retrieval,
  });
}

/**
 * Runs the queue, for the scheduler.
 *
 * TAKES NO ACTOR, and that is the design rather than an omission. Every read
 * and write the worker makes runs under `withSystemActor`, which publishes a
 * named process and no user id: claiming a job, recording its result,
 * advancing a circuit breaker and reading the allow-list are all admitted on
 * that basis by migrations 0059 and 0060.
 *
 * The first draft gave the worker an administrator's identity so it could
 * read the allow-list, and that was wrong twice over. It would have
 * attributed the work to somebody who did not do it, in the one record that
 * has to be true; and it would have given the worker more reach than the
 * person whose question it was running. Retrieval, which is the part that
 * must be permission-correct, is done by `rebuild` as the asker instead.
 *
 * `rebuild` is supplied by the caller because the prompt is reassembled from
 * the case rather than stored, so the worker needs the same cross-context
 * read the request used, under the same permissions.
 */
export async function drainQueue(input: {
  limit?: number;
  rebuild: Parameters<typeof drainAiJobs>[0]["rebuild"];
}): Promise<DrainJobsResult> {
  // Built with no actor: the methods the worker calls never read the context,
  // and the ones that would are not among them.
  const api = ai(WORKER_ACTOR);
  return drainAiJobs({
    jobs: api.jobs,
    providers: api.providers,
    model: createOpenAiCompatibleModel(),
    limit: input.limit,
    rebuild: input.rebuild,
  });
}

/**
 * A placeholder identity for building the worker's repositories.
 *
 * Never published to the database. `withSystemActor` opens its own
 * transaction and sets its own settings, so the actor a worker-side
 * repository was constructed with is never read; this exists only because the
 * constructors take one. The nil UUID rather than a real user's, so that if
 * it ever WERE published it would fail the policies outright instead of
 * quietly acting as somebody.
 */
const WORKER_ACTOR: Actor = {
  userId: "00000000-0000-0000-0000-000000000000",
  email: "worker@pddc.invalid",
  fullName: null,
  photoPath: null,
  employeeId: null,
  jobTitle: null,
  status: "active",
  clearance: "INTERNAL",
  permissionsVersion: 0,
  isAdministrator: false,
  officeName: null,
  departmentName: null,
  countryCode: null,
  primaryRole: null,
  mfaEnrolledAt: null,
  sessionTimeoutMinutes: 0,
  aal: "aal2",
  requestId: "00000000-0000-0000-0000-000000000000",
  ip: null,
  userAgent: "pddc-iims/ai-drain",
};

/* ------------------------------------------- domain, types and pure rules */

export * from "./shared";

/* ------------------------------------------------------------------ ports */

export type {
  CaseSettingRepository,
  JobRepository,
  ModelPort,
  Page,
  ProviderRepository,
  RetrievalPort,
} from "./application/ports";

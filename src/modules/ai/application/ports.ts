import type {
  AiCaseSetting,
  AiJob,
  AiJobKind,
  AiProvider,
  Passage,
  Redaction,
  Sendable,
  Suggestion,
} from "../domain/types";

/** Ports for AI assistance (PRD 22). */

export interface Page<T> {
  rows: T[];
  total: number;
}

/**
 * One model call, behind a port.
 *
 * Takes a `Sendable`, which can only be produced by `buildRequest`, so the
 * transport cannot be handed anything that has not been through the
 * classification gate and the redactor. That is the point of the type: the
 * protection is not a step the adapter has to remember.
 *
 * The adapter speaks OpenAI's chat-completions shape, which is what makes
 * providers swappable by configuration (PRD 22.1). Nothing above this port
 * knows which provider answered.
 */
export interface ModelPort {
  complete(input: {
    provider: AiProvider;
    sendable: Sendable;
  }): Promise<{
    text: string;
    promptTokens: number | null;
    completionTokens: number | null;
  }>;
}

/** The provider allow-list and its breaker state (PRD 22.1, 22.4). */
export interface ProviderRepository {
  list(): Promise<AiProvider[]>;
  find(key: string): Promise<AiProvider | null>;

  /**
   * The same list, read by the scheduled worker.
   *
   * Separate because the caller is different in the one way that matters:
   * there is nobody signed in. Migration 0060 admits a named system process
   * with no user id to the allow-list, because the first thing the queue has
   * to do is find out where it may send anything. Giving the worker a
   * person's identity instead would attribute its work to somebody who did
   * not do it, and hand it their permissions.
   */
  listForWorker(): Promise<AiProvider[]>;

  save(input: {
    key: string;
    label: string;
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    retentionTerms: string | null;
    position: number;
    maxClassification: string;
    notes: string | null;
    /** Only settable once the terms have been recorded; the CHECK agrees. */
    isEnabled: boolean;
    expectedVersion?: number;
  }): Promise<AiProvider>;

  remove(key: string): Promise<void>;

  /** Called by the worker after an attempt (PRD 22.1 circuit breaker). */
  recordOutcome(input: {
    key: string;
    ok: boolean;
    error?: string | null;
    nextAttemptAt?: string | null;
  }): Promise<void>;
}

/** AI on or off for a case, with the decision (PRD 22.4). */
export interface CaseSettingRepository {
  forCase(caseId: string): Promise<AiCaseSetting | null>;

  decide(input: {
    caseId: string;
    isEnabled: boolean;
    reason: string;
    clientConsentRecorded: boolean;
    expectedVersion?: number;
  }): Promise<AiCaseSetting>;
}

/**
 * The job queue, the cache and the redaction map.
 *
 * One repository rather than three, because they are written together in one
 * transaction and never separately: a job, its redaction map and the cache
 * entry its answer produced are one unit of work. Splitting them would mean a
 * job whose map had been lost, which is an answer nobody can restore.
 */
export interface JobRepository {
  /** Rejects the request if a quota is met, before anything is queued. */
  usageToday(caseId: string | null): Promise<{ byUser: number; byCase: number }>;

  enqueue(input: {
    caseId: string | null;
    kind: AiJobKind;
    promptVersion: string;
    inputHash: string;
    subject: string | null;
    recordType: string | null;
    recordId: string | null;
    classification: string;
    redactions: Redaction[];
  }): Promise<AiJob>;

  /** Recorded rather than sent: the gate refused (PRD 22.4). */
  recordBlocked(input: {
    caseId: string | null;
    kind: AiJobKind;
    promptVersion: string;
    inputHash: string;
    subject: string | null;
    reason: string;
  }): Promise<AiJob>;

  find(id: string): Promise<AiJob | null>;

  list(filter: {
    caseId?: string;
    mine?: boolean;
    status?: AiJob["status"];
    limit?: number;
    offset?: number;
  }): Promise<Page<AiJob>>;

  /** A cached answer, if the same question has been asked before. */
  cached(input: {
    promptVersion: string;
    inputHash: string;
  }): Promise<Suggestion | null>;

  /** The worker's side. */
  claim(limit: number): Promise<
    Array<{
      job: AiJob;
      /** Rebuilt from the stored map so the worker can restore the answer. */
      redactions: Redaction[];
    }>
  >;

  recordResult(input: {
    id: string;
    status: "succeeded" | "failed";
    providerKey?: string | null;
    model?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    output?: Suggestion | null;
    error?: string | null;
    cacheIt?: boolean;
  }): Promise<void>;

  /** PRD 22.3: a human accepts, edits or rejects, and it is audited. */
  decide(input: {
    id: string;
    accept: boolean;
    note: string | null;
  }): Promise<AiJob>;
}

/**
 * What the assistant is allowed to read, assembled by the caller.
 *
 * A port rather than a direct dependency, because retrieval crosses every
 * bounded context: findings, information, evidence and documents each live in
 * their own module and each has its own policy. The ai module must not reach
 * into any of them, so the composition root passes this in and eslint's
 * boundary rule stays satisfied.
 *
 * Whatever implements it returns only what the caller may see, because it
 * reads through the same repositories the screens do.
 */
export interface RetrievalPort {
  passagesFor(input: {
    caseId: string;
    question: string;
    limit?: number;
  }): Promise<{
    passages: Passage[];
    /** Subjects and organisations on the case, for the redactor. */
    knownNames: Array<{ name: string; kind: Redaction["kind"] }>;
    /** What the gate kept back, so the screen can say so. */
    withheld: Array<{ reference: string; classification: string }>;
  }>;
}

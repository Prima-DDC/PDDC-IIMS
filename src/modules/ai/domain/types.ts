/**
 * AI assistance (PRD 22).
 *
 * The types here describe what may be asked, what may leave the platform, and
 * what comes back. The important ones are the narrow ones: `Sendable` is the
 * only shape the gateway will transmit, and it cannot be constructed without
 * going through the classification gate and the redactor.
 */

export const AI_JOB_KINDS = [
  "summarise_document",
  "extract_entities",
  "suggest_duplicates",
  "build_timeline",
  "suggest_relationships",
  "check_report",
  "assist",
] as const;

export type AiJobKind = (typeof AI_JOB_KINDS)[number];

export const AI_JOB_KIND_LABELS: Record<AiJobKind, string> = {
  summarise_document: "Summarise a document",
  extract_entities: "Extract subjects and organisations",
  suggest_duplicates: "Suggest possible duplicates",
  build_timeline: "Build a timeline",
  suggest_relationships: "Suggest relationships",
  check_report: "Check a report against the QA list",
  assist: "Ask a question about this case",
};

export const AI_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
] as const;

export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];

/**
 * A passage retrieved from the case, before the gate has looked at it.
 *
 * It carries its own classification and the identifier of the record it came
 * from, and both are load-bearing: the first decides whether it may leave,
 * and the second is what a citation points at. PRD 22.3 requires every
 * statement to cite the finding, information or evidence it rests on, and a
 * passage with no identifier could not be cited, so there is no way to
 * represent one.
 */
export interface Passage {
  recordType: "finding" | "information" | "evidence" | "document" | "activity";
  recordId: string;
  /** The human-readable identifier, which is what a citation shows. */
  reference: string;
  classification: string;
  text: string;
}

/**
 * What the gateway is allowed to transmit.
 *
 * Deliberately not the same type as what came in. There is no field for a
 * case title, a subject's name or an exhibit; the passages have been through
 * the classification gate and the redactor, and `redactionCount` is how many
 * substitutions were made, which the audit row records.
 */
export interface Sendable {
  system: string;
  user: string;
  /** The highest classification in anything being sent. Capped at INTERNAL. */
  classification: string;
  redactionCount: number;
  /** Token budget for the reply (PRD 22.1 token discipline). */
  maxOutputTokens: number;
}

/** One substitution, kept inside the platform only (PRD 22.4). */
export interface Redaction {
  token: string;
  original: string;
  kind: "person" | "organisation" | "identifier" | "account" | "address" | "contact";
}

/**
 * A suggestion, which is never a conclusion.
 *
 * `statements` each carry the references they rest on, and the application
 * drops any statement that cites nothing: PRD 22.3 says unsupported
 * statements are not shown, which is a rule about what reaches the screen
 * rather than about what the model was asked for.
 */
export interface Suggestion {
  statements: Array<{ text: string; cites: string[] }>;
  /** Everything the model said that cited nothing, kept for the audit. */
  discarded: string[];
  notes: string | null;
}

export interface AiProvider {
  key: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  isEnabled: boolean;
  retentionTerms: string | null;
  termsReviewedAt: string | null;
  termsReviewedByName: string | null;
  position: number;
  maxClassification: string;
  notes: string | null;
  /** Breaker state, when there is any. */
  consecutiveFailures: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  version: number;
}

export interface AiCaseSetting {
  caseId: string;
  isEnabled: boolean;
  reason: string;
  decidedBy: string;
  decidedByName: string | null;
  decidedAt: string;
  clientConsentRecorded: boolean;
  version: number;
}

export interface AiJob {
  id: string;
  caseId: string | null;
  requestedBy: string;
  requestedByName: string | null;
  kind: AiJobKind;
  promptVersion: string;
  subject: string | null;
  recordType: string | null;
  recordId: string | null;
  classification: string;
  status: AiJobStatus;
  blockedReason: string | null;
  providerKey: string | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  output: Suggestion | null;
  error: string | null;
  attempts: number;
  cached: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  acceptedBy: string | null;
  acceptedByName: string | null;
  acceptedAt: string | null;
  rejectedBy: string | null;
  rejectedByName: string | null;
  rejectedAt: string | null;
  decisionNote: string | null;
}

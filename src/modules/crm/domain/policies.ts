import { CrmError } from "./errors";
import {
  type ConflictCandidate,
  type ConflictDecision,
  type ConflictStatus,
  type EngagementStatus,
  type EnquiryStatus,
  type KycCheckType,
  type KycRecord,
  type KycStatus,
} from "./types";

/**
 * The rules the database cannot express, and the state machines.
 *
 * Pure functions over plain data: no database, no framework, no clock beyond
 * what is passed in. The use cases call these before they write, and the tests
 * in policies.test.ts drive them directly.
 *
 * The three that carry real weight are the engagement approval gate, the
 * conflict decision rules and the KYC completeness rule, because each of them
 * is a thing PRD 8 says must not be possible to bypass.
 */

/* ------------------------------------------------- the enquiry state machine */

/**
 * PRD 4.1's intake pipeline, as transitions.
 *
 * `accepted` is the only route to an engagement, and it is reachable only
 * after a quotation, which is in turn reachable only after the conflict check.
 * That ordering is the point of the machine: an enquiry cannot be accepted
 * without having passed through conflict screening.
 */
const ENQUIRY_TRANSITIONS: Record<EnquiryStatus, readonly EnquiryStatus[]> = {
  new: ["assessing", "declined", "lapsed"],
  assessing: ["conflict_check", "declined", "lapsed"],
  conflict_check: ["quoted", "declined", "lapsed"],
  quoted: ["accepted", "declined", "lapsed"],
  // Terminal. A re-approach from the same prospect is a new enquiry, so the
  // history of the first one stays readable.
  accepted: [],
  declined: [],
  lapsed: [],
};

export function allowedEnquiryTransitions(from: EnquiryStatus): readonly EnquiryStatus[] {
  return ENQUIRY_TRANSITIONS[from];
}

export function canTransitionEnquiry(from: EnquiryStatus, to: EnquiryStatus): boolean {
  return ENQUIRY_TRANSITIONS[from].includes(to);
}

export function assertEnquiryTransition(from: EnquiryStatus, to: EnquiryStatus): void {
  if (from === to) {
    throw new CrmError("illegal_transition", "The enquiry is already at that stage.");
  }
  if (!canTransitionEnquiry(from, to)) {
    const allowed = ENQUIRY_TRANSITIONS[from];
    throw new CrmError(
      "illegal_transition",
      allowed.length === 0
        ? `A ${from.replace(/_/g, " ")} enquiry is closed and cannot change stage.`
        : `An enquiry at "${from.replace(/_/g, " ")}" can only move to: ${allowed
            .map((s) => s.replace(/_/g, " "))
            .join(", ")}.`,
      { from, to, allowed },
    );
  }
}

/** Declining needs a reason, because the enquiry is kept permanently. */
export function assertDeclineReason(
  to: EnquiryStatus,
  reason: string | null | undefined,
): void {
  if (to === "declined" && (reason ?? "").trim().length === 0) {
    throw new CrmError(
      "validation_failed",
      "Say why the enquiry was declined. Intake history is kept permanently and this is part of it.",
    );
  }
}

/* --------------------------------------------- the engagement state machine */

const ENGAGEMENT_TRANSITIONS: Record<EngagementStatus, readonly EngagementStatus[]> = {
  draft: ["pending_approval", "cancelled"],
  pending_approval: ["approved", "draft", "cancelled"],
  approved: ["active", "cancelled"],
  active: ["on_hold", "completed", "cancelled"],
  on_hold: ["active", "cancelled"],
  completed: [],
  cancelled: [],
};

export function allowedEngagementTransitions(
  from: EngagementStatus,
): readonly EngagementStatus[] {
  return ENGAGEMENT_TRANSITIONS[from];
}

export function canTransitionEngagement(
  from: EngagementStatus,
  to: EngagementStatus,
): boolean {
  return ENGAGEMENT_TRANSITIONS[from].includes(to);
}

export function assertEngagementTransition(
  from: EngagementStatus,
  to: EngagementStatus,
): void {
  if (from === to) {
    throw new CrmError("illegal_transition", "The engagement is already at that status.");
  }
  if (!canTransitionEngagement(from, to)) {
    const allowed = ENGAGEMENT_TRANSITIONS[from];
    throw new CrmError(
      "illegal_transition",
      allowed.length === 0
        ? `A ${from} engagement is final and cannot change status.`
        : `A ${from.replace(/_/g, " ")} engagement can only move to: ${allowed
            .map((s) => s.replace(/_/g, " "))
            .join(", ")}.`,
      { from, to, allowed },
    );
  }
}

/**
 * The approval gate (PRD 8.3, 8.4, 16).
 *
 * Three things must hold before an engagement is approved, and none of them is
 * a matter of permission:
 *
 *   1. A conflict check has been run and decided. An undecided check is not a
 *      clearance; neither is no check at all.
 *   2. The decision was not "declined". A declined conflict stops the work.
 *   3. The approver is not the person who raised it. Separation of duties
 *      means nobody signs off their own engagement.
 *
 * "further_review" is deliberately allowed through: PRD 8.3 makes it a
 * decision in its own right, which records that a conflict exists and has been
 * considered. What it must not be is silence, which is what cases 1 and 2
 * rule out.
 */
export function assertEngagementApprovable(engagement: {
  status: EngagementStatus;
  conflictStatus: ConflictStatus | null;
  createdBy: string | null;
}, approverId: string): void {
  assertEngagementTransition(engagement.status, "approved");

  if (engagement.conflictStatus === null || engagement.conflictStatus === "open") {
    throw new CrmError(
      "conflict_check_required",
      "Run the conflict check and record a decision before approving this engagement.",
      { conflictStatus: engagement.conflictStatus },
    );
  }

  if (engagement.conflictStatus === "declined") {
    throw new CrmError(
      "conflict_declined",
      "The conflict check was declined, so this engagement cannot be approved. Raise a new check if the position has changed.",
    );
  }

  if (engagement.createdBy !== null && engagement.createdBy === approverId) {
    throw new CrmError(
      "self_approval_forbidden",
      "You raised this engagement, so somebody else has to approve it.",
    );
  }
}

/** Dates are checked here as well as by the CHECK constraint, for the message. */
export function assertEngagementDates(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): void {
  if (startDate && endDate && endDate < startDate) {
    throw new CrmError(
      "validation_failed",
      "The end date cannot be before the start date.",
      { startDate, endDate },
    );
  }
}

/* ------------------------------------------------------------------- KYC */

/**
 * The checks every client must pass before KYC counts as complete (PRD 8.1).
 *
 * Identity, registration and ownership are the irreducible set: who they are,
 * that they exist as a legal person, and who is behind them. Sanctions and PEP
 * screening are required of the higher risk ratings only, which is where the
 * risk rating earns its keep.
 */
export const KYC_BASELINE_CHECKS: readonly KycCheckType[] = [
  "identity",
  "registration",
  "ownership",
];

export const KYC_ENHANCED_CHECKS: readonly KycCheckType[] = [
  ...KYC_BASELINE_CHECKS,
  "sanctions",
  "pep",
];

export function requiredKycChecks(riskRating: string): readonly KycCheckType[] {
  return riskRating === "high" || riskRating === "critical"
    ? KYC_ENHANCED_CHECKS
    : KYC_BASELINE_CHECKS;
}

export interface KycAssessment {
  required: readonly KycCheckType[];
  /** Required checks with no record at all. */
  missing: KycCheckType[];
  /** Required checks whose record is still pending or inconclusive. */
  unresolved: KycCheckType[];
  /** Required checks that failed. Any one of these fails the whole client. */
  failed: KycCheckType[];
  /** Records whose validity has run out, so the check has to be redone. */
  expired: KycCheckType[];
  status: KycStatus;
}

/**
 * Works out where a client's KYC stands, from its records.
 *
 * Derived rather than stored, so the status cannot drift from the evidence
 * behind it. `crm.clients.kyc_status` is a cache of this, written whenever a
 * record changes.
 */
export function assessKyc(
  records: readonly Pick<KycRecord, "checkType" | "outcome" | "expiresAt">[],
  riskRating: string,
  now: Date = new Date(),
): KycAssessment {
  const required = requiredKycChecks(riskRating);
  const today = now.toISOString().slice(0, 10);

  // The most recent record wins, which is the order the repository returns.
  const latest = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    if (!latest.has(record.checkType)) latest.set(record.checkType, record);
  }

  const missing: KycCheckType[] = [];
  const unresolved: KycCheckType[] = [];
  const failed: KycCheckType[] = [];
  const expired: KycCheckType[] = [];

  for (const check of required) {
    const record = latest.get(check);
    if (!record) {
      missing.push(check);
    } else if (record.outcome === "fail") {
      failed.push(check);
    } else if (record.outcome === "pending" || record.outcome === "inconclusive") {
      unresolved.push(check);
    } else if (record.expiresAt !== null && record.expiresAt < today) {
      expired.push(check);
    }
  }

  let status: KycStatus;
  if (failed.length > 0) {
    status = "failed";
  } else if (expired.length > 0) {
    status = "expired";
  } else if (missing.length === required.length && unresolved.length === 0) {
    status = "not_started";
  } else if (missing.length > 0 || unresolved.length > 0) {
    status = "in_progress";
  } else {
    status = "completed";
  }

  return { required, missing, unresolved, failed, expired, status };
}

/* -------------------------------------------------------- conflict checks */

/**
 * Recording a decision (PRD 8.3).
 *
 * The decision is immutable, which the database enforces with a trigger. It is
 * checked here too so the interface can say why rather than surfacing a
 * constraint name, and so the rule is testable without a database.
 */
export function assertConflictDecidable(check: {
  decision: ConflictDecision | null;
}): void {
  if (check.decision !== null) {
    throw new CrmError(
      "decision_immutable",
      "This conflict check has already been decided, and a decision cannot be changed. Raise a new check instead.",
      { decision: check.decision },
    );
  }
}

export function assertDecisionReason(reason: string): void {
  if (reason.trim().length < 10) {
    throw new CrmError(
      "validation_failed",
      "Give a reason of at least 10 characters. The reason is the record of why the conflict was cleared or declined.",
    );
  }
}

/**
 * How strongly the screening results suggest a conflict.
 *
 * This is advice to the reviewer, not a decision. There is no threshold above
 * which the system clears or declines anything: PRD 8.3 says it finds
 * potential matches and "never concludes they are the same", so the only thing
 * this does is order the reviewer's attention.
 */
export type MatchStrength = "none" | "weak" | "possible" | "strong";

export function matchStrength(candidates: readonly ConflictCandidate[]): MatchStrength {
  if (candidates.length === 0) return "none";

  const highest = Math.max(...candidates.map((c) => c.similarity));
  const anyPhonetic = candidates.some((c) => c.phoneticMatch);

  if (highest >= 0.8) return "strong";
  if (highest >= 0.5 || anyPhonetic) return "possible";
  return "weak";
}

/** The sentence shown above the match list, which is deliberately hedged. */
export function matchSummary(candidates: readonly ConflictCandidate[]): string {
  const strength = matchStrength(candidates);
  if (strength === "none") {
    return "No potential conflicts found. Record the decision to clear the check.";
  }

  const n = candidates.length;
  const subject = n === 1 ? "1 potential match" : `${n} potential matches`;
  const qualifier =
    strength === "strong"
      ? "One or more are a close match and need careful review."
      : strength === "possible"
        ? "Some are a partial or phonetic match."
        : "All are weak matches.";

  return `${subject} found. ${qualifier} The system does not conclude that any of these are the same party: an authorised manager decides.`;
}

/**
 * Terms worth screening, taken from whatever the intake form holds.
 *
 * De-duplicated case-insensitively and trimmed, because screening the same
 * name twice produces duplicate matches that look like corroboration.
 */
export function screeningTerms(
  values: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const value of values) {
    const term = (value ?? "").trim();
    if (term.length < 2) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }

  return terms;
}

/* ------------------------------------------------------------- deletion */

/**
 * A client with live engagements is not removable (PRD 3.5).
 *
 * Soft deletion is recoverable, but it hides the client from every list, and
 * an engagement whose client has vanished is worse than an awkward message.
 */
export function assertClientRemovable(client: {
  activeEngagementCount: number;
}): void {
  if (client.activeEngagementCount > 0) {
    throw new CrmError(
      "in_use",
      client.activeEngagementCount === 1
        ? "This client has 1 engagement that is not closed. Complete or cancel it first."
        : `This client has ${client.activeEngagementCount} engagements that are not closed. Complete or cancel them first.`,
      { activeEngagementCount: client.activeEngagementCount },
    );
  }
}

export function assertEngagementRemovable(engagement: {
  status: EngagementStatus;
  caseCount: number;
}): void {
  if (engagement.caseCount > 0) {
    throw new CrmError(
      "in_use",
      "This engagement has cases under it, so it cannot be removed. Cancel it instead, which keeps the cases readable.",
      { caseCount: engagement.caseCount },
    );
  }
  if (engagement.status === "active") {
    throw new CrmError(
      "in_use",
      "Put the engagement on hold or cancel it before removing it.",
    );
  }
}

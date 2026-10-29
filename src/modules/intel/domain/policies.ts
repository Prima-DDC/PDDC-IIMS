import { IntelError } from "./errors";
import {
  HOLDING_RELATIONSHIPS,
  type ConfidenceLevel,
  type Entity,
  type Finding,
  type FindingStatus,
  type Information,
  type InformationCredibility,
  type MatchFlag,
  type RelationshipType,
  type Source,
  type SourceReliability,
} from "./types";

/**
 * The rules of the intelligence module (PRD 6.4, 8.4, 15).
 *
 * Pure functions over plain data: no database, no React, no SDK. Everything
 * here is a rule somebody at PDDC would recognise as part of how the work is
 * done, rather than a constraint that happens to be convenient to code.
 */

/* ------------------------------------------------- sources and identities */

export function assertSourceObtainedInThePast(dateObtained: string, now = new Date()): void {
  // Compared by day rather than by instant: a source obtained this morning
  // carries a date, not a time, and "today" must not depend on the hour the
  // form is submitted.
  const obtained = new Date(`${dateObtained.slice(0, 10)}T00:00:00Z`);
  const today = new Date(
    `${now.toISOString().slice(0, 10)}T00:00:00Z`,
  );

  if (Number.isNaN(obtained.getTime())) {
    throw new IntelError("validation_failed", "That is not a date.");
  }
  if (obtained.getTime() > today.getTime()) {
    throw new IntelError(
      "validation_failed",
      "A source cannot have been obtained in the future.",
    );
  }
}

/**
 * A human source's identity is protected, and nothing else carries one
 * (PRD 6.4).
 *
 * The rule runs both ways, which is the half that is easy to miss: an
 * identity typed into a source whose type is "open source" is a human
 * source's name sitting outside the protection it needs.
 */
export function assertIdentityIsProtected(source: {
  sourceType: string;
  identityRestricted: boolean;
  identityName?: string | null;
  identityContact?: string | null;
  identityNotes?: string | null;
}): void {
  const hasIdentity =
    Boolean(source.identityName?.trim()) ||
    Boolean(source.identityContact?.trim()) ||
    Boolean(source.identityNotes?.trim());

  if (hasIdentity && !source.identityRestricted) {
    throw new IntelError(
      "source_protected",
      "An identity can only be recorded on a source whose identity is restricted. A human source is restricted automatically; for anything else, say so first.",
    );
  }
}

/**
 * Whether this kind of source has its identity protected (PRD 6.4).
 *
 * A human source does, always, and the table sets the flag itself so no code
 * path can omit it. What is protected is the IDENTITY, not the record: what
 * the source said is intelligence the case team has to be able to read, and
 * classifying the record above the team would hide the investigation from the
 * people conducting it. Migration 0043 has the reasoning and the arithmetic
 * that forced it.
 */
export function identityIsProtectedFor(sourceType: string): boolean {
  return sourceType === "human_source";
}

/**
 * The clearance an identity is readable at (PRD 6.4).
 *
 * Returned rather than hard-coded at each call site so the one place that
 * decides it is the one place to change. No role's ceiling on `sources`
 * reaches this, which is what makes PRD 6.4's "named-user access only" true:
 * an identity is reachable by an administrator, or by a named user given an
 * explicit override, and by nobody else.
 */
export function identityClearance(): string {
  return "STRICTLY_RESTRICTED";
}

/* --------------------------------------------------------- information */

export function assertInformationObtainedInThePast(
  dateObtained: string,
  now = new Date(),
): void {
  assertSourceObtainedInThePast(dateObtained, now);
}

/**
 * "Confirmed" is a claim about corroboration, not a feeling (PRD 6.4).
 *
 * The scale's top value says the statement is borne out, and the only thing
 * that bears a statement out is something else: another piece of information
 * from a different source, or a piece of evidence. Letting an analyst mark
 * something confirmed on its own would make the whole scale decorative, which
 * is the failure the rating exists to prevent.
 */
export function assertConfirmedIsCorroborated(
  credibility: InformationCredibility,
  support: { corroborations: number; evidence: number },
): void {
  if (credibility !== "confirmed") return;
  if (support.corroborations > 0 || support.evidence > 0) return;

  throw new IntelError(
    "validation_failed",
    'Nothing corroborates this yet, so it cannot be marked "confirmed". Link a piece of evidence or another source\'s account of the same thing first, or record it as "probable".',
  );
}

/**
 * Corroboration has to come from a different source.
 *
 * Two statements from the same source are one source saying something twice.
 * This is the single most common way a case file ends up looking better
 * supported than it is.
 */
export function assertCorroborationIsIndependent(
  information: { id: string; sourceId: string },
  corroborating: { id: string; sourceId: string },
): void {
  if (information.id === corroborating.id) {
    throw new IntelError(
      "validation_failed",
      "A piece of information cannot corroborate itself.",
    );
  }
  if (information.sourceId === corroborating.sourceId) {
    throw new IntelError(
      "validation_failed",
      "That comes from the same source, so it corroborates nothing. Corroboration has to come from somewhere else.",
    );
  }
}

/**
 * A contradicted statement cannot also be confirmed.
 *
 * The database refuses the pair as well; this is here so the screen can say
 * which way round the problem is rather than reporting a constraint.
 */
export function assertCredibilityAndVerificationAgree(
  credibility: InformationCredibility,
  verification: string,
): void {
  if (credibility === "confirmed" && verification === "contradicted") {
    throw new IntelError(
      "validation_failed",
      "Something contradicted cannot be confirmed. Decide which it is: if the contradiction stands, the credibility is doubtful at best.",
    );
  }
}

/* ------------------------------------------------------- relationships */

export function assertRelationshipEndsDiffer(
  fromEntityId: string,
  toEntityId: string,
): void {
  if (fromEntityId === toEntityId) {
    throw new IntelError(
      "validation_failed",
      "A relationship needs two different ends.",
    );
  }
}

export function assertPercentageBelongsToAHolding(
  relationshipType: RelationshipType,
  percentage: number | null | undefined,
): void {
  if (percentage === null || percentage === undefined) return;
  if (HOLDING_RELATIONSHIPS.includes(relationshipType)) return;

  throw new IntelError(
    "validation_failed",
    "A percentage belongs to a shareholding, a beneficial ownership or an ownership. If this is a holding, record it as one.",
  );
}

export function assertHoldingPeriodInOrder(
  heldFrom: string | null | undefined,
  heldTo: string | null | undefined,
): void {
  if (!heldFrom || !heldTo) return;
  if (new Date(heldTo).getTime() >= new Date(heldFrom).getTime()) return;

  throw new IntelError(
    "validation_failed",
    "The holding cannot have ended before it began.",
  );
}

/**
 * A relationship nobody can trace is a rumour.
 *
 * Not refused outright: an investigator records what they have been told
 * before they have the registry extract that proves it. But it cannot be
 * recorded at high confidence, because high confidence in nothing is exactly
 * the claim a report must never make.
 */
export function assertConfidenceIsSupported(
  confidence: ConfidenceLevel,
  support: { sourceId?: string | null; evidenceItemId?: string | null },
): void {
  if (confidence !== "high") return;
  if (support.sourceId || support.evidenceItemId) return;

  throw new IntelError(
    "validation_failed",
    'Nothing is cited for this, so it cannot be recorded at high confidence. Name the source or the evidence, or record it as "moderate".',
  );
}

/* ------------------------------------------- entity resolution (PRD 8.4) */

/**
 * The pair, in the order the table holds it.
 *
 * A fixed order is what stops the same two records being flagged twice in
 * opposite directions, and it has to be decided in one place or the two ends
 * disagree.
 */
export function orderedPair(a: string, b: string): [string, string] {
  if (a === b) {
    throw new IntelError(
      "validation_failed",
      "A record cannot be a potential duplicate of itself.",
    );
  }
  return a < b ? [a, b] : [b, a];
}

/** A decision on a flag needs a reason, because somebody will read it later. */
export function assertMatchDecisionHasAReason(
  status: string,
  reason: string | null | undefined,
): void {
  if (status === "open") return;
  if (reason && reason.trim().length >= 10) return;

  throw new IntelError(
    "validation_failed",
    "Say why in at least ten characters. Somebody reading this in two years has only what you write here.",
  );
}

/**
 * Whether two records may be merged (PRD 8.4).
 *
 * Four refusals, each for a different reason:
 *
 *   A record already merged away is not a record, it is a pointer. Merging it
 *   again would build a chain nobody can read or reverse.
 *   A record cannot be merged into itself.
 *   A merge is a decision about two things being one thing, so somebody has
 *   to have said so: the flag must be decided `same_entity` first. Without
 *   that the merge log records no reasoning.
 *   A removed record is not merged, it is restored first or left alone.
 */
export function assertMergeable(
  surviving: Pick<Entity, "id" | "resolutionStatus" | "deletedAt">,
  merged: Pick<Entity, "id" | "resolutionStatus" | "deletedAt">,
  flag: Pick<MatchFlag, "status"> | null,
): void {
  if (surviving.id === merged.id) {
    throw new IntelError("merge_refused", "A record cannot be merged into itself.");
  }
  for (const entity of [surviving, merged]) {
    if (entity.resolutionStatus === "merged") {
      throw new IntelError(
        "merge_refused",
        "One of these has already been merged into another record. Reverse that merge first, so the history stays readable.",
      );
    }
    if (entity.deletedAt !== null) {
      throw new IntelError(
        "merge_refused",
        "One of these is in the recycle bin. Restore it first, or leave it where it is.",
      );
    }
  }
  if (flag?.status !== "same_entity") {
    throw new IntelError(
      "merge_refused",
      "Somebody has to decide these are the same thing first, with a reason. The merge log is only worth anything if it records that decision.",
    );
  }
}

/** A merge is reversed once (PRD 8.4). */
export function assertReversible(merge: {
  reversedAt: string | null;
  reversalReason?: string | null;
}): void {
  if (merge.reversedAt !== null) {
    throw new IntelError("conflict", "That merge has already been reversed.");
  }
}

/* --------------------------------------------------------------- findings */

/**
 * The finding status machine (PRD 15, screen 17).
 *
 * Deliberately narrow. A finding goes out for review, comes back or is
 * accepted, and an accepted finding is not edited back into a draft: it is
 * withdrawn, and a new one put in its place. That is what lets a report cite
 * "finding F-003" and mean something fixed.
 */
export const FINDING_TRANSITIONS: Record<FindingStatus, readonly FindingStatus[]> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["accepted", "returned", "withdrawn"],
  returned: ["submitted", "withdrawn"],
  accepted: ["withdrawn"],
  withdrawn: [],
};

export function allowedFindingTransitions(
  from: FindingStatus,
): readonly FindingStatus[] {
  return FINDING_TRANSITIONS[from];
}

export function assertFindingTransition(
  from: FindingStatus,
  to: FindingStatus,
): void {
  if (FINDING_TRANSITIONS[from].includes(to)) return;

  throw new IntelError(
    "illegal_transition",
    from === "accepted"
      ? "An accepted finding is not edited back into a draft. Withdraw it and put a new one in its place, so a report that cites it still reads true."
      : `A finding cannot go from ${from} to ${to}.`,
  );
}

/**
 * A finding has to rest on something (PRD 15, screen 17).
 *
 * This is the rule the whole chain exists for. A statement with nothing
 * linked to it is an opinion, and the platform's purpose is that every
 * conclusion in a client report can be walked back to the evidence and the
 * information behind it. Checked when it is put forward for review rather
 * than while it is being drafted, because a draft is a work in progress.
 */
export function assertFindingIsSupported(links: {
  information: number;
  evidence: number;
}): void {
  if (links.information > 0 || links.evidence > 0) return;

  throw new IntelError(
    "unsupported_finding",
    "Nothing supports this finding yet. Link the information or the evidence it rests on: a conclusion that cannot be traced back is one PDDC cannot defend if the report is challenged.",
  );
}

/** PRD 16, and the pattern the whole platform follows. */
export function assertNotReviewingOwnFinding(
  finding: Pick<Finding, "analyst">,
  reviewerId: string,
): void {
  if (finding.analyst !== reviewerId) return;

  throw new IntelError(
    "self_review_forbidden",
    "You are the analyst on this finding, so you cannot review it. Somebody other than you has to, which is the only thing that makes the review worth having.",
  );
}

export function assertReturnHasNotes(
  to: FindingStatus,
  notes: string | null | undefined,
): void {
  if (to !== "returned") return;
  if (notes && notes.trim().length >= 10) return;

  throw new IntelError(
    "validation_failed",
    "Say what needs doing, in at least ten characters. A finding returned with no note is a finding nobody can act on.",
  );
}

/**
 * Whether a finding may be cited in a report (PRD 10.1).
 *
 * Only an accepted one, and this is the gate M6's report builder reads. A
 * draft in a client report is somebody's unreviewed opinion presented as
 * PDDC's conclusion.
 */
export function assertCitable(finding: Pick<Finding, "findingId" | "status">): void {
  if (finding.status === "accepted") return;

  throw new IntelError(
    "conflict",
    `${finding.findingId} has not been accepted, so it cannot be cited in a report. It is currently ${finding.status}.`,
  );
}

/**
 * How far a finding's confidence can go, given what supports it.
 *
 * Not a refusal but a ceiling, computed so the screen can say why "high" is
 * not on offer. The reasoning is the one an analyst would give: a conclusion
 * is no better supported than the least of what it rests on, and a single
 * unconfirmed statement does not carry a high-confidence finding.
 */
export function confidenceCeiling(
  support: Array<{ credibility: InformationCredibility; reliability: SourceReliability }>,
  evidenceCount: number,
): ConfidenceLevel {
  if (support.length === 0 && evidenceCount === 0) return "unverified";

  // Verified evidence is the strongest thing a finding can rest on, so a
  // finding with any of it is not capped by the information alone.
  const confirmed = support.filter((s) => s.credibility === "confirmed").length;
  const probable = support.filter((s) => s.credibility === "probable").length;
  const reliable = support.filter(
    (s) => s.reliability === "reliable" || s.reliability === "usually_reliable",
  ).length;

  if (evidenceCount > 0 && (confirmed > 0 || evidenceCount > 1)) return "high";
  if (confirmed > 0 && reliable > 0) return "high";
  if (confirmed > 0 || probable > 1 || evidenceCount > 0) return "moderate";
  if (probable > 0 || reliable > 0) return "low";
  return "unverified";
}

export function assertConfidenceWithinCeiling(
  confidence: ConfidenceLevel,
  ceiling: ConfidenceLevel,
): void {
  const rank: Record<ConfidenceLevel, number> = {
    unverified: 0,
    low: 1,
    moderate: 2,
    high: 3,
  };
  if (rank[confidence] <= rank[ceiling]) return;

  throw new IntelError(
    "validation_failed",
    `What supports this finding does not carry ${confidence} confidence. The most it can be recorded at is ${ceiling}. Link more of what it rests on, or lower the confidence.`,
  );
}

/* ---------------------------------------------------------- the strip */

/**
 * The traceability strip for one finding (PRD 23, screen 17).
 *
 * Ordered Source, Information, Evidence, Document, Subject, because that is
 * the direction the chain runs and a strip read backwards tells the reader
 * nothing. Built here, from data the repository has already fetched, so the
 * ordering rule is tested without a database.
 */
export function buildTraceability(
  finding: Pick<Finding, "id" | "findingId">,
  hops: Array<{
    kind: "source" | "information" | "evidence" | "document" | "entity";
    id: string;
    reference: string;
    label: string;
    rating: string | null;
    href: string;
  }>,
): {
  findingId: string;
  findingReference: string;
  hops: typeof hops;
  unsupported: boolean;
} {
  const order = { source: 0, information: 1, evidence: 2, document: 3, entity: 4 };
  const sorted = [...hops].sort(
    (a, b) => order[a.kind] - order[b.kind] || a.reference.localeCompare(b.reference),
  );

  return {
    findingId: finding.id,
    findingReference: finding.findingId,
    hops: sorted,
    unsupported: !sorted.some(
      (hop) => hop.kind === "information" || hop.kind === "evidence",
    ),
  };
}

/* ----------------------------------------------------------- removal */

export function assertEntityRemovable(
  entity: Pick<Entity, "entityId" | "resolutionStatus" | "caseCount">,
): void {
  if (entity.resolutionStatus === "merged") {
    throw new IntelError(
      "conflict",
      `${entity.entityId} has been merged into another record, so it is already out of the way. Reverse the merge if it should stand on its own again.`,
    );
  }
  if (entity.caseCount > 0) {
    throw new IntelError(
      "conflict",
      `${entity.entityId} is a subject of ${entity.caseCount} ${
        entity.caseCount === 1 ? "case" : "cases"
      }. Take it off those cases first: removing a subject from a case is part of what the investigation did, and is recorded there.`,
    );
  }
}

export function assertSourceRemovable(
  source: Pick<Source, "sourceId" | "informationCount">,
): void {
  if (source.informationCount === 0) return;

  throw new IntelError(
    "conflict",
    `${source.sourceId} is cited by ${source.informationCount} ${
      source.informationCount === 1 ? "piece" : "pieces"
    } of information. Removing it would leave them attributed to nothing, which is worse than a source nobody uses.`,
  );
}

export function assertInformationRemovable(
  information: Pick<Information, "informationId">,
  citedByFindings: number,
): void {
  if (citedByFindings === 0) return;

  throw new IntelError(
    "conflict",
    `${information.informationId} supports ${citedByFindings} ${
      citedByFindings === 1 ? "finding" : "findings"
    }. Unlink it from them first, so no conclusion is left resting on something that is no longer there.`,
  );
}

import { describe, expect, it } from "vitest";
import { IntelError } from "./errors";
import {
  allowedFindingTransitions,
  assertConfidenceIsSupported,
  assertConfidenceWithinCeiling,
  assertConfirmedIsCorroborated,
  assertCorroborationIsIndependent,
  assertCredibilityAndVerificationAgree,
  assertCitable,
  assertEntityRemovable,
  assertFindingIsSupported,
  assertFindingTransition,
  assertHoldingPeriodInOrder,
  assertIdentityIsProtected,
  assertInformationRemovable,
  assertMatchDecisionHasAReason,
  assertMergeable,
  assertNotReviewingOwnFinding,
  assertPercentageBelongsToAHolding,
  assertRelationshipEndsDiffer,
  assertReversible,
  assertSourceObtainedInThePast,
  assertSourceRemovable,
  buildTraceability,
  confidenceCeiling,
  orderedPair,
  identityClearance,
  identityIsProtectedFor,
} from "./policies";
import type { Entity, Finding, MatchFlag } from "./types";

/**
 * The intelligence rules, with no database.
 *
 * Every test here is a statement about how PDDC's work is done rather than
 * about how the code is arranged, which is why the names read as sentences.
 */

const NOW = new Date("2026-10-28T14:00:00.000Z");

function entity(over: Partial<Entity> = {}): Entity {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    entityId: "ENT-2026-000001",
    entityType: "company",
    name: "ABC Holdings Ltd",
    normalisedName: "abc holdings",
    registrationNo: null,
    idReferenceHint: null,
    hasIdReference: false,
    nationality: null,
    nationalityName: null,
    country: null,
    countryName: null,
    address: null,
    dateOfBirth: null,
    incorporatedOn: null,
    notes: null,
    resolutionStatus: "unresolved",
    mergedIntoId: null,
    mergedIntoReference: null,
    classification: "CONFIDENTIAL",
    aliases: [],
    caseCount: 0,
    openMatchFlags: 0,
    createdAt: NOW.toISOString(),
    createdBy: null,
    createdByName: null,
    updatedAt: NOW.toISOString(),
    version: 1,
    deletedAt: null,
    ...over,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    findingId: "F-001",
    caseId: "33333333-3333-3333-3333-333333333333",
    caseReference: "PDDC-2026-000001",
    statement: "The three payments were authorised by the finance director.",
    detail: null,
    analyst: "analyst-1",
    analystName: "An Analyst",
    confidence: "moderate",
    findingDate: "2026-10-28",
    status: "draft",
    reviewer: null,
    reviewerName: null,
    reviewedAt: null,
    reviewNotes: null,
    classification: "CONFIDENTIAL",
    links: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    version: 1,
    deletedAt: null,
    ...over,
  };
}

describe("sources", () => {
  it("cannot have been obtained in the future", () => {
    expect(() => assertSourceObtainedInThePast("2026-12-01", NOW)).toThrow(
      /cannot have been obtained in the future/,
    );
  });

  it("accepts today, whatever the hour the form is submitted", () => {
    expect(() => assertSourceObtainedInThePast("2026-10-28", NOW)).not.toThrow();
    // Late in the day, which a naive instant comparison gets wrong.
    expect(() =>
      assertSourceObtainedInThePast(
        "2026-10-28",
        new Date("2026-10-28T23:59:00.000Z"),
      ),
    ).not.toThrow();
  });

  it("refuses an identity on a source whose identity is not restricted", () => {
    expect(() =>
      assertIdentityIsProtected({
        sourceType: "open_source",
        identityRestricted: false,
        identityName: "Kofi Mensah",
      }),
    ).toThrow(/only be recorded on a source whose identity is restricted/);
  });

  it("allows an identity once the source is restricted", () => {
    expect(() =>
      assertIdentityIsProtected({
        sourceType: "human_source",
        identityRestricted: true,
        identityName: "Kofi Mensah",
        identityContact: "+233 24 000 0000",
      }),
    ).not.toThrow();
  });

  it("allows a source with no identity at all", () => {
    expect(() =>
      assertIdentityIsProtected({
        sourceType: "public_registry",
        identityRestricted: false,
        identityName: null,
        identityContact: "   ",
      }),
    ).not.toThrow();
  });

  it("protects a human source's identity, and only a human source's", () => {
    expect(identityIsProtectedFor("human_source")).toBe(true);
    expect(identityIsProtectedFor("open_source")).toBe(false);
    expect(identityIsProtectedFor("interview")).toBe(false);
  });

  it("reads an identity at the top clearance, which no role's ceiling reaches", () => {
    // That is what makes PRD 6.4's "named-user access only" true rather
    // than aspirational: it takes an administrator or an explicit override.
    expect(identityClearance()).toBe("STRICTLY_RESTRICTED");
  });

  it("cannot be removed while information is attributed to it", () => {
    expect(() =>
      assertSourceRemovable({ sourceId: "SRC-2026-000004", informationCount: 2 }),
    ).toThrow(/cited by 2 pieces of information/);
    expect(() =>
      assertSourceRemovable({ sourceId: "SRC-2026-000004", informationCount: 0 }),
    ).not.toThrow();
  });
});

describe("information", () => {
  it('cannot be "confirmed" with nothing corroborating it', () => {
    expect(() =>
      assertConfirmedIsCorroborated("confirmed", { corroborations: 0, evidence: 0 }),
    ).toThrow(/Nothing corroborates this yet/);
  });

  it('is "confirmed" once a piece of evidence or another source bears it out', () => {
    expect(() =>
      assertConfirmedIsCorroborated("confirmed", { corroborations: 0, evidence: 1 }),
    ).not.toThrow();
    expect(() =>
      assertConfirmedIsCorroborated("confirmed", { corroborations: 1, evidence: 0 }),
    ).not.toThrow();
  });

  it("leaves every other credibility alone", () => {
    expect(() =>
      assertConfirmedIsCorroborated("probable", { corroborations: 0, evidence: 0 }),
    ).not.toThrow();
  });

  it("refuses corroboration from the same source", () => {
    expect(() =>
      assertCorroborationIsIndependent(
        { id: "i1", sourceId: "s1" },
        { id: "i2", sourceId: "s1" },
      ),
    ).toThrow(/comes from the same source/);
  });

  it("refuses corroboration by itself", () => {
    expect(() =>
      assertCorroborationIsIndependent(
        { id: "i1", sourceId: "s1" },
        { id: "i1", sourceId: "s1" },
      ),
    ).toThrow(/cannot corroborate itself/);
  });

  it("accepts corroboration from a different source", () => {
    expect(() =>
      assertCorroborationIsIndependent(
        { id: "i1", sourceId: "s1" },
        { id: "i2", sourceId: "s2" },
      ),
    ).not.toThrow();
  });

  it("cannot be confirmed and contradicted at once", () => {
    expect(() =>
      assertCredibilityAndVerificationAgree("confirmed", "contradicted"),
    ).toThrow(/contradicted cannot be confirmed/);
    expect(() =>
      assertCredibilityAndVerificationAgree("doubtful", "contradicted"),
    ).not.toThrow();
  });

  it("cannot be removed while a finding rests on it", () => {
    expect(() =>
      assertInformationRemovable({ informationId: "INF-2026-000009" }, 1),
    ).toThrow(/supports 1 finding/);
    expect(() =>
      assertInformationRemovable({ informationId: "INF-2026-000009" }, 0),
    ).not.toThrow();
  });
});

describe("relationships", () => {
  it("needs two different ends", () => {
    expect(() => assertRelationshipEndsDiffer("a", "a")).toThrow(
      /two different ends/,
    );
    expect(() => assertRelationshipEndsDiffer("a", "b")).not.toThrow();
  });

  it("allows a percentage only on a holding", () => {
    expect(() => assertPercentageBelongsToAHolding("shareholder_of", 40)).not.toThrow();
    expect(() =>
      assertPercentageBelongsToAHolding("beneficial_owner_of", 100),
    ).not.toThrow();
    expect(() => assertPercentageBelongsToAHolding("director_of", 40)).toThrow(
      /percentage belongs to a shareholding/,
    );
  });

  it("allows a director with no percentage", () => {
    expect(() => assertPercentageBelongsToAHolding("director_of", null)).not.toThrow();
    expect(() =>
      assertPercentageBelongsToAHolding("director_of", undefined),
    ).not.toThrow();
  });

  it("refuses a holding that ended before it began", () => {
    expect(() => assertHoldingPeriodInOrder("2024-01-01", "2023-01-01")).toThrow(
      /ended before it began/,
    );
    expect(() => assertHoldingPeriodInOrder("2023-01-01", "2024-01-01")).not.toThrow();
    expect(() => assertHoldingPeriodInOrder("2023-01-01", null)).not.toThrow();
  });

  it("refuses high confidence with nothing cited", () => {
    expect(() =>
      assertConfidenceIsSupported("high", { sourceId: null, evidenceItemId: null }),
    ).toThrow(/cannot be recorded at high confidence/);
  });

  it("allows high confidence once something is cited", () => {
    expect(() =>
      assertConfidenceIsSupported("high", { sourceId: "s1", evidenceItemId: null }),
    ).not.toThrow();
    expect(() =>
      assertConfidenceIsSupported("moderate", { sourceId: null, evidenceItemId: null }),
    ).not.toThrow();
  });
});

describe("entity resolution", () => {
  it("holds a flagged pair in a fixed order, whichever way it is given", () => {
    expect(orderedPair("b", "a")).toEqual(["a", "b"]);
    expect(orderedPair("a", "b")).toEqual(["a", "b"]);
  });

  it("refuses to flag a record against itself", () => {
    expect(() => orderedPair("a", "a")).toThrow(/potential duplicate of itself/);
  });

  it("needs a reason for any decision but leaving it open", () => {
    expect(() => assertMatchDecisionHasAReason("same_entity", "same")).toThrow(
      /at least ten characters/,
    );
    expect(() =>
      assertMatchDecisionHasAReason(
        "same_entity",
        "Same registration number and the same registered address.",
      ),
    ).not.toThrow();
    expect(() => assertMatchDecisionHasAReason("open", null)).not.toThrow();
  });

  const decided: Pick<MatchFlag, "status"> = { status: "same_entity" };

  it("merges only after somebody has decided the two are the same thing", () => {
    expect(() => assertMergeable(entity(), entity({ id: "other" }), null)).toThrow(
      /decide these are the same thing first/,
    );
    expect(() =>
      assertMergeable(entity(), entity({ id: "other" }), { status: "open" }),
    ).toThrow(/decide these are the same thing first/);
    expect(() =>
      assertMergeable(entity(), entity({ id: "other" }), decided),
    ).not.toThrow();
  });

  it("refuses to merge a record into itself", () => {
    expect(() => assertMergeable(entity(), entity(), decided)).toThrow(
      /merged into itself/,
    );
  });

  it("refuses to merge a record that has already been merged away", () => {
    expect(() =>
      assertMergeable(
        entity(),
        entity({ id: "other", resolutionStatus: "merged", mergedIntoId: "third" }),
        decided,
      ),
    ).toThrow(/already been merged/);
  });

  it("refuses to merge something in the recycle bin", () => {
    expect(() =>
      assertMergeable(
        entity(),
        entity({ id: "other", deletedAt: NOW.toISOString() }),
        decided,
      ),
    ).toThrow(/in the recycle bin/);
  });

  it("reverses a merge once", () => {
    expect(() => assertReversible({ reversedAt: null })).not.toThrow();
    expect(() => assertReversible({ reversedAt: NOW.toISOString() })).toThrow(
      /already been reversed/,
    );
  });

  it("refuses to remove an entity that is a subject of a case", () => {
    expect(() =>
      assertEntityRemovable({
        entityId: "ENT-2026-000001",
        resolutionStatus: "unresolved",
        caseCount: 2,
      }),
    ).toThrow(/subject of 2 cases/);
  });

  it("refuses to remove a record that has been merged away", () => {
    expect(() =>
      assertEntityRemovable({
        entityId: "ENT-2026-000001",
        resolutionStatus: "merged",
        caseCount: 0,
      }),
    ).toThrow(/merged into another record/);
  });

  it("removes an entity on no case", () => {
    expect(() =>
      assertEntityRemovable({
        entityId: "ENT-2026-000001",
        resolutionStatus: "unresolved",
        caseCount: 0,
      }),
    ).not.toThrow();
  });
});

describe("findings", () => {
  it("offers only the moves the machine permits", () => {
    expect(allowedFindingTransitions("draft")).toEqual(["submitted", "withdrawn"]);
    expect(allowedFindingTransitions("accepted")).toEqual(["withdrawn"]);
    expect(allowedFindingTransitions("withdrawn")).toEqual([]);
  });

  it("will not edit an accepted finding back into a draft", () => {
    expect(() => assertFindingTransition("accepted", "draft")).toThrow(
      /Withdraw it and put a new one in its place/,
    );
  });

  it("returns a submitted finding, and takes it back for review", () => {
    expect(() => assertFindingTransition("submitted", "returned")).not.toThrow();
    expect(() => assertFindingTransition("returned", "submitted")).not.toThrow();
  });

  it("refuses to put forward a finding that rests on nothing", () => {
    expect(() => assertFindingIsSupported({ information: 0, evidence: 0 })).toThrow(
      /Nothing supports this finding yet/,
    );
    expect(() =>
      assertFindingIsSupported({ information: 1, evidence: 0 }),
    ).not.toThrow();
    expect(() =>
      assertFindingIsSupported({ information: 0, evidence: 1 }),
    ).not.toThrow();
  });

  it("refuses to let the analyst review their own finding", () => {
    expect(() => assertNotReviewingOwnFinding(finding(), "analyst-1")).toThrow(
      /cannot review it/,
    );
    expect(() =>
      assertNotReviewingOwnFinding(finding(), "supervisor-1"),
    ).not.toThrow();
  });

  it("cites only an accepted finding", () => {
    expect(() => assertCitable(finding({ status: "accepted" }))).not.toThrow();
    expect(() => assertCitable(finding({ status: "submitted" }))).toThrow(
      /F-001 has not been accepted/,
    );
  });

  it("names the status in the refusal, so the reader knows what to do", () => {
    try {
      assertCitable(finding({ status: "returned" }));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(IntelError);
      expect((error as IntelError).message).toContain("currently returned");
    }
  });
});

describe("how far a finding's confidence can go", () => {
  it("is unverified when nothing supports it", () => {
    expect(confidenceCeiling([], 0)).toBe("unverified");
  });

  it("is low on a single probable statement", () => {
    expect(
      confidenceCeiling([{ credibility: "probable", reliability: "unknown" }], 0),
    ).toBe("low");
  });

  it("is high on a confirmed statement from a reliable source", () => {
    expect(
      confidenceCeiling([{ credibility: "confirmed", reliability: "reliable" }], 0),
    ).toBe("high");
  });

  it("is high on two pieces of evidence, with no information at all", () => {
    expect(confidenceCeiling([], 2)).toBe("high");
  });

  it("is moderate on one piece of evidence on its own", () => {
    expect(confidenceCeiling([], 1)).toBe("moderate");
  });

  it("is moderate on two probable statements", () => {
    expect(
      confidenceCeiling(
        [
          { credibility: "probable", reliability: "unknown" },
          { credibility: "probable", reliability: "questionable" },
        ],
        0,
      ),
    ).toBe("moderate");
  });

  it("refuses a confidence above the ceiling, and says what the ceiling is", () => {
    expect(() => assertConfidenceWithinCeiling("high", "moderate")).toThrow(
      /the most it can be recorded at is moderate/i,
    );
    expect(() => assertConfidenceWithinCeiling("moderate", "moderate")).not.toThrow();
    expect(() => assertConfidenceWithinCeiling("low", "high")).not.toThrow();
  });
});

describe("the traceability strip", () => {
  const hops = [
    {
      kind: "evidence" as const,
      id: "e1",
      reference: "EV-2026-000001-002",
      label: "Bank statement",
      rating: "verified",
      href: "/evidence/e1",
    },
    {
      kind: "source" as const,
      id: "s1",
      reference: "SRC-2026-000001",
      label: "Registry search",
      rating: "reliable",
      href: "/sources/s1",
    },
    {
      kind: "information" as const,
      id: "i1",
      reference: "INF-2026-000001",
      label: "The director signed",
      rating: "confirmed",
      href: "/information/i1",
    },
  ];

  it("runs in the direction the chain runs, whatever order it is given in", () => {
    const strip = buildTraceability(finding(), hops);
    expect(strip.hops.map((hop) => hop.kind)).toEqual([
      "source",
      "information",
      "evidence",
    ]);
  });

  it("says a finding is unsupported when nothing but a subject is linked", () => {
    const strip = buildTraceability(finding(), [
      {
        kind: "entity",
        id: "x",
        reference: "ENT-2026-000001",
        label: "ABC Holdings Ltd",
        rating: null,
        href: "/entities/x",
      },
    ]);
    expect(strip.unsupported).toBe(true);
  });

  it("says a finding is supported once information or evidence is linked", () => {
    expect(buildTraceability(finding(), hops).unsupported).toBe(false);
  });

  it("carries the finding's own reference, which is what a report cites", () => {
    expect(buildTraceability(finding(), hops).findingReference).toBe("F-001");
  });
});

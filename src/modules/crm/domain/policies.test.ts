import { describe, expect, it } from "vitest";
import { CrmError, isCrmError } from "./errors";
import {
  allowedEngagementTransitions,
  allowedEnquiryTransitions,
  assertClientRemovable,
  assertConflictDecidable,
  assertDeclineReason,
  assertDecisionReason,
  assertEngagementApprovable,
  assertEngagementDates,
  assertEngagementRemovable,
  assertEngagementTransition,
  assertEnquiryTransition,
  assessKyc,
  canTransitionEngagement,
  canTransitionEnquiry,
  KYC_BASELINE_CHECKS,
  matchStrength,
  matchSummary,
  requiredKycChecks,
  screeningTerms,
} from "./policies";
import {
  ENGAGEMENT_STATUSES,
  ENQUIRY_STATUSES,
  type ConflictCandidate,
  type KycCheckType,
  type KycOutcome,
} from "./types";

/** Asserts the thrown error is a CrmError with the given code. */
function expectCode(fn: () => void, code: string) {
  try {
    fn();
  } catch (error) {
    expect(isCrmError(error)).toBe(true);
    expect((error as CrmError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

describe("the enquiry state machine", () => {
  it("runs the PRD's intake pipeline in order", () => {
    expect(canTransitionEnquiry("new", "assessing")).toBe(true);
    expect(canTransitionEnquiry("assessing", "conflict_check")).toBe(true);
    expect(canTransitionEnquiry("conflict_check", "quoted")).toBe(true);
    expect(canTransitionEnquiry("quoted", "accepted")).toBe(true);
  });

  it("will not let an enquiry skip the conflict check on its way to a quote", () => {
    expect(canTransitionEnquiry("assessing", "quoted")).toBe(false);
    expectCode(() => assertEnquiryTransition("assessing", "quoted"), "illegal_transition");
  });

  it("will not let a new enquiry be accepted outright", () => {
    expect(canTransitionEnquiry("new", "accepted")).toBe(false);
  });

  it("lets an enquiry be declined or lapse from any open stage", () => {
    for (const from of ["new", "assessing", "conflict_check", "quoted"] as const) {
      expect(canTransitionEnquiry(from, "declined")).toBe(true);
      expect(canTransitionEnquiry(from, "lapsed")).toBe(true);
    }
  });

  it("treats the closed stages as final", () => {
    for (const from of ["accepted", "declined", "lapsed"] as const) {
      expect(allowedEnquiryTransitions(from)).toEqual([]);
      expectCode(() => assertEnquiryTransition(from, "assessing"), "illegal_transition");
    }
  });

  it("rejects a transition to the stage it is already at", () => {
    expectCode(() => assertEnquiryTransition("new", "new"), "illegal_transition");
  });

  it("names the permitted stages in the message, so the interface need not", () => {
    try {
      assertEnquiryTransition("new", "quoted");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CrmError).message).toContain("assessing");
      expect((error as CrmError).message).toContain("declined");
    }
  });

  it("requires a reason for declining, because the enquiry is kept forever", () => {
    expectCode(() => assertDeclineReason("declined", ""), "validation_failed");
    expectCode(() => assertDeclineReason("declined", "   "), "validation_failed");
    expectCode(() => assertDeclineReason("declined", null), "validation_failed");
    expect(() => assertDeclineReason("declined", "outside our remit")).not.toThrow();
    // Other transitions need no reason.
    expect(() => assertDeclineReason("assessing", null)).not.toThrow();
  });

  it("covers every status, so a new one cannot be forgotten", () => {
    for (const status of ENQUIRY_STATUSES) {
      expect(Array.isArray(allowedEnquiryTransitions(status))).toBe(true);
    }
  });
});

describe("the engagement state machine", () => {
  it("runs draft to active through approval", () => {
    expect(canTransitionEngagement("draft", "pending_approval")).toBe(true);
    expect(canTransitionEngagement("pending_approval", "approved")).toBe(true);
    expect(canTransitionEngagement("approved", "active")).toBe(true);
  });

  it("will not let a draft become active without being approved", () => {
    expect(canTransitionEngagement("draft", "active")).toBe(false);
    expect(canTransitionEngagement("draft", "approved")).toBe(false);
    expectCode(() => assertEngagementTransition("draft", "active"), "illegal_transition");
  });

  it("can send a submission back to draft", () => {
    expect(canTransitionEngagement("pending_approval", "draft")).toBe(true);
  });

  it("lets an active engagement be held and resumed", () => {
    expect(canTransitionEngagement("active", "on_hold")).toBe(true);
    expect(canTransitionEngagement("on_hold", "active")).toBe(true);
  });

  it("treats completion and cancellation as final", () => {
    expect(allowedEngagementTransitions("completed")).toEqual([]);
    expect(allowedEngagementTransitions("cancelled")).toEqual([]);
    expectCode(
      () => assertEngagementTransition("completed", "active"),
      "illegal_transition",
    );
  });

  it("allows cancellation from every open status", () => {
    for (const from of [
      "draft",
      "pending_approval",
      "approved",
      "active",
      "on_hold",
    ] as const) {
      expect(canTransitionEngagement(from, "cancelled")).toBe(true);
    }
  });

  it("covers every status", () => {
    for (const status of ENGAGEMENT_STATUSES) {
      expect(Array.isArray(allowedEngagementTransitions(status))).toBe(true);
    }
  });

  it("rejects an end date before the start date", () => {
    expectCode(
      () => assertEngagementDates("2026-06-01", "2026-05-31"),
      "validation_failed",
    );
    expect(() => assertEngagementDates("2026-06-01", "2026-06-01")).not.toThrow();
    expect(() => assertEngagementDates("2026-06-01", null)).not.toThrow();
    expect(() => assertEngagementDates(null, "2026-06-01")).not.toThrow();
  });
});

describe("the engagement approval gate", () => {
  const base = {
    status: "pending_approval" as const,
    conflictStatus: "cleared" as const,
    createdBy: "11111111-1111-1111-1111-111111111111",
  };
  const approver = "22222222-2222-2222-2222-222222222222";

  it("approves a cleared engagement for somebody other than its author", () => {
    expect(() => assertEngagementApprovable(base, approver)).not.toThrow();
  });

  it("refuses when no conflict check has been run at all", () => {
    expectCode(
      () => assertEngagementApprovable({ ...base, conflictStatus: null }, approver),
      "conflict_check_required",
    );
  });

  it("refuses when the check exists but nobody has decided it", () => {
    // An undecided check is not a clearance, which is the whole point of
    // separating the search from the decision.
    expectCode(
      () => assertEngagementApprovable({ ...base, conflictStatus: "open" }, approver),
      "conflict_check_required",
    );
  });

  it("refuses when the conflict was declined", () => {
    expectCode(
      () => assertEngagementApprovable({ ...base, conflictStatus: "declined" }, approver),
      "conflict_declined",
    );
  });

  it("allows further review through, because that is a recorded decision", () => {
    expect(() =>
      assertEngagementApprovable({ ...base, conflictStatus: "further_review" }, approver),
    ).not.toThrow();
  });

  it("refuses to let the author approve their own engagement", () => {
    expectCode(
      () => assertEngagementApprovable(base, base.createdBy),
      "self_approval_forbidden",
    );
  });

  it("still refuses an engagement that is not awaiting approval", () => {
    expectCode(
      () => assertEngagementApprovable({ ...base, status: "draft" }, approver),
      "illegal_transition",
    );
  });

  it("checks the conflict before the author, so the clearer problem is reported", () => {
    try {
      assertEngagementApprovable(
        { ...base, conflictStatus: null },
        base.createdBy,
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CrmError).code).toBe("conflict_check_required");
    }
  });
});

describe("KYC completeness", () => {
  const record = (
    checkType: KycCheckType,
    outcome: KycOutcome,
    expiresAt: string | null = null,
  ) => ({ checkType, outcome, expiresAt });

  const now = new Date("2026-06-15T00:00:00Z");

  it("requires identity, registration and ownership of every client", () => {
    expect(requiredKycChecks("low")).toEqual(KYC_BASELINE_CHECKS);
    expect(requiredKycChecks("medium")).toEqual(KYC_BASELINE_CHECKS);
  });

  it("requires sanctions and PEP screening of a high risk client", () => {
    expect(requiredKycChecks("high")).toContain("sanctions");
    expect(requiredKycChecks("high")).toContain("pep");
    expect(requiredKycChecks("critical")).toContain("sanctions");
  });

  it("reports not started when there is nothing on file", () => {
    const result = assessKyc([], "medium", now);
    expect(result.status).toBe("not_started");
    expect(result.missing).toEqual(["identity", "registration", "ownership"]);
  });

  it("reports in progress while a required check is missing", () => {
    const result = assessKyc([record("identity", "pass")], "medium", now);
    expect(result.status).toBe("in_progress");
    expect(result.missing).toEqual(["registration", "ownership"]);
  });

  it("reports in progress while a required check is still pending", () => {
    const result = assessKyc(
      [
        record("identity", "pass"),
        record("registration", "pass"),
        record("ownership", "pending"),
      ],
      "medium",
      now,
    );
    expect(result.status).toBe("in_progress");
    expect(result.unresolved).toEqual(["ownership"]);
  });

  it("treats inconclusive as unresolved rather than as a pass", () => {
    const result = assessKyc(
      [
        record("identity", "pass"),
        record("registration", "pass"),
        record("ownership", "inconclusive"),
      ],
      "medium",
      now,
    );
    expect(result.status).toBe("in_progress");
    expect(result.unresolved).toEqual(["ownership"]);
  });

  it("reports completed once every required check has passed", () => {
    const result = assessKyc(
      [
        record("identity", "pass"),
        record("registration", "pass"),
        record("ownership", "pass"),
      ],
      "medium",
      now,
    );
    expect(result.status).toBe("completed");
    expect(result.missing).toEqual([]);
  });

  it("does not count a high risk client as complete on the baseline alone", () => {
    const baseline = [
      record("identity", "pass"),
      record("registration", "pass"),
      record("ownership", "pass"),
    ];
    expect(assessKyc(baseline, "medium", now).status).toBe("completed");
    expect(assessKyc(baseline, "high", now).status).toBe("in_progress");
    expect(assessKyc(baseline, "high", now).missing).toEqual(["sanctions", "pep"]);
  });

  it("fails the whole client when one required check failed", () => {
    const result = assessKyc(
      [
        record("identity", "pass"),
        record("registration", "fail"),
        record("ownership", "pass"),
      ],
      "medium",
      now,
    );
    expect(result.status).toBe("failed");
    expect(result.failed).toEqual(["registration"]);
  });

  it("reports expired when a passed check has run out", () => {
    const result = assessKyc(
      [
        record("identity", "pass", "2026-01-01"),
        record("registration", "pass"),
        record("ownership", "pass"),
      ],
      "medium",
      now,
    );
    expect(result.status).toBe("expired");
    expect(result.expired).toEqual(["identity"]);
  });

  it("does not expire a check whose date is still ahead", () => {
    const result = assessKyc(
      [
        record("identity", "pass", "2027-01-01"),
        record("registration", "pass"),
        record("ownership", "pass"),
      ],
      "medium",
      now,
    );
    expect(result.status).toBe("completed");
  });

  it("reports failure ahead of expiry, because it is the worse problem", () => {
    const result = assessKyc(
      [
        record("identity", "pass", "2020-01-01"),
        record("registration", "fail"),
        record("ownership", "pass"),
      ],
      "medium",
      now,
    );
    expect(result.status).toBe("failed");
  });

  it("uses the most recent record of a repeated check", () => {
    // The repository returns newest first, so a re-run supersedes the failure.
    const result = assessKyc(
      [
        record("identity", "pass"),
        record("identity", "fail"),
        record("registration", "pass"),
        record("ownership", "pass"),
      ],
      "medium",
      now,
    );
    expect(result.status).toBe("completed");
  });

  it("ignores checks that are not required of this client", () => {
    const result = assessKyc(
      [
        record("identity", "pass"),
        record("registration", "pass"),
        record("ownership", "pass"),
        record("adverse_media", "fail"),
      ],
      "medium",
      now,
    );
    // Adverse media is informative at medium risk, not a gate.
    expect(result.status).toBe("completed");
  });
});

describe("conflict decisions", () => {
  it("accepts a decision on an undecided check", () => {
    expect(() => assertConflictDecidable({ decision: null })).not.toThrow();
  });

  it("refuses to change a decision once it exists", () => {
    for (const decision of ["cleared", "further_review", "declined"] as const) {
      expectCode(() => assertConflictDecidable({ decision }), "decision_immutable");
    }
  });

  it("insists on a substantive reason", () => {
    expectCode(() => assertDecisionReason(""), "validation_failed");
    expectCode(() => assertDecisionReason("ok"), "validation_failed");
    expectCode(() => assertDecisionReason("         "), "validation_failed");
    expect(() =>
      assertDecisionReason("different entity, confirmed against the registry"),
    ).not.toThrow();
  });
});

describe("match strength", () => {
  const candidate = (similarity: number, phoneticMatch = false): ConflictCandidate => ({
    searchedTerm: "ABC Holdings Ghana Limited",
    matchedTable: "crm.clients",
    matchedId: "33333333-3333-3333-3333-333333333333",
    matchedLabel: "ABC Holdings Ltd",
    similarity,
    phoneticMatch,
    matchReason: "similar spelling",
  });

  it("reports none for an empty result", () => {
    expect(matchStrength([])).toBe("none");
  });

  it("grades by the highest score, not the count", () => {
    expect(matchStrength([candidate(0.95)])).toBe("strong");
    expect(matchStrength([candidate(0.6)])).toBe("possible");
    expect(matchStrength([candidate(0.35)])).toBe("weak");
    expect(matchStrength([candidate(0.35), candidate(0.9)])).toBe("strong");
  });

  it("raises a weak spelling match to possible when the names sound alike", () => {
    expect(matchStrength([candidate(0.3, true)])).toBe("possible");
  });

  it("never claims the records are the same, whatever the score", () => {
    const summary = matchSummary([candidate(1)]);
    expect(summary).toContain("potential match");
    expect(summary).toContain("does not conclude");
    expect(summary).toContain("manager decides");
  });

  it("says plainly when nothing was found", () => {
    expect(matchSummary([])).toContain("No potential conflicts found");
  });

  it("counts matches in the summary", () => {
    expect(matchSummary([candidate(0.6)])).toContain("1 potential match");
    expect(matchSummary([candidate(0.6), candidate(0.6)])).toContain(
      "2 potential matches",
    );
  });
});

describe("screening terms", () => {
  it("drops blanks and single characters", () => {
    expect(screeningTerms(["ABC Ltd", "", null, undefined, " ", "X"])).toEqual([
      "ABC Ltd",
    ]);
  });

  it("trims and de-duplicates without regard to case", () => {
    expect(screeningTerms(["ABC Ltd", " abc ltd ", "ABC LTD"])).toEqual(["ABC Ltd"]);
  });

  it("keeps the order the form supplied, so the first spelling is the one shown", () => {
    expect(screeningTerms(["John Mensah", "ABC Ltd", "Jane Owusu"])).toEqual([
      "John Mensah",
      "ABC Ltd",
      "Jane Owusu",
    ]);
  });
});

describe("removal rules", () => {
  it("blocks a client that still has open engagements", () => {
    expectCode(() => assertClientRemovable({ activeEngagementCount: 2 }), "in_use");
    expect(() => assertClientRemovable({ activeEngagementCount: 0 })).not.toThrow();
  });

  it("counts correctly in the message, for one and for many", () => {
    try {
      assertClientRemovable({ activeEngagementCount: 1 });
    } catch (error) {
      expect((error as CrmError).message).toContain("1 engagement that is not closed");
    }
    try {
      assertClientRemovable({ activeEngagementCount: 3 });
    } catch (error) {
      expect((error as CrmError).message).toContain("3 engagements");
    }
  });

  it("blocks an engagement that has cases under it", () => {
    expectCode(
      () => assertEngagementRemovable({ status: "draft", caseCount: 1 }),
      "in_use",
    );
  });

  it("blocks an active engagement even with no cases", () => {
    expectCode(
      () => assertEngagementRemovable({ status: "active", caseCount: 0 }),
      "in_use",
    );
  });

  it("allows a draft or cancelled engagement with no cases", () => {
    expect(() =>
      assertEngagementRemovable({ status: "draft", caseCount: 0 }),
    ).not.toThrow();
    expect(() =>
      assertEngagementRemovable({ status: "cancelled", caseCount: 0 }),
    ).not.toThrow();
  });
});

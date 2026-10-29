import { describe, expect, it } from "vitest";
import { CaseworkError, isCaseworkError } from "./errors";
import {
  allowedPlanTransitions,
  allowedTaskTransitions,
  assertCanAddAssignment,
  assertCanRemoveAssignment,
  assertCorrectionIsUsable,
  assertNoPlanVersionInFlight,
  assertNoTaskCycle,
  assertPlanReviewable,
  assertPlanTransition,
  assertReturnNotes,
  assertSubTasksClosed,
  assertTaskDates,
  assertTaskStatusReason,
  assertTaskTransition,
  assertCaseDates,
  assertCaseRemovable,
  assertClosable,
  assertEngagementCanCarryCases,
  assertNotClosingOwnWork,
  assertObjectiveOrOverride,
  assertOverallRiskIsDefensible,
  assertOverrideReason,
  assertRiskApprovedForAssignment,
  assertScopeChangeDecidable,
  assertScopeChangeReason,
  assertTransition,
  assertTransitionReason,
  assessClosureReadiness,
  canTransition,
  canTransitionTask,
  isSingularRole,
} from "./policies";
import {
  PLAN_STATUSES,
  TASK_STATUSES,
  type WorkflowStage,
  type WorkflowTransition,
} from "./types";

/** Asserts the thrown error is a CaseworkError with the given code. */
function expectCode(fn: () => void, code: string) {
  try {
    fn();
  } catch (error) {
    expect(isCaseworkError(error)).toBe(true);
    expect((error as CaseworkError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

const stage = (
  key: string,
  position: number,
  isTerminal = false,
): WorkflowStage => ({
  id: `stage-${key}`,
  definitionId: "def-1",
  key,
  name: key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
  position,
  methodologyStage: null,
  isTerminal,
  requiresApproval: false,
  description: null,
});

const transition = (
  toKey: string,
  opts: { permission?: string | null; requiresReason?: boolean } = {},
): WorkflowTransition => ({
  id: `t-${toKey}`,
  toStageId: `stage-${toKey}`,
  toStageKey: toKey,
  toStageName: toKey.replace(/_/g, " "),
  requiredPermission: opts.permission ?? null,
  requiresReason: opts.requiresReason ?? true,
});

describe("the lifecycle gate", () => {
  const draftReport = stage("draft_report", 80);
  const allowed = [transition("quality_review")];

  it("permits a configured move", () => {
    expect(canTransition(allowed, "stage-quality_review")).toBe(true);
    expect(() =>
      assertTransition(draftReport, "stage-quality_review", allowed),
    ).not.toThrow();
  });

  it("refuses the move PRD 4.2 names as illegal", () => {
    // Draft Report straight to Closed, which is the example in the PRD.
    expect(canTransition(allowed, "stage-closed")).toBe(false);
    expectCode(
      () => assertTransition(draftReport, "stage-closed", allowed),
      "illegal_transition",
    );
  });

  it("names the permitted stages in the message, so the screen need not", () => {
    try {
      assertTransition(draftReport, "stage-closed", allowed);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CaseworkError).message).toContain("quality review");
    }
  });

  it("refuses to move a terminal case at all, and says so differently", () => {
    const archived = stage("archived", 140, true);
    try {
      assertTransition(archived, "stage-new", []);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CaseworkError).code).toBe("illegal_transition");
      expect((error as CaseworkError).message).toMatch(/final/i);
    }
  });

  it("says an administrator has to configure a way out of a dead end", () => {
    // Not terminal, but nothing leads anywhere: a misconfiguration rather
    // than a user error, and the message should not blame the user.
    const stuck = stage("stuck", 50);
    try {
      assertTransition(stuck, "stage-anywhere", []);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CaseworkError).message).toMatch(/administrator/i);
    }
  });

  it("takes the legal moves as data, so a renamed stage needs no code change", () => {
    // The same assertion over a lifecycle this file knows nothing about.
    const custom = stage("triage", 15);
    const customAllowed = [transition("deep_dive"), transition("rejected")];
    expect(() =>
      assertTransition(custom, "stage-deep_dive", customAllowed),
    ).not.toThrow();
    expectCode(
      () => assertTransition(custom, "stage-closed", customAllowed),
      "illegal_transition",
    );
  });

  it("demands a reason when the transition says it needs one", () => {
    const needsReason = transition("quality_review", { requiresReason: true });
    expectCode(() => assertTransitionReason(needsReason, ""), "validation_failed");
    expectCode(() => assertTransitionReason(needsReason, "ok"), "validation_failed");
    expect(() =>
      assertTransitionReason(needsReason, "ready for review"),
    ).not.toThrow();
  });

  it("does not demand one when the transition does not", () => {
    const noReason = transition("quality_review", { requiresReason: false });
    expect(() => assertTransitionReason(noReason, null)).not.toThrow();
  });
});

describe("the objective gate (PRD 5.1)", () => {
  it("passes when the case has an objective", () => {
    expect(() =>
      assertObjectiveOrOverride({
        hasObjective: true,
        objectiveOverrideReason: null,
        stagePosition: 10,
      }),
    ).not.toThrow();
  });

  it("refuses when there is neither an objective nor an override", () => {
    expectCode(
      () =>
        assertObjectiveOrOverride({
          hasObjective: false,
          objectiveOverrideReason: null,
          stagePosition: 10,
        }),
      "objective_required",
    );
  });

  it("passes on a recorded override", () => {
    expect(() =>
      assertObjectiveOrOverride({
        hasObjective: false,
        objectiveOverrideReason:
          "Retainer case: the objective is set per instruction, recorded on each task.",
        stagePosition: 10,
      }),
    ).not.toThrow();
  });

  it("does not accept a token override", () => {
    // An absent objective and a deliberate decision are different facts, and a
    // two-character reason is the first dressed as the second.
    expectCode(
      () =>
        assertObjectiveOrOverride({
          hasObjective: false,
          objectiveOverrideReason: "na",
          stagePosition: 10,
        }),
      "objective_required",
    );
    expectCode(() => assertOverrideReason("na"), "validation_failed");
    expect(() =>
      assertOverrideReason("Retainer case, objective set per instruction"),
    ).not.toThrow();
  });
});

describe("the risk gate (PRD 5.3)", () => {
  it("lets a non-critical case be assigned without approval", () => {
    for (const riskLevel of ["low", "medium", "high"] as const) {
      expect(() =>
        assertRiskApprovedForAssignment({ riskLevel, latestRiskApprovedAt: null }),
      ).not.toThrow();
    }
  });

  it("refuses to assign a critical case before the risk is approved", () => {
    expectCode(
      () =>
        assertRiskApprovedForAssignment({
          riskLevel: "critical",
          latestRiskApprovedAt: null,
        }),
      "risk_approval_required",
    );
  });

  it("lets a critical case be assigned once the risk is approved", () => {
    expect(() =>
      assertRiskApprovedForAssignment({
        riskLevel: "critical",
        latestRiskApprovedAt: "2026-10-21T10:00:00Z",
      }),
    ).not.toThrow();
  });

  it("refuses an overall rating lower than the worst dimension", () => {
    // A case with a critical safety risk is not an overall low risk, whatever
    // the rationale says.
    expectCode(
      () =>
        assertOverallRiskIsDefensible({
          operationalRisk: "low",
          legalRisk: "low",
          reputationalRisk: "low",
          safetyRisk: "critical",
          sensitivityRisk: "low",
          overallRisk: "low",
        }),
      "validation_failed",
    );
  });

  it("names the dimension that makes the rating indefensible", () => {
    try {
      assertOverallRiskIsDefensible({
        operationalRisk: "low",
        legalRisk: "high",
        reputationalRisk: "low",
        safetyRisk: "low",
        sensitivityRisk: "low",
        overallRisk: "medium",
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CaseworkError).message).toContain("high");
    }
  });

  it("allows an overall rating higher than every dimension", () => {
    // Judgement can go up: several mediums may add up to a high overall, and
    // the rationale is where that is argued.
    expect(() =>
      assertOverallRiskIsDefensible({
        operationalRisk: "medium",
        legalRisk: "medium",
        reputationalRisk: "medium",
        safetyRisk: "medium",
        sensitivityRisk: "medium",
        overallRisk: "high",
      }),
    ).not.toThrow();
  });

  it("allows an overall rating equal to the worst dimension", () => {
    expect(() =>
      assertOverallRiskIsDefensible({
        operationalRisk: "low",
        legalRisk: "high",
        reputationalRisk: "low",
        safetyRisk: "low",
        sensitivityRisk: "low",
        overallRisk: "high",
      }),
    ).not.toThrow();
  });
});

describe("scope change control (PRD 5.4)", () => {
  const pending = { status: "pending" as const, requestedBy: "author-1" };

  it("lets somebody else decide a pending request", () => {
    expect(() => assertScopeChangeDecidable(pending, "other-1")).not.toThrow();
  });

  it("refuses to let the requester decide their own", () => {
    expectCode(
      () => assertScopeChangeDecidable(pending, "author-1"),
      "self_approval_forbidden",
    );
  });

  it("refuses to decide one that is already decided", () => {
    for (const status of ["approved", "rejected", "withdrawn"] as const) {
      expectCode(
        () => assertScopeChangeDecidable({ ...pending, status }, "other-1"),
        "conflict",
      );
    }
  });

  it("insists the reason explains the change", () => {
    expectCode(() => assertScopeChangeReason("more"), "validation_failed");
    expect(() =>
      assertScopeChangeReason("The client has asked us to cover two more subsidiaries."),
    ).not.toThrow();
  });
});

describe("assignment", () => {
  it("knows which roles there can be only one of", () => {
    expect(isSingularRole("lead_investigator")).toBe(true);
    expect(isSingularRole("supervisor")).toBe(true);
    expect(isSingularRole("supporting_investigator")).toBe(false);
    expect(isSingularRole("analyst")).toBe(false);
  });

  it("refuses a second lead investigator, and names the incumbent", () => {
    const current = [
      { role: "lead_investigator" as const, userId: "u1", userName: "Ama Mensah" },
    ];
    try {
      assertCanAddAssignment("lead_investigator", current, "u2");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CaseworkError).code).toBe("conflict");
      expect((error as CaseworkError).message).toContain("Ama Mensah");
    }
  });

  it("allows as many supporting investigators as needed", () => {
    const current = [
      { role: "supporting_investigator" as const, userId: "u1", userName: "A" },
      { role: "supporting_investigator" as const, userId: "u2", userName: "B" },
    ];
    expect(() =>
      assertCanAddAssignment("supporting_investigator", current, "u3"),
    ).not.toThrow();
  });

  it("refuses to give the same person the same role twice", () => {
    const current = [
      { role: "analyst" as const, userId: "u1", userName: "A" },
    ];
    expectCode(() => assertCanAddAssignment("analyst", current, "u1"), "conflict");
  });

  it("allows the same person two different roles", () => {
    const current = [{ role: "analyst" as const, userId: "u1", userName: "A" }];
    expect(() =>
      assertCanAddAssignment("supporting_investigator", current, "u1"),
    ).not.toThrow();
  });

  it("refuses to leave an open case without a lead investigator", () => {
    expectCode(
      () =>
        assertCanRemoveAssignment(
          { role: "lead_investigator" },
          { stageIsTerminal: false, stagePosition: 50 },
          [{ role: "analyst" }],
        ),
      "conflict",
    );
  });

  it("allows the lead to be swapped when a replacement is already on", () => {
    expect(() =>
      assertCanRemoveAssignment(
        { role: "lead_investigator" },
        { stageIsTerminal: false, stagePosition: 50 },
        [{ role: "lead_investigator" }, { role: "analyst" }],
      ),
    ).not.toThrow();
  });

  it("allows the lead to come off a closed case", () => {
    expect(() =>
      assertCanRemoveAssignment(
        { role: "lead_investigator" },
        { stageIsTerminal: true, stagePosition: 130 },
        [],
      ),
    ).not.toThrow();
  });

  it("does not guard the roles a case can do without", () => {
    expect(() =>
      assertCanRemoveAssignment(
        { role: "analyst" },
        { stageIsTerminal: false, stagePosition: 50 },
        [],
      ),
    ).not.toThrow();
  });
});

describe("the closure gate (PRD 5.9)", () => {
  const ready = {
    objectivesAddressed: true,
    openTaskCount: 0,
    evidenceAccountedFor: true,
    reportApproved: true,
    deliveryRecorded: true,
    outstandingIssuesDocumented: true,
    financialStatusRecorded: true,
    lessonsLearnedRecorded: true,
    retentionClass: "standard_7_years",
  };

  it("checks all nine of the PRD's requirements", () => {
    const readiness = assessClosureReadiness(ready);
    expect(readiness.requirements).toHaveLength(9);
    expect(readiness.ready).toBe(true);
    expect(readiness.outstanding).toEqual([]);
    expect(() => assertClosable(readiness)).not.toThrow();
  });

  it("blocks closure while any single item is incomplete", () => {
    const keys = [
      ["objectivesAddressed", false],
      ["evidenceAccountedFor", false],
      ["reportApproved", false],
      ["deliveryRecorded", false],
      ["outstandingIssuesDocumented", false],
      ["financialStatusRecorded", false],
      ["lessonsLearnedRecorded", false],
      ["retentionClass", null],
      ["openTaskCount", 3],
    ] as const;

    for (const [key, value] of keys) {
      const readiness = assessClosureReadiness({ ...ready, [key]: value });
      expect(readiness.ready, `${key} should block closure`).toBe(false);
      expectCode(() => assertClosable(readiness), "closure_blocked");
    }
  });

  it("says which items are outstanding, not just that it is blocked", () => {
    const readiness = assessClosureReadiness({
      ...ready,
      reportApproved: false,
      lessonsLearnedRecorded: false,
    });
    expect(readiness.outstanding.map((r) => r.key)).toEqual(["report", "lessons"]);
    try {
      assertClosable(readiness);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CaseworkError).message).toContain("Report approved");
      expect((error as CaseworkError).message).toContain("Lessons learned");
    }
  });

  it("counts open tasks in the remedy, so the screen can say how many", () => {
    expect(
      assessClosureReadiness({ ...ready, openTaskCount: 1 }).outstanding[0].remedy,
    ).toContain("1 task is still open");
    expect(
      assessClosureReadiness({ ...ready, openTaskCount: 4 }).outstanding[0].remedy,
    ).toContain("4 tasks are still open");
  });

  it("treats a blank retention class as unset", () => {
    expect(assessClosureReadiness({ ...ready, retentionClass: "   " }).ready).toBe(
      false,
    );
  });

  it("refuses to let the lead investigator close their own case", () => {
    expectCode(
      () => assertNotClosingOwnWork({ leadInvestigatorId: "u1" }, "u1"),
      "self_approval_forbidden",
    );
    expect(() =>
      assertNotClosingOwnWork({ leadInvestigatorId: "u1" }, "supervisor-1"),
    ).not.toThrow();
  });

  it("does not block closure of a case with no lead at all", () => {
    expect(() =>
      assertNotClosingOwnWork({ leadInvestigatorId: null }, "supervisor-1"),
    ).not.toThrow();
  });
});

describe("case creation", () => {
  it("requires an engagement PDDC has committed to", () => {
    for (const status of ["approved", "active"] as const) {
      expect(() =>
        assertEngagementCanCarryCases({ status, engagementId: "ENG-2026-000001" }),
      ).not.toThrow();
    }
  });

  it("refuses a draft or unapproved engagement, and explains the order", () => {
    for (const status of ["draft", "pending_approval"] as const) {
      try {
        assertEngagementCanCarryCases({ status, engagementId: "ENG-2026-000001" });
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as CaseworkError).code).toBe("engagement_not_active");
        expect((error as CaseworkError).message).toMatch(/conflict check/i);
      }
    }
  });

  it("refuses a finished or cancelled engagement differently", () => {
    for (const status of ["completed", "cancelled", "on_hold"] as const) {
      try {
        assertEngagementCanCarryCases({ status, engagementId: "ENG-2026-000002" });
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as CaseworkError).message).toContain("ENG-2026-000002");
        expect((error as CaseworkError).message).not.toMatch(/conflict check/i);
      }
    }
  });

  it("rejects a target date before the case was opened", () => {
    expectCode(
      () => assertCaseDates("2026-06-01", "2026-05-01"),
      "validation_failed",
    );
    expect(() => assertCaseDates("2026-06-01", "2026-07-01")).not.toThrow();
    expect(() => assertCaseDates("2026-06-01", null)).not.toThrow();
    expect(() => assertCaseDates(null, "2026-07-01")).not.toThrow();
  });
});

describe("removal", () => {
  it("allows a case that has not passed assignment to be removed", () => {
    expect(() =>
      assertCaseRemovable({
        stageIsTerminal: false,
        stagePosition: 10,
        openTaskCount: 0,
      }),
    ).not.toThrow();
  });

  it("refuses to remove a case the work has started on", () => {
    expectCode(
      () =>
        assertCaseRemovable({
          stageIsTerminal: false,
          stagePosition: 50,
          openTaskCount: 0,
        }),
      "in_use",
    );
  });

  it("refuses to remove a case with open tasks", () => {
    expectCode(
      () =>
        assertCaseRemovable({
          stageIsTerminal: false,
          stagePosition: 10,
          openTaskCount: 2,
        }),
      "in_use",
    );
  });
});

describe("the task state machine (PRD 9.1)", () => {
  it("runs the ordinary path", () => {
    expect(canTransitionTask("not_started", "in_progress")).toBe(true);
    expect(canTransitionTask("in_progress", "completed")).toBe(true);
  });

  it("lets a task be blocked and unblocked, which is what blocking is", () => {
    expect(canTransitionTask("in_progress", "blocked")).toBe(true);
    expect(canTransitionTask("blocked", "in_progress")).toBe(true);
    expect(canTransitionTask("not_started", "blocked")).toBe(true);
  });

  it("will not complete a task that was never started", () => {
    expect(canTransitionTask("not_started", "completed")).toBe(false);
    expectCode(
      () => assertTaskTransition("not_started", "completed"),
      "illegal_transition",
    );
  });

  it("will not complete a blocked task without unblocking it", () => {
    expect(canTransitionTask("blocked", "completed")).toBe(false);
  });

  it("treats completed and cancelled as final, and says why", () => {
    for (const from of ["completed", "cancelled"] as const) {
      expect(allowedTaskTransitions(from)).toEqual([]);
      try {
        assertTaskTransition(from, "in_progress");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as CaseworkError).code).toBe("illegal_transition");
        // The remedy, not just the refusal.
        expect((error as CaseworkError).message).toMatch(/raise a new task/i);
      }
    }
  });

  it("allows cancellation from any open status", () => {
    for (const from of ["not_started", "in_progress", "blocked"] as const) {
      expect(canTransitionTask(from, "cancelled")).toBe(true);
    }
  });

  it("covers every status", () => {
    for (const status of TASK_STATUSES) {
      expect(Array.isArray(allowedTaskTransitions(status))).toBe(true);
    }
  });

  it("demands a reason for blocking, and says what it is for", () => {
    expectCode(() => assertTaskStatusReason("blocked", ""), "validation_failed");
    expectCode(() => assertTaskStatusReason("blocked", "n/a"), "validation_failed");
    try {
      assertTaskStatusReason("blocked", "");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CaseworkError).message).toMatch(/what is blocking/i);
    }
    expect(() =>
      assertTaskStatusReason("blocked", "Waiting on the registry search"),
    ).not.toThrow();
  });

  it("demands a reason for cancelling", () => {
    expectCode(() => assertTaskStatusReason("cancelled", ""), "validation_failed");
    expect(() =>
      assertTaskStatusReason("cancelled", "Duplicate of TSK-2026-000004"),
    ).not.toThrow();
  });

  it("does not demand one for the ordinary statuses", () => {
    for (const status of ["not_started", "in_progress", "completed"] as const) {
      expect(() => assertTaskStatusReason(status, null)).not.toThrow();
    }
  });

  it("rejects a due date before the start date", () => {
    expectCode(() => assertTaskDates("2026-06-10", "2026-06-01"), "validation_failed");
    expect(() => assertTaskDates("2026-06-01", "2026-06-10")).not.toThrow();
    expect(() => assertTaskDates(null, "2026-06-10")).not.toThrow();
  });

  it("refuses a sub-task cycle, including the indirect kind", () => {
    expect(() => assertNoTaskCycle("t1", null, [])).not.toThrow();
    expect(() => assertNoTaskCycle("t1", "t2", ["t3"])).not.toThrow();

    expectCode(() => assertNoTaskCycle("t1", "t1", []), "validation_failed");
    // t1 -> t2, where t2's ancestors already include t1.
    expectCode(() => assertNoTaskCycle("t1", "t2", ["t2", "t1"]), "validation_failed");
  });

  it("will not complete a parent with open sub-tasks", () => {
    expectCode(() => assertSubTasksClosed(2, "completed"), "conflict");
    expect(() => assertSubTasksClosed(0, "completed")).not.toThrow();
    // Only completion is gated: a parent can be blocked or cancelled with
    // open children, because that is what cascading a problem looks like.
    expect(() => assertSubTasksClosed(2, "blocked")).not.toThrow();
    expect(() => assertSubTasksClosed(2, "cancelled")).not.toThrow();
  });

  it("counts correctly in the message, for one and for many", () => {
    try {
      assertSubTasksClosed(1, "completed");
    } catch (error) {
      expect((error as CaseworkError).message).toContain("1 open sub-task.");
    }
    try {
      assertSubTasksClosed(3, "completed");
    } catch (error) {
      expect((error as CaseworkError).message).toContain("3 open sub-tasks");
    }
  });
});

describe("activity corrections (PRD 9.4)", () => {
  it("accepts a correction of an uncorrected entry", () => {
    expect(() =>
      assertCorrectionIsUsable(
        { id: "a1", correctedByActivityId: null },
        "The date was wrong: it was the 14th, not the 15th.",
      ),
    ).not.toThrow();
  });

  it("refuses to correct an entry that no longer exists", () => {
    expectCode(() => assertCorrectionIsUsable(null, "a good reason here"), "not_found");
  });

  it("refuses to correct a correction, so the log reads as one sequence", () => {
    expectCode(
      () =>
        assertCorrectionIsUsable(
          { id: "a1", correctedByActivityId: "a2" },
          "Correcting the original again.",
        ),
      "conflict",
    );
  });

  it("insists the correction says what was wrong", () => {
    expectCode(
      () => assertCorrectionIsUsable({ id: "a1", correctedByActivityId: null }, "oops"),
      "validation_failed",
    );
  });
});

describe("the investigation plan gate (PRD 9.3)", () => {
  it("runs draft, submitted, approved", () => {
    expect(() => assertPlanTransition("draft", "submitted")).not.toThrow();
    expect(() => assertPlanTransition("submitted", "approved")).not.toThrow();
  });

  it("lets a reviewer return a plan, and the investigator resubmit it", () => {
    expect(() => assertPlanTransition("submitted", "returned")).not.toThrow();
    expect(() => assertPlanTransition("returned", "submitted")).not.toThrow();
  });

  it("will not approve a draft that was never submitted", () => {
    expectCode(() => assertPlanTransition("draft", "approved"), "illegal_transition");
  });

  it("refuses to change an approved plan, and names the remedy", () => {
    try {
      assertPlanTransition("approved", "draft");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CaseworkError).code).toBe("illegal_transition");
      expect((error as CaseworkError).message).toMatch(/next version/i);
    }
  });

  it("covers every status", () => {
    for (const status of PLAN_STATUSES) {
      expect(Array.isArray(allowedPlanTransitions(status))).toBe(true);
    }
  });

  it("refuses to let the submitter review their own plan", () => {
    expectCode(
      () =>
        assertPlanReviewable({ status: "submitted", submittedBy: "u1" }, "u1"),
      "self_approval_forbidden",
    );
    expect(() =>
      assertPlanReviewable({ status: "submitted", submittedBy: "u1" }, "supervisor-1"),
    ).not.toThrow();
  });

  it("insists a returned plan says what to fix", () => {
    expectCode(() => assertReturnNotes("no"), "validation_failed");
    expect(() =>
      assertReturnNotes("The methodology does not cover the bank records."),
    ).not.toThrow();
  });

  it("allows a new version only when none is in flight", () => {
    expect(() => assertNoPlanVersionInFlight(null)).not.toThrow();

    // A submitted version is awaiting somebody; a draft is awaiting its
    // author. Both block a third, and the message says which.
    try {
      assertNoPlanVersionInFlight({ versionNo: 2, status: "submitted" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CaseworkError).message).toMatch(/awaiting review/i);
    }
    try {
      assertNoPlanVersionInFlight({ versionNo: 3, status: "draft" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CaseworkError).message).toMatch(/still a draft/i);
    }
  });
});

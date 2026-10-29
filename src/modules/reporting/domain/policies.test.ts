import { describe, expect, it } from "vitest";
import { ReportingError } from "./errors";
import {
  allowedReportTransitions,
  assertClosureReady,
  assertClosureReturnHasNotes,
  assertDeliverable,
  assertNotApprovingOwnClosure,
  assertNotDecidingOwnReport,
  assertNotReviewingOwnReport,
  assertQaFailuresHaveComments,
  assertQaReviewComplete,
  assertReportTransition,
  assertSectionsCiteTheirSupport,
  assertVersionChangeNote,
  assertVersionEditable,
  assertVersionHasContent,
  closureGate,
  isArchived,
  lessonsRecorded,
  nextReportVersionLabel,
  qaProgress,
  qaResultFromItems,
  unansweredQaItems,
  uncitedSections,
  workflowPosition,
  type ClosureRequirementState,
} from "./policies";

/**
 * The reporting, QA and closure rules, with no database.
 *
 * Every test here is a statement about how PDDC's work is done rather than
 * about how the code is arranged, which is why the names read as sentences.
 */

const READY: ClosureRequirementState = {
  objectivesOutcome: "All three questions answered in the final report.",
  evidenceDisposition: "Returned to the client, logged in the custody ledger.",
  financialStatus: "Billed in full, nothing written off.",
  retentionClass: "standard_7",
  lessonsRecorded: true,
  outstandingIssuesDocumented: true,
  openTaskCount: 0,
  reportApproved: true,
  deliveryRecorded: true,
  evidenceOnRelease: 0,
};

describe("the report workflow (PRD 10.1)", () => {
  it("offers only the moves the line permits", () => {
    expect(allowedReportTransitions("draft")).toEqual([
      "investigator_review",
      "withdrawn",
    ]);
    expect(allowedReportTransitions("final")).toEqual(["delivered", "withdrawn"]);
    expect(allowedReportTransitions("delivered")).toEqual([]);
  });

  it("refuses to skip a stage, and says why that matters", () => {
    expect(() => assertReportTransition("draft", "final")).toThrow(
      /skipping one is skipping the reader/,
    );
    expect(() => assertReportTransition("draft", "approval")).toThrow(
      /cannot go straight from/,
    );
  });

  it("walks the line one stage at a time", () => {
    const line = [
      "draft",
      "investigator_review",
      "supervisor_review",
      "qa_review",
      "approval",
      "final",
      "delivered",
    ] as const;

    for (let index = 0; index < line.length - 1; index += 1) {
      expect(() =>
        assertReportTransition(line[index], line[index + 1]),
      ).not.toThrow();
    }
  });

  it("sends any review stage back to draft", () => {
    for (const stage of [
      "investigator_review",
      "supervisor_review",
      "qa_review",
      "approval",
    ] as const) {
      expect(() => assertReportTransition(stage, "draft")).not.toThrow();
    }
  });

  it("treats a delivered report as history", () => {
    expect(() => assertReportTransition("delivered", "draft")).toThrow(
      /A correction is the next version/,
    );
  });

  it("knows where it is in the line, for a progress rail", () => {
    expect(workflowPosition("draft")).toEqual({ index: 0, total: 7 });
    expect(workflowPosition("final")).toEqual({ index: 5, total: 7 });
    // Withdrawn is not on the line at all, which a rail has to cope with.
    expect(workflowPosition("withdrawn").index).toBe(-1);
  });
});

describe("nobody passes on their own work (PRD 10.1, PRD 16)", () => {
  const report = { author: "author-1" };
  const version = { createdBy: "author-1" };

  it("refuses the report's author", () => {
    expect(() => assertNotDecidingOwnReport(report, version, "author-1")).toThrow(
      /you cannot be the one who passes it on/,
    );
  });

  it("refuses whoever wrote the version, even on somebody else's report", () => {
    expect(() =>
      assertNotDecidingOwnReport({ author: "other" }, version, "author-1"),
    ).toThrow(/you cannot be the one/);
  });

  it("allows a third person", () => {
    expect(() =>
      assertNotDecidingOwnReport(report, version, "supervisor-1"),
    ).not.toThrow();
  });

  it("refuses the author as its QA reviewer", () => {
    expect(() => assertNotReviewingOwnReport(report, "author-1")).toThrow(
      /cannot be its QA reviewer/,
    );
    expect(() => assertNotReviewingOwnReport(report, "qa-1")).not.toThrow();
  });
});

describe("a version has to be worth reading before it goes out", () => {
  it("refuses a version with no sections and no summary", () => {
    expect(() =>
      assertVersionHasContent({
        sectionCount: 0,
        executiveSummary: null,
        conclusion: "   ",
      }),
    ).toThrow(/nothing for a reviewer to read/);
  });

  it("accepts one with sections", () => {
    expect(() =>
      assertVersionHasContent({
        sectionCount: 3,
        executiveSummary: null,
        conclusion: null,
      }),
    ).not.toThrow();
  });

  it("accepts one that is only a summary, which an interim report may be", () => {
    expect(() =>
      assertVersionHasContent({
        sectionCount: 0,
        executiveSummary: "Work in progress; three payments identified so far.",
        conclusion: null,
      }),
    ).not.toThrow();
  });
});

describe("every statement cites what it rests on (PRD 10.2)", () => {
  const section = (over: Partial<Parameters<typeof uncitedSections>[0][number]>) => ({
    heading: "A heading",
    sectionType: "narrative",
    body: "Something is asserted here.",
    citations: [],
    ...over,
  });

  it("names a narrative section that cites nothing", () => {
    expect(uncitedSections([section({ heading: "The payments" })])).toEqual([
      "The payments",
    ]);
  });

  it("exempts the sections that describe the work rather than its findings", () => {
    for (const sectionType of [
      "background",
      "methodology",
      "exhibit_schedule",
      "appendix",
    ]) {
      expect(uncitedSections([section({ sectionType })])).toEqual([]);
    }
  });

  it("exempts an empty section, which is a heading somebody has not written yet", () => {
    expect(uncitedSections([section({ body: "  " })])).toEqual([]);
    expect(uncitedSections([section({ body: null })])).toEqual([]);
  });

  it("accepts a section that cites something", () => {
    expect(uncitedSections([section({ citations: [{ id: "c1" }] })])).toEqual([]);
  });

  it("refuses submission and lists the sections, so the author knows which", () => {
    expect(() =>
      assertSectionsCiteTheirSupport([
        section({ heading: "The payments" }),
        section({ heading: "The conclusion", sectionType: "conclusion" }),
      ]),
    ).toThrow(/The payments, The conclusion/);
  });
});

describe("versions (PRD 10.2)", () => {
  it("steps the draft series, and takes the next whole number for a final", () => {
    expect(nextReportVersionLabel(null)).toBe("v0.1");
    expect(nextReportVersionLabel(null, "final")).toBe("v1.0");
    expect(nextReportVersionLabel({ versionLabel: "v0.3" })).toBe("v0.4");
    expect(nextReportVersionLabel({ versionLabel: "v0.3" }, "final")).toBe("v1.0");
    expect(nextReportVersionLabel({ versionLabel: "v1.0" })).toBe("v1.1");
    expect(nextReportVersionLabel({ versionLabel: "v1.2" }, "final")).toBe("v2.0");
  });

  it("does not guess at a label it does not recognise", () => {
    expect(nextReportVersionLabel({ versionLabel: "final draft" })).toBe("v0.1");
  });

  it("locks an approved version", () => {
    expect(() =>
      assertVersionEditable({ versionLabel: "v1.0", isApproved: true }),
    ).toThrow(/approved and locked/);
    expect(() =>
      assertVersionEditable({ versionLabel: "v1.1", isApproved: false }),
    ).not.toThrow();
  });

  it("requires a reason for a version that replaces an approved one", () => {
    expect(() => assertVersionChangeNote({ isApproved: true }, "fixed")).toThrow(
      /at least ten characters/,
    );
    expect(() =>
      assertVersionChangeNote(
        { isApproved: true },
        "Corrected the account number in paragraph 14.",
      ),
    ).not.toThrow();
    // A first version, and one replacing an unapproved draft, need none.
    expect(() => assertVersionChangeNote(null, null)).not.toThrow();
    expect(() => assertVersionChangeNote({ isApproved: false }, null)).not.toThrow();
  });
});

describe("QA review (PRD 10.3)", () => {
  const checklist = [
    { key: "scope_addressed", label: "Scope addressed" },
    { key: "dates_verified", label: "Dates verified" },
    { key: "names_verified", label: "Names verified" },
  ];

  it("is not complete while an item is unanswered", () => {
    expect(
      unansweredQaItems(checklist, [{ itemKey: "scope_addressed" }]),
    ).toEqual(["Dates verified", "Names verified"]);

    expect(() =>
      assertQaReviewComplete(checklist, [{ itemKey: "scope_addressed" }]),
    ).toThrow(/Dates verified, Names verified/);
  });

  it("is complete once every item is answered", () => {
    expect(() =>
      assertQaReviewComplete(
        checklist,
        checklist.map((item) => ({ itemKey: item.key })),
      ),
    ).not.toThrow();
  });

  it("derives the result from the items, never from what was clicked", () => {
    expect(qaResultFromItems([{ result: "pass" }, { result: "pass" }])).toBe(
      "approved",
    );
    expect(
      qaResultFromItems([{ result: "pass" }, { result: "not_applicable" }]),
    ).toBe("approved");
    // One failure is a return. This is the only thing a checklist is for.
    expect(qaResultFromItems([{ result: "pass" }, { result: "fail" }])).toBe(
      "returned",
    );
  });

  it("refuses a failure with no comment", () => {
    expect(() =>
      assertQaFailuresHaveComments([
        { itemKey: "dates_verified", result: "fail", comment: "  " },
      ]),
    ).toThrow(/needs a comment/);

    expect(() =>
      assertQaFailuresHaveComments([
        {
          itemKey: "dates_verified",
          result: "fail",
          comment: "Paragraph 9 says March; the statement says April.",
        },
        { itemKey: "scope_addressed", result: "pass", comment: null },
      ]),
    ).not.toThrow();
  });

  it("says how a part-finished review would come out", () => {
    const progress = qaProgress(
      {
        result: null,
        items: [
          {
            id: "1",
            reviewId: "r",
            itemKey: "scope_addressed",
            label: "Scope",
            guidance: null,
            position: 1,
            result: "pass",
            comment: null,
          },
          {
            id: "2",
            reviewId: "r",
            itemKey: "dates_verified",
            label: "Dates",
            guidance: null,
            position: 2,
            result: "fail",
            comment: "Wrong month",
          },
        ],
      },
      checklist,
    );

    expect(progress).toEqual({
      answered: 2,
      total: 3,
      failed: 1,
      wouldBe: "returned",
    });
  });
});

describe("delivery (PRD 10.2)", () => {
  it("refuses a version nobody approved", () => {
    expect(() =>
      assertDeliverable(
        { status: "final", reportId: "RPT-2026-000001" },
        { versionLabel: "v0.3", isApproved: false },
      ),
    ).toThrow(/has not been approved/);
  });

  it("refuses a report that has not reached final", () => {
    expect(() =>
      assertDeliverable(
        { status: "qa_review", reportId: "RPT-2026-000001" },
        { versionLabel: "v1.0", isApproved: true },
      ),
    ).toThrow(/goes to a client once it is final/);
  });

  it("allows a final report's approved version", () => {
    expect(() =>
      assertDeliverable(
        { status: "final", reportId: "RPT-2026-000001" },
        { versionLabel: "v1.0", isApproved: true },
      ),
    ).not.toThrow();
  });

  it("allows a second delivery of an already delivered report", () => {
    // A client asking for it again is not a workflow problem.
    expect(() =>
      assertDeliverable(
        { status: "delivered", reportId: "RPT-2026-000001" },
        { versionLabel: "v1.0", isApproved: true },
      ),
    ).not.toThrow();
  });
});

describe("closure (PRD 5.9)", () => {
  it("is ready when all nine requirements are met", () => {
    const gate = closureGate(READY);
    expect(gate.items).toHaveLength(9);
    expect(gate.ready).toBe(true);
    expect(gate.blocking).toEqual([]);
  });

  it("blocks on an open task, and says how many", () => {
    const gate = closureGate({ ...READY, openTaskCount: 3 });
    expect(gate.ready).toBe(false);
    expect(gate.blocking.map((item) => item.key)).toEqual(["tasks"]);
    expect(gate.blocking[0].remedy).toContain("3 tasks are still open");
  });

  it("blocks on evidence still out on release, whatever the disposition says", () => {
    const gate = closureGate({ ...READY, evidenceOnRelease: 1 });
    expect(gate.ready).toBe(false);
    expect(gate.blocking[0].remedy).toContain("still out on release");
  });

  it("marks the three computed requirements as computed", () => {
    const computed = closureGate(READY)
      .items.filter((item) => item.computed)
      .map((item) => item.key);

    // Nobody can tick these: they are read from the records. A checklist that
    // let somebody attest to "report approved" would look like assurance and
    // be none.
    expect(computed).toEqual(["tasks", "report", "delivery"]);
  });

  it("blocks when no report has been approved", () => {
    const gate = closureGate({ ...READY, reportApproved: false });
    expect(gate.blocking.map((item) => item.key)).toEqual(["report"]);
    expect(gate.blocking[0].computed).toBe(true);
  });

  it("blocks when nothing was delivered to the client", () => {
    expect(
      closureGate({ ...READY, deliveryRecorded: false }).blocking.map((i) => i.key),
    ).toEqual(["delivery"]);
  });

  it("treats silence about outstanding issues as unanswered", () => {
    const gate = closureGate({ ...READY, outstandingIssuesDocumented: false });
    expect(gate.blocking[0].remedy).toContain('"Nothing outstanding" is an answer');
  });

  it("lists every unmet requirement when it refuses", () => {
    try {
      assertClosureReady({
        ...READY,
        openTaskCount: 2,
        reportApproved: false,
        retentionClass: null,
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ReportingError);
      const reportingError = error as ReportingError;
      expect(reportingError.code).toBe("closure_blocked");
      expect(reportingError.message).toContain("Tasks completed");
      expect(reportingError.message).toContain("Report approved");
      expect(reportingError.message).toContain("Retention class selected");
      expect(reportingError.details?.blocking).toEqual([
        "tasks",
        "report",
        "retention",
      ]);
    }
  });

  it("refuses the proposer as the approver", () => {
    expect(() =>
      assertNotApprovingOwnClosure({ proposedBy: "lead-1" }, "lead-1"),
    ).toThrow(/you cannot approve it/);
    expect(() =>
      assertNotApprovingOwnClosure({ proposedBy: "lead-1" }, "supervisor-1"),
    ).not.toThrow();
  });

  it("refuses a return with no note", () => {
    expect(() => assertClosureReturnHasNotes("returned", "no")).toThrow(
      /at least ten characters/,
    );
    expect(() =>
      assertClosureReturnHasNotes(
        "returned",
        "The evidence disposition does not mention the two working copies.",
      ),
    ).not.toThrow();
    expect(() => assertClosureReturnHasNotes("approved", null)).not.toThrow();
  });

  it("counts lessons as recorded when any substantive question is answered", () => {
    expect(lessonsRecorded({})).toBe(false);
    expect(lessonsRecorded({ whatWorked: "  " })).toBe(false);
    expect(lessonsRecorded({ whatWorked: "The early registry search." })).toBe(true);
    expect(lessonsRecorded({ recommendations: "Ask for statements sooner." })).toBe(
      true,
    );
    expect(
      lessonsRecorded({ methodologicalLessons: "Reconcile before interviewing." }),
    ).toBe(true);
  });
});

describe("the archive (screen 21)", () => {
  it("is a closed case whose closure was approved, not a separate store", () => {
    expect(isArchived({ stageIsTerminal: true, closureStatus: "approved" })).toBe(
      true,
    );
    expect(isArchived({ stageIsTerminal: true, closureStatus: "proposed" })).toBe(
      false,
    );
    expect(isArchived({ stageIsTerminal: false, closureStatus: "approved" })).toBe(
      false,
    );
    expect(isArchived({ stageIsTerminal: true, closureStatus: null })).toBe(false);
  });
});

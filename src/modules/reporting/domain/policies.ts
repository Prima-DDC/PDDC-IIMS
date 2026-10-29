import { ReportingError } from "./errors";
import {
  REPORT_WORKFLOW,
  type QaItemResult,
  type QaReview,
  type Report,
  type ReportStatus,
  type ReportVersion,
} from "./types";

/**
 * The rules of reporting, QA and closure (PRD 5.9, 10).
 *
 * Pure functions over plain data. Everything here is a rule somebody at PDDC
 * would recognise as part of how the work is done, rather than a constraint
 * that happens to be convenient to code.
 */

/* ------------------------------------------------- the report workflow */

/**
 * PRD 10.1's line: Draft, Investigator Review, Supervisor Review, QA Review,
 * Approval, Final, Client Delivery.
 *
 * Forward one stage at a time, back to draft from any review, and withdrawn
 * from anywhere before delivery. It is deliberately narrow, because the only
 * thing a workflow is for is the stages it will not let you skip: a report
 * that went from Draft to Final would be a report nobody reviewed.
 */
export const REPORT_TRANSITIONS: Record<ReportStatus, readonly ReportStatus[]> = {
  draft: ["investigator_review", "withdrawn"],
  investigator_review: ["supervisor_review", "draft", "withdrawn"],
  supervisor_review: ["qa_review", "draft", "withdrawn"],
  qa_review: ["approval", "draft", "withdrawn"],
  approval: ["final", "draft", "withdrawn"],
  final: ["delivered", "withdrawn"],
  // A delivered report is history. A correction is the next version, which
  // starts at draft on the same report.
  delivered: [],
  withdrawn: [],
};

export function allowedReportTransitions(
  from: ReportStatus,
): readonly ReportStatus[] {
  return REPORT_TRANSITIONS[from];
}

export function assertReportTransition(
  from: ReportStatus,
  to: ReportStatus,
): void {
  if (REPORT_TRANSITIONS[from].includes(to)) return;

  const skipped =
    REPORT_WORKFLOW.indexOf(to) - REPORT_WORKFLOW.indexOf(from) > 1;

  throw new ReportingError(
    "illegal_transition",
    from === "delivered"
      ? "This report has been delivered to the client, so it is history. A correction is the next version, which starts as a draft."
      : skipped
        ? `A report cannot go straight from ${from.replace(/_/g, " ")} to ${to.replace(/_/g, " ")}. Every stage in PRD 10.1 is somebody reading it, and skipping one is skipping the reader.`
        : `A report cannot go from ${from.replace(/_/g, " ")} to ${to.replace(/_/g, " ")}.`,
  );
}

/** Which stage of PRD 10.1 this is, for a progress rail. */
export function workflowPosition(status: ReportStatus): {
  index: number;
  total: number;
} {
  const index = REPORT_WORKFLOW.indexOf(status);
  return { index, total: REPORT_WORKFLOW.length };
}

/**
 * PRD 10.1: "The author can never approve their own report."
 *
 * Applied at every decision point rather than only at the final approval,
 * because an author who reviewed their own work at the supervisor stage has
 * defeated the same rule one step earlier.
 */
export function assertNotDecidingOwnReport(
  report: Pick<Report, "author">,
  version: Pick<ReportVersion, "createdBy">,
  deciderId: string,
): void {
  if (report.author !== deciderId && version.createdBy !== deciderId) return;

  throw new ReportingError(
    "self_approval_forbidden",
    "You wrote this report, so you cannot be the one who passes it on. Somebody other than its author has to, which is the only thing that makes the review worth having.",
  );
}

/**
 * A report cannot go out for review with nothing in it.
 *
 * Checked when it is submitted rather than while it is drafted, because a
 * draft is a work in progress.
 */
export function assertVersionHasContent(version: {
  sectionCount: number;
  executiveSummary: string | null;
  conclusion: string | null;
}): void {
  if (version.sectionCount > 0) return;
  if (version.executiveSummary?.trim() || version.conclusion?.trim()) return;

  throw new ReportingError(
    "validation_failed",
    "This version has no sections and no summary, so there is nothing for a reviewer to read. Write it first.",
  );
}

/**
 * Every factual section cites something (PRD 10.2, 10.3).
 *
 * Narrative, finding, analysis and conclusion sections are where a report
 * asserts things about the world, and PRD 10.3's QA checklist asks a reviewer
 * to confirm that each one cites the exhibit it rests on. Catching it at
 * submission saves the reviewer the job and tells the author which section.
 *
 * Background, methodology, appendix and the schedule of exhibits are exempt:
 * they describe the work rather than its findings.
 */
const MUST_CITE = new Set([
  "narrative",
  "finding",
  "analysis",
  "conclusion",
  "recommendation",
]);

export function uncitedSections(
  sections: Array<{
    heading: string;
    sectionType: string;
    body: string | null;
    citations: unknown[];
  }>,
): string[] {
  return sections
    .filter(
      (section) =>
        MUST_CITE.has(section.sectionType) &&
        (section.body?.trim().length ?? 0) > 0 &&
        section.citations.length === 0,
    )
    .map((section) => section.heading);
}

export function assertSectionsCiteTheirSupport(
  sections: Array<{
    heading: string;
    sectionType: string;
    body: string | null;
    citations: unknown[];
  }>,
): void {
  const uncited = uncitedSections(sections);
  if (uncited.length === 0) return;

  throw new ReportingError(
    "not_citable",
    `${uncited.length === 1 ? "This section asserts" : "These sections assert"} something and cites nothing: ${uncited.join(", ")}. PRD 10.2 wants every statement to cite the finding or exhibit it rests on, and a QA reviewer will send it back for exactly this.`,
  );
}

/* ---------------------------------------------------------- versioning */

/**
 * The next version label (PRD 10.2: v0.1 ... v1.0 ... Approved Final).
 *
 * A draft steps the minor number; a final one takes the next whole number.
 * Derived rather than typed, so a report's history cannot acquire two v1.0s.
 */
export function nextReportVersionLabel(
  previous: { versionLabel: string } | null,
  intent: "draft" | "final" = "draft",
): string {
  if (!previous) return intent === "final" ? "v1.0" : "v0.1";

  const match = /^v(\d+)\.(\d+)$/.exec(previous.versionLabel.trim());
  if (!match) return intent === "final" ? "v1.0" : "v0.1";

  const major = Number(match[1]);
  const minor = Number(match[2]);
  return intent === "final" ? `v${major + 1}.0` : `v${major}.${minor + 1}`;
}

export function assertVersionEditable(
  version: Pick<ReportVersion, "versionLabel" | "isApproved">,
): void {
  if (!version.isApproved) return;

  throw new ReportingError(
    "approved_locked",
    `${version.versionLabel} is approved and locked. A change from here is the next version, with a reason, approved again (PRD 10.2).`,
  );
}

export function assertVersionChangeNote(
  previous: Pick<ReportVersion, "isApproved"> | null,
  changeNote: string | null | undefined,
): void {
  if (!previous?.isApproved) return;
  if (changeNote && changeNote.trim().length >= 10) return;

  throw new ReportingError(
    "validation_failed",
    "Say what changed, in at least ten characters. This replaces a version somebody approved and a client may already have read.",
  );
}

/* ------------------------------------------------------ QA (PRD 10.3) */

/**
 * A QA review is complete when every item has been answered.
 *
 * Not "most items": the checklist is a list of things somebody has to look
 * at, and an unanswered item is one nobody looked at.
 */
export function unansweredQaItems(
  checklist: Array<{ key: string; label: string }>,
  answers: Array<{ itemKey: string }>,
): string[] {
  const answered = new Set(answers.map((answer) => answer.itemKey));
  return checklist
    .filter((item) => !answered.has(item.key))
    .map((item) => item.label);
}

export function assertQaReviewComplete(
  checklist: Array<{ key: string; label: string }>,
  answers: Array<{ itemKey: string }>,
): void {
  const unanswered = unansweredQaItems(checklist, answers);
  if (unanswered.length === 0) return;

  throw new ReportingError(
    "qa_incomplete",
    `${unanswered.length} ${unanswered.length === 1 ? "item has" : "items have"} not been answered: ${unanswered.join(", ")}. An unanswered item is one nobody looked at.`,
  );
}

/**
 * The result follows the items, and is never typed.
 *
 * The one thing a checklist is for. A review with a failed item is a return,
 * whatever the reviewer meant to click.
 */
export function qaResultFromItems(
  answers: Array<{ result: QaItemResult }>,
): "approved" | "returned" {
  return answers.some((answer) => answer.result === "fail")
    ? "returned"
    : "approved";
}

export function assertQaFailuresHaveComments(
  answers: Array<{ itemKey: string; result: QaItemResult; comment: string | null }>,
): void {
  const silent = answers.filter(
    (answer) => answer.result === "fail" && !answer.comment?.trim(),
  );
  if (silent.length === 0) return;

  throw new ReportingError(
    "validation_failed",
    `A failed item needs a comment saying what is wrong: ${silent.map((answer) => answer.itemKey).join(", ")}. A failure with no comment tells the author nothing.`,
  );
}

export function assertNotReviewingOwnReport(
  report: Pick<Report, "author">,
  reviewerId: string,
): void {
  if (report.author !== reviewerId) return;

  throw new ReportingError(
    "self_approval_forbidden",
    "You wrote this report, so you cannot be its QA reviewer.",
  );
}

/* ------------------------------------------------------------ delivery */

export function assertDeliverable(
  report: Pick<Report, "status" | "reportId">,
  version: Pick<ReportVersion, "versionLabel" | "isApproved">,
): void {
  if (!version.isApproved) {
    throw new ReportingError(
      "conflict",
      `${version.versionLabel} has not been approved, so it cannot go to a client.`,
    );
  }
  if (report.status !== "final" && report.status !== "delivered") {
    throw new ReportingError(
      "illegal_transition",
      `${report.reportId} is at ${report.status.replace(/_/g, " ")}. A report goes to a client once it is final.`,
    );
  }
}

/* ------------------------------------------------- closure (PRD 5.9) */

export interface ClosureRequirementState {
  objectivesOutcome: string | null;
  evidenceDisposition: string | null;
  financialStatus: string | null;
  retentionClass: string | null;
  lessonsRecorded: boolean;
  outstandingIssuesDocumented: boolean;
  /** Computed, never attested. */
  openTaskCount: number;
  reportApproved: boolean;
  deliveryRecorded: boolean;
  /** Evidence still out on release, which has to be accounted for. */
  evidenceOnRelease: number;
}

export interface ClosureGateItem {
  key: string;
  label: string;
  met: boolean;
  /** What to do about it, which is the only useful half of "not met". */
  remedy: string;
  /** True when the platform computes this rather than taking somebody's word. */
  computed: boolean;
}

/**
 * PRD 5.9's nine requirements, as a gate.
 *
 * The distinction that matters is `computed`: three of these are read from
 * the records themselves, so nobody can tick "report approved" when there is
 * no approved report. A checklist that let them would be worse than none,
 * because it would look like assurance.
 */
export function closureGate(state: ClosureRequirementState): {
  items: ClosureGateItem[];
  ready: boolean;
  blocking: ClosureGateItem[];
} {
  const items: ClosureGateItem[] = [
    {
      key: "objectives",
      label: "Objectives addressed",
      met: Boolean(state.objectivesOutcome?.trim()),
      remedy: "Record against each objective whether it was met, and how.",
      computed: false,
    },
    {
      key: "tasks",
      label: "Tasks completed",
      met: state.openTaskCount === 0,
      remedy:
        state.openTaskCount === 1
          ? "1 task is still open. Complete or cancel it."
          : `${state.openTaskCount} tasks are still open. Complete or cancel them.`,
      computed: true,
    },
    {
      key: "evidence",
      label: "Evidence accounted for",
      met:
        Boolean(state.evidenceDisposition?.trim()) && state.evidenceOnRelease === 0,
      remedy:
        state.evidenceOnRelease > 0
          ? `${state.evidenceOnRelease} ${state.evidenceOnRelease === 1 ? "item is" : "items are"} still out on release. Record their return in the custody ledger first.`
          : "Say where every item is now, and what will happen to it.",
      computed: state.evidenceOnRelease > 0,
    },
    {
      key: "report",
      label: "Report approved",
      met: state.reportApproved,
      remedy:
        "No report on this case has an approved version. Take one through PRD 10.1's workflow first.",
      computed: true,
    },
    {
      key: "delivery",
      label: "Client delivery recorded",
      met: state.deliveryRecorded,
      remedy: "Record who the report went to, how, and when they acknowledged it.",
      computed: true,
    },
    {
      key: "outstanding",
      label: "Outstanding issues documented",
      met: state.outstandingIssuesDocumented,
      remedy:
        'Say what is left unresolved, or say explicitly that nothing is. "Nothing outstanding" is an answer; silence is not.',
      computed: false,
    },
    {
      key: "financial",
      label: "Financial status recorded",
      met: Boolean(state.financialStatus?.trim()),
      remedy: "Say what was billed, what was written off, and what is outstanding.",
      computed: false,
    },
    {
      key: "lessons",
      label: "Lessons learned recorded",
      met: state.lessonsRecorded,
      remedy:
        "Answer at least one of what worked, what did not, or what you would recommend. This is what the next case gets from this one.",
      computed: false,
    },
    {
      key: "retention",
      label: "Retention class selected",
      met: Boolean(state.retentionClass),
      remedy: "Choose how long this case file is kept, and under what rule.",
      computed: false,
    },
  ];

  const blocking = items.filter((item) => !item.met);
  return { items, ready: blocking.length === 0, blocking };
}

export function assertClosureReady(state: ClosureRequirementState): void {
  const gate = closureGate(state);
  if (gate.ready) return;

  throw new ReportingError(
    "closure_blocked",
    `${gate.blocking.length} ${gate.blocking.length === 1 ? "requirement is" : "requirements are"} not met: ${gate.blocking.map((item) => item.label).join(", ")}. PRD 5.9 blocks closure until every one is.`,
    { blocking: gate.blocking.map((item) => item.key) },
  );
}

/** PRD 5.9: the Supervisor approves closure, and never its proposer. */
export function assertNotApprovingOwnClosure(
  closure: { proposedBy: string },
  approverId: string,
): void {
  if (closure.proposedBy !== approverId) return;

  throw new ReportingError(
    "self_approval_forbidden",
    "You proposed this closure, so you cannot approve it. PRD 5.9 gives that to a supervisor other than you.",
  );
}

export function assertClosureReturnHasNotes(
  status: string,
  notes: string | null | undefined,
): void {
  if (status !== "returned") return;
  if (notes && notes.trim().length >= 10) return;

  throw new ReportingError(
    "validation_failed",
    "Say what still needs doing, in at least ten characters. A closure returned with no note is one nobody can act on.",
  );
}

/**
 * Whether the lessons-learned half has anything in it.
 *
 * Offered to the training base means somebody will read it, so one of the
 * three substantive questions has to be answered. The rest are optional
 * because not every case teaches something about every heading.
 */
export function lessonsRecorded(lessons: {
  whatWorked?: string | null;
  whatDidNotWork?: string | null;
  recommendations?: string | null;
  methodologicalLessons?: string | null;
}): boolean {
  return Boolean(
    lessons.whatWorked?.trim() ||
      lessons.whatDidNotWork?.trim() ||
      lessons.recommendations?.trim() ||
      lessons.methodologicalLessons?.trim(),
  );
}

/* ------------------------------------------------------------- archive */

/**
 * Whether a case is archived, and therefore read-only (screen 21).
 *
 * Archived is not a separate store: it is a closed case whose closure has
 * been approved. Keeping it that way means an archived case is searchable and
 * openable with the same code as any other, which is what PRD screen 21 asks
 * for.
 */
export function isArchived(caseRecord: {
  stageIsTerminal: boolean;
  closureStatus: string | null;
}): boolean {
  return caseRecord.stageIsTerminal && caseRecord.closureStatus === "approved";
}

export function assertNotArchived(
  caseRecord: { caseId: string; stageIsTerminal: boolean; closureStatus: string | null },
  what: string,
): void {
  if (!isArchived(caseRecord)) return;

  throw new ReportingError(
    "conflict",
    `${caseRecord.caseId} is archived, so ${what} cannot change. Reopening it is a deliberate act with a reason, which keeps the archive worth something.`,
  );
}

/* ------------------------------------------------- QA, read for a screen */

/** How a part-finished review reads on screen. */
export function qaProgress(
  review: Pick<QaReview, "items" | "result">,
  checklist: Array<{ key: string }>,
): {
  answered: number;
  total: number;
  failed: number;
  wouldBe: "approved" | "returned";
} {
  const failed = review.items.filter((item) => item.result === "fail").length;
  return {
    answered: review.items.length,
    total: checklist.length,
    failed,
    wouldBe: failed > 0 ? "returned" : "approved",
  };
}

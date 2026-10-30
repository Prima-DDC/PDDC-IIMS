"use server";

import {
  EMPTY_FORM_STATE,
  invalidForm,
  unexpectedFailure,
  type FormState,
} from "@/lib/forms";
import { refreshPath } from "@/lib/revalidate";
import { asActor, requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import {
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
  isReportingError,
  lessonsRecorded,
  nextReportVersionLabel,
  qaResultFromItems,
  reporting,
} from "@/modules/reporting";
import { casework } from "@/modules/casework";
import { isIamError } from "@/modules/iam";
import { notifyReportMoved } from "@/features/notifications/producers";
import {
  acknowledgeDeliverySchema,
  addSectionSchema,
  addVersionSchema,
  answerQaSchema,
  citeSchema,
  completeQaSchema,
  createReportSchema,
  decideClosureSchema,
  moveSectionSchema,
  openQaSchema,
  proposeClosureSchema,
  recordDeliverySchema,
  removeSectionSchema,
  reportReasonSchema,
  reportStatusSchema,
  unciteSchema,
  updateReportSchema,
  updateSectionSchema,
  updateVersionSchema,
} from "./schema";

/**
 * Report, QA, delivery and closure actions (PRD 5.9, 10).
 *
 * Thin, as the convention requires: parse, check the rule, call the use case,
 * declare what is now stale. The rules are in `@/modules/reporting`, which is
 * what lets them be tested without a database.
 *
 * Three of them are worth naming because they are what the module is for. A
 * report cannot skip a stage of PRD 10.1's line. Nobody passes on their own
 * report, at any stage, not merely at the final approval. And closure is
 * blocked until all nine of PRD 5.9's requirements are met, three of which
 * are read from the records rather than attested to.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isReportingError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("reporting action failed", error);
    return unexpectedFailure(error, "saving that");
  }
}

function staleReport(caseRecordId: string, reportRecordId?: string) {
  refreshPath("/reports");
  refreshPath(`/cases/${caseRecordId}`);
  if (reportRecordId) refreshPath(`/reports/${reportRecordId}`);
}

function staleCase(caseRecordId: string) {
  refreshPath("/cases");
  refreshPath(`/cases/${caseRecordId}`);
  refreshPath("/archive");
}

/* -------------------------------------------------------------- reports */

export async function createReport(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "create");

    const parsed = createReportSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "reports", "create", parsed.data.classification);

    const { caseRecordId, ...input } = parsed.data;
    const created = await reporting(actor).reports.create({
      caseId: caseRecordId,
      ...input,
    });

    staleReport(caseRecordId, created.id);
    return {
      ...EMPTY_FORM_STATE,
      success: `${created.reportId} started as ${created.current?.versionLabel}. Write the sections, cite what each one rests on, then put it forward.`,
    };
  });
}

export async function updateReport(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "edit");

    const parsed = updateReportSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "reports", "edit", parsed.data.classification);

    const { reportRecordId, caseRecordId, expectedVersion, ...input } = parsed.data;
    await reporting(actor).reports.update(reportRecordId, input, expectedVersion);

    staleReport(caseRecordId, reportRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

/**
 * One stage along PRD 10.1's line.
 *
 * The three rules together are the workflow: the move has to be legal, the
 * version has to be worth reading, and whoever wrote it cannot be the one who
 * passes it on.
 */
export async function setReportStatus(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();

    const parsed = reportStatusSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { reportRecordId, caseRecordId, status, notes } = parsed.data;

    // Moving it on is an author's act until the final approval, which is a
    // reviewer's. Both are checked; which one depends on the move.
    const approving = status === "final";
    await requirePermission(actor, "reports", approving ? "approve" : "edit");

    const api = reporting(actor);
    const report = await api.reports.findById(reportRecordId);
    if (!report) {
      return { ...EMPTY_FORM_STATE, error: "That report no longer exists." };
    }

    assertReportTransition(report.status, status);

    const forward =
      status !== "draft" && status !== "withdrawn" && report.status !== "draft";
    const decision =
      status === "draft"
        ? "returned"
        : status === "withdrawn"
          ? "withdrawn"
          : status === "delivered"
            ? "delivered"
            : approving
              ? "approved"
              : "submitted";

    if (status === "investigator_review" || status === "withdrawn") {
      // Putting it forward the first time, or taking it off the table: both
      // are the author's to do.
    } else if (forward || status === "draft") {
      // Anything else is somebody reading it and deciding, so it cannot be
      // the person who wrote it (PRD 10.1).
      if (report.current) {
        assertNotDecidingOwnReport(report, report.current, actor.userId);
      }
    }

    if (status === "investigator_review" && report.current) {
      const sections = await api.reports.sections(report.current.id);
      assertVersionHasContent({
        sectionCount: sections.length,
        executiveSummary: report.current.executiveSummary,
        conclusion: report.current.conclusion,
      });
      // PRD 10.2: every statement cites what it rests on. Caught here rather
      // than by a QA reviewer, with the sections named.
      assertSectionsCiteTheirSupport(sections);
    }

    // The audience for a review is the case team: whoever reviews next is
    // among them, and PRD 10.1 does not name a reviewer in advance. Read
    // before the write opens, so the transaction carries nothing but the
    // change and the notifications about it.
    const audience =
      status === "draft"
        ? []
        : (await casework(actor).cases.assignments(caseRecordId))
            .filter((a) => a.unassignedAt === null)
            .map((a) => a.userId);

    const after = await asActor(actor, async (tx) => {
      const moved = await reporting(actor, tx).reports.transition({
        id: reportRecordId,
        to: status,
        decision,
        notes,
        approveVersion: approving,
      });

      await notifyReportMoved(actor, tx, {
        report: {
          id: moved.id,
          reportId: moved.reportId,
          caseId: moved.caseId,
          caseReference: moved.caseReference,
        },
        status,
        authorId: moved.author,
        audience,
      });

      return moved;
    });

    staleReport(caseRecordId, reportRecordId);

    const messages: Record<string, string> = {
      investigator_review: `${after.reportId} is with an investigator to read.`,
      supervisor_review: `${after.reportId} is with a supervisor.`,
      qa_review: `${after.reportId} is with QA. They work through the twelve checks in PRD 10.3.`,
      approval: `${after.reportId} is awaiting approval.`,
      final: `${after.reportId} is final, and ${after.current?.versionLabel} is locked. It can now go to the client.`,
      delivered: `${after.reportId} is recorded as delivered.`,
      draft: `${after.reportId} is back with its author, with your note.`,
      withdrawn: `${after.reportId} withdrawn. It stays on the case with its history.`,
    };

    return { ...EMPTY_FORM_STATE, success: messages[status] };
  });
}

export async function removeReport(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "delete");

    const parsed = reportReasonSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await reporting(actor).reports.softDelete(
      parsed.data.reportRecordId,
      parsed.data.reason,
    );

    staleReport(parsed.data.caseRecordId, parsed.data.reportRecordId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Removed to the recycle bin." };
  });
}

export async function restoreReport(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "delete");

    const parsed = reportReasonSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await reporting(actor).reports.restore(
      parsed.data.reportRecordId,
      parsed.data.reason,
    );

    staleReport(parsed.data.caseRecordId, parsed.data.reportRecordId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Report restored." };
  });
}

/* ------------------------------------------------------------- versions */

export async function updateVersion(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "edit");

    const parsed = updateVersionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { reportRecordId, caseRecordId, versionId, expectedVersion, ...input } =
      parsed.data;

    const api = reporting(actor);
    const version = await api.reports.findVersion(versionId);
    if (!version) {
      return { ...EMPTY_FORM_STATE, error: "That version no longer exists." };
    }
    assertVersionEditable(version);

    await api.reports.updateVersion(versionId, input, expectedVersion);

    staleReport(caseRecordId, reportRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

export async function addVersion(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "edit");

    const parsed = addVersionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { reportRecordId, caseRecordId, intent, changeNote } = parsed.data;

    const api = reporting(actor);
    const report = await api.reports.findById(reportRecordId);
    if (!report) {
      return { ...EMPTY_FORM_STATE, error: "That report no longer exists." };
    }

    assertVersionChangeNote(report.current, changeNote);

    const version = await api.reports.addVersion({
      reportId: reportRecordId,
      versionLabel: nextReportVersionLabel(report.current, intent),
      changeNote,
      // Carried forward, so correcting a date in a thirty-page report is not
      // thirty pages of retyping.
      copyFromVersionId: report.currentVersionId,
    });

    staleReport(caseRecordId, reportRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${version.versionLabel} is now the working version, with everything from ${report.current?.versionLabel ?? "the previous one"} carried forward. The version it replaced is untouched.`,
    };
  });
}

/* ------------------------------------------------------------- sections */

export async function addSection(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "edit");

    const parsed = addSectionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { reportRecordId, caseRecordId, versionId, ...input } = parsed.data;
    const created = await reporting(actor).reports.addSection({
      versionId,
      ...input,
    });

    staleReport(caseRecordId, reportRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `"${created.heading}" added as section ${created.position}.`,
    };
  });
}

export async function updateSection(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "edit");

    const parsed = updateSectionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { reportRecordId, caseRecordId, sectionId, expectedVersion, ...input } =
      parsed.data;
    await reporting(actor).reports.updateSection(sectionId, input, expectedVersion);

    staleReport(caseRecordId, reportRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

export async function moveSection(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "edit");

    const parsed = moveSectionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await reporting(actor).reports.moveSection(
      parsed.data.sectionId,
      parsed.data.direction,
    );

    staleReport(parsed.data.caseRecordId, parsed.data.reportRecordId);
    return { ...EMPTY_FORM_STATE, success: "Moved." };
  });
}

export async function removeSection(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "edit");

    const parsed = removeSectionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await reporting(actor).reports.removeSection(parsed.data.sectionId);

    staleReport(parsed.data.caseRecordId, parsed.data.reportRecordId);
    return { ...EMPTY_FORM_STATE, success: "Section removed." };
  });
}

export async function cite(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "edit");

    const parsed = citeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { reportRecordId, caseRecordId, sectionId, ...input } = parsed.data;
    await reporting(actor).reports.cite({ sectionId, ...input });

    staleReport(caseRecordId, reportRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: "Cited. A reader of the report can now follow it back.",
    };
  });
}

export async function uncite(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "edit");

    const parsed = unciteSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await reporting(actor).reports.uncite(parsed.data.citationId);

    staleReport(parsed.data.caseRecordId, parsed.data.reportRecordId);
    return { ...EMPTY_FORM_STATE, success: "Citation removed." };
  });
}

/* ------------------------------------------------------------------- QA */

export async function openQaReview(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "qa", "create");

    const parsed = openQaSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = reporting(actor);
    const report = await api.reports.findById(parsed.data.reportRecordId);
    if (!report) {
      return { ...EMPTY_FORM_STATE, error: "That report no longer exists." };
    }
    assertNotReviewingOwnReport(report, actor.userId);

    await api.qa.open({
      reportId: parsed.data.reportRecordId,
      versionId: parsed.data.versionId,
    });

    staleReport(parsed.data.caseRecordId, parsed.data.reportRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success:
        "Review opened. Work through the twelve checks; a failure needs a comment saying what is wrong.",
    };
  });
}

export async function answerQaItem(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "qa", "edit");

    const parsed = answerQaSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { reportRecordId, caseRecordId, reviewId, ...input } = parsed.data;

    assertQaFailuresHaveComments([input]);

    await reporting(actor).qa.answer({ reviewId, ...input });

    staleReport(caseRecordId, reportRecordId);
    return { ...EMPTY_FORM_STATE, success: "Recorded." };
  });
}

/**
 * Completing a QA review (PRD 10.3).
 *
 * The result is derived from the items, never from what was clicked: a review
 * with a failed item is a return. That is the only thing a checklist is for,
 * and it is enforced here, in the domain and by the database.
 */
export async function completeQaReview(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "qa", "edit");

    const parsed = completeQaSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { reportRecordId, caseRecordId, reviewId, summary } = parsed.data;

    const api = reporting(actor);
    const [review, checklist] = await Promise.all([
      api.qa.findReview(reviewId),
      api.qa.checklist(),
    ]);
    if (!review) {
      return { ...EMPTY_FORM_STATE, error: "That review no longer exists." };
    }

    assertQaReviewComplete(checklist, review.items);
    assertQaFailuresHaveComments(review.items);

    const result = qaResultFromItems(review.items);
    const completed = await api.qa.complete({ reviewId, result, summary });

    // A returned review sends the report back to its author in the same
    // breath: a QA result that left the report sitting in QA would be a
    // decision nobody acted on.
    const report = await api.reports.findById(reportRecordId);
    if (report && report.status === "qa_review") {
      await api.reports.transition({
        id: reportRecordId,
        to: result === "returned" ? "draft" : "approval",
        decision: result === "returned" ? "returned" : "submitted",
        notes: summary ?? null,
      });
    }

    staleReport(caseRecordId, reportRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success:
        completed.result === "returned"
          ? `Returned for correction. ${review.items.filter((item) => item.result === "fail").length} of the twelve checks failed, and the report is back with its author.`
          : "Passed every check. The report has moved on for approval.",
    };
  });
}

/* -------------------------------------------------------------- delivery */

export async function recordDelivery(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "share");

    const parsed = recordDeliverySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { reportRecordId, caseRecordId, versionId, ...input } = parsed.data;

    const api = reporting(actor);
    const [report, version] = await Promise.all([
      api.reports.findById(reportRecordId),
      api.reports.findVersion(versionId),
    ]);
    if (!report || !version) {
      return { ...EMPTY_FORM_STATE, error: "That report no longer exists." };
    }

    assertDeliverable(report, version);

    const delivery = await api.deliveries.record({
      reportId: reportRecordId,
      versionId,
      ...input,
    });

    // Delivery is the last stage of PRD 10.1's line, so the report moves with
    // it rather than waiting for somebody to remember.
    if (report.status === "final") {
      await api.reports.transition({
        id: reportRecordId,
        to: "delivered",
        decision: "delivered",
        notes: `Delivered to ${input.deliveredTo}`,
      });
    }

    staleReport(caseRecordId, reportRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${delivery.versionLabel} recorded as delivered to ${delivery.deliveredTo}. Record their acknowledgement when it comes.`,
    };
  });
}

export async function acknowledgeDelivery(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "reports", "share");

    const parsed = acknowledgeDeliverySchema.safeParse(
      Object.fromEntries(formData),
    );
    if (!parsed.success) return invalidForm(parsed.error);

    const { reportRecordId, caseRecordId, ...input } = parsed.data;
    await reporting(actor).deliveries.acknowledge(input);

    staleReport(caseRecordId, reportRecordId);
    return { ...EMPTY_FORM_STATE, success: "Acknowledgement recorded." };
  });
}

/* --------------------------------------------------------------- closure */

/**
 * Proposing a closure (PRD 5.9).
 *
 * The gate is checked here rather than at the decision, so the person filling
 * the form is told what is missing while they can still do something about
 * it. Three of the nine requirements are computed, which is why this reads
 * the records rather than trusting the form.
 */
export async function proposeClosure(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "close");

    const parsed = proposeClosureSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, ...input } = parsed.data;
    const api = reporting(actor);
    const state = await api.closure.gateState(caseRecordId);

    assertClosureReady({
      objectivesOutcome: input.objectivesOutcome,
      evidenceDisposition: input.evidenceDisposition,
      financialStatus: input.financialStatus,
      retentionClass: input.retentionClass,
      lessonsRecorded: lessonsRecorded(input),
      // "Nothing outstanding" is an answer; silence is not. An empty field is
      // read as unanswered, which is why the form asks for it explicitly.
      outstandingIssuesDocumented: Boolean(input.outstandingIssues?.trim()),
      openTaskCount: state.openTaskCount,
      reportApproved: state.reportApproved,
      deliveryRecorded: state.deliveryRecorded,
      evidenceOnRelease: state.evidenceOnRelease,
    });

    await api.closure.propose({ caseId: caseRecordId, ...input });

    staleCase(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success:
        "Closure proposed. A supervisor other than you has to approve it, which is what closes the case (PRD 5.9).",
    };
  });
}

export async function decideClosure(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "close");

    const parsed = decideClosureSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, status, reviewNotes } = parsed.data;

    const api = reporting(actor);
    const closure = await api.closure.forCase(caseRecordId);
    if (!closure) {
      return {
        ...EMPTY_FORM_STATE,
        error: "No closure has been proposed for this case.",
      };
    }

    assertNotApprovingOwnClosure(closure, actor.userId);
    assertClosureReturnHasNotes(status, reviewNotes);

    const decided = await api.closure.decide({
      caseId: caseRecordId,
      status,
      reviewNotes,
    });

    staleCase(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success:
        decided.status === "approved"
          ? `Closed and archived, kept under ${decided.retentionClassName ?? decided.retentionClass}. The case stays searchable and readable; nothing more can be changed on it.`
          : "Returned to its proposer with your note. The case stays open.",
    };
  });
}

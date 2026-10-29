import "server-only";
import { canAll, requireActor } from "@/lib/auth/session";
import { casework } from "@/modules/casework";
import {
  closureGate,
  lessonsRecorded,
  reporting,
  workflowPosition,
} from "@/modules/reporting";
import { classificationLevels, staffDirectory } from "@/lib/reference";

/** Read models for the report builder, QA, closure and the archive. */

const REPORT_PERMISSIONS = [
  { resource: "reports", action: "create" },
  { resource: "reports", action: "edit" },
  { resource: "reports", action: "approve" },
  { resource: "reports", action: "share" },
  { resource: "reports", action: "delete" },
  { resource: "reports", action: "export" },
  { resource: "qa", action: "create" },
  { resource: "qa", action: "edit" },
] as const;

function reportAbilities(allowed: Record<string, boolean>) {
  return {
    create: allowed["reports:create"],
    edit: allowed["reports:edit"],
    approve: allowed["reports:approve"],
    deliver: allowed["reports:share"],
    remove: allowed["reports:delete"],
    export: allowed["reports:export"],
    qa: allowed["qa:create"] || allowed["qa:edit"],
  };
}

export async function listReports(params: {
  caseId?: string;
  search?: string;
  status?: string;
  awaitingReview?: boolean;
  onlyDeleted?: boolean;
  page?: number;
  perPage?: number;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const api = reporting(actor);
  const [result, summary, allowed] = await Promise.all([
    api.reports.list({
      caseId: params.caseId,
      search: params.search,
      status: params.status as never,
      awaitingReview: params.awaitingReview,
      onlyDeleted: params.onlyDeleted,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    api.reports.summary({ caseId: params.caseId }),
    canAll(actor, [...REPORT_PERMISSIONS]),
  ]);

  return {
    ...result,
    summary,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    can: reportAbilities(allowed),
  };
}

/**
 * One report, with everything the builder needs.
 *
 * `citable` is the part worth noting: it returns only what the database will
 * accept as a citation, so a picker never offers a draft finding or an
 * exhibit that failed its integrity check. A refusal that arrives after the
 * author has written the paragraph is a refusal that arrives too late.
 */
export async function getReportDetail(reportRecordId: string) {
  const actor = await requireActor();
  const api = reporting(actor);

  const report = await api.reports.findById(reportRecordId);
  if (!report) return null;

  const [
    versions,
    sections,
    history,
    reviews,
    deliveries,
    citable,
    checklist,
    allowed,
    directory,
    levels,
  ] = await Promise.all([
    api.reports.versions(reportRecordId),
    report.currentVersionId
      ? api.reports.sections(report.currentVersionId)
      : Promise.resolve([]),
    api.reports.history(reportRecordId),
    api.qa.reviews(reportRecordId),
    api.deliveries.forReport(reportRecordId),
    api.reports.citable(report.caseId),
    api.qa.checklist(),
    canAll(actor, [...REPORT_PERMISSIONS]),
    staffDirectory(actor),
    classificationLevels(actor),
  ]);

  const can = reportAbilities(allowed);

  return {
    report,
    versions,
    sections,
    history,
    reviews,
    deliveries,
    citable,
    checklist,
    levels,
    people: directory,
    actorId: actor.userId,
    position: workflowPosition(report.status),
    /** True when this actor wrote it, so the screen says why they cannot decide. */
    isOwnReport:
      report.author === actor.userId ||
      report.current?.createdBy === actor.userId,
    /** The open review this actor could continue, if any. */
    openReview:
      reviews.find(
        (review) =>
          review.completedAt === null && review.reviewer === actor.userId,
      ) ?? null,
    can,
  };
}

/** The case file's reports tab. */
export async function getCaseReports(caseRecordId: string) {
  const actor = await requireActor();
  const api = reporting(actor);

  const [reports, summary, allowed, directory, levels] = await Promise.all([
    api.reports.list({ caseId: caseRecordId, limit: 100 }),
    api.reports.summary({ caseId: caseRecordId }),
    canAll(actor, [...REPORT_PERMISSIONS]),
    staffDirectory(actor),
    classificationLevels(actor),
  ]);

  return {
    reports: reports.rows,
    summary,
    levels,
    people: directory,
    actorId: actor.userId,
    can: reportAbilities(allowed),
  };
}

/* --------------------------------------------------------------- closure */

/**
 * The closure screen (PRD 5.9, screen 20).
 *
 * The gate is computed here so the screen can show every requirement and say
 * what to do about each one it has not met, rather than refusing the form at
 * the end. Three of the nine are marked `computed`, which means the platform
 * answered them from the records: nobody can tick "report approved" when
 * there is no approved report.
 */
export async function getCaseClosure(caseRecordId: string) {
  const actor = await requireActor();
  const api = reporting(actor);

  const [closure, state, retentionClasses, allowed] = await Promise.all([
    api.closure.forCase(caseRecordId),
    api.closure.gateState(caseRecordId),
    api.closure.retentionClasses(),
    canAll(actor, [
      { resource: "cases", action: "close" },
      { resource: "cases", action: "edit" },
    ]),
  ]);

  const gate = closureGate({
    objectivesOutcome: closure?.objectivesOutcome ?? null,
    evidenceDisposition: closure?.evidenceDisposition ?? null,
    financialStatus: closure?.financialStatus ?? null,
    retentionClass: closure?.retentionClass ?? null,
    lessonsRecorded: closure ? lessonsRecorded(closure) : false,
    outstandingIssuesDocumented: Boolean(closure?.outstandingIssues?.trim()),
    openTaskCount: state.openTaskCount,
    reportApproved: state.reportApproved,
    deliveryRecorded: state.deliveryRecorded,
    evidenceOnRelease: state.evidenceOnRelease,
  });

  return {
    closure,
    gate,
    state,
    retentionClasses,
    actorId: actor.userId,
    /** True when this actor proposed it, so they cannot approve it. */
    isOwnProposal: closure?.proposedBy === actor.userId,
    can: {
      close: allowed["cases:close"],
      edit: allowed["cases:edit"],
    },
  };
}

/* --------------------------------------------------------------- archive */

/**
 * The archive (screen 21).
 *
 * Closed cases whose closure was approved, read-only. Not a separate store:
 * the same records, which is what keeps an archived case searchable and
 * openable with the same code as any other.
 */
export async function listArchive(params: {
  search?: string;
  page?: number;
  perPage?: number;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const result = await casework(actor).cases.list({
    search: params.search,
    openness: "closed",
    limit: perPage,
    offset: (page - 1) * perPage,
  });

  return {
    ...result,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
  };
}

/* ---------------------------------------------- management (PRD 10.4) */

export async function getManagementReport(params: {
  since?: string;
  office?: string;
}) {
  const actor = await requireActor();
  return reporting(actor).management.report({
    since: params.since,
    office: params.office,
  });
}

/** The counts the case file's tab bar shows for this module. */
export async function getReportingTabCounts(caseRecordId: string) {
  const actor = await requireActor();
  const api = reporting(actor);

  const [reports, closure] = await Promise.all([
    api.reports.summary({ caseId: caseRecordId }),
    api.closure.forCase(caseRecordId),
  ]);

  return {
    reports: reports.total,
    reportsInReview: reports.inReview,
    reportsDelivered: reports.delivered,
    closureStatus: closure?.status ?? null,
  };
}

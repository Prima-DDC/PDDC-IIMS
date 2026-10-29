/**
 * The client-safe half of the reporting module.
 *
 * Types, vocabularies and pure rules only: no "server-only" marker and no
 * database client, so a client component can import this without pulling
 * postgres into the browser bundle.
 *
 * Client components import from "@/modules/reporting/shared"; server code
 * imports from "@/modules/reporting", which re-exports everything here.
 */

export {
  CITATION_TYPES,
  CITATION_TYPE_LABELS,
  CLOSURE_STATUSES,
  CLOSURE_STATUS_LABELS,
  DELIVERY_METHODS,
  DELIVERY_METHOD_LABELS,
  QA_RESULTS,
  QA_RESULT_LABELS,
  REPORT_STATUSES,
  REPORT_STATUS_LABELS,
  REPORT_TYPES,
  REPORT_TYPE_LABELS,
  REPORT_WORKFLOW,
  SECTION_TYPES,
  SECTION_TYPE_LABELS,
  VERSION_STATUSES,
  type CaseClosure,
  type CitationType,
  type ClosureStatus,
  type Delivery,
  type DeliveryMethod,
  type ManagementReport,
  type QaChecklistItem,
  type QaItemResult,
  type QaReview,
  type QaReviewItem,
  type Report,
  type ReportSection,
  type ReportStatus,
  type ReportTransition,
  type ReportType,
  type ReportVersion,
  type RetentionClass,
  type SectionCitation,
  type SectionType,
  type VersionStatus,
} from "./domain/types";

export {
  REPORTING_ERROR_STATUS,
  ReportingError,
  isReportingError,
  type ReportingErrorCode,
} from "./domain/errors";

export {
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
  type ClosureGateItem,
  type ClosureRequirementState,
} from "./domain/policies";

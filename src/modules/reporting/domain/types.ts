import type { ClassificationLevel } from "@/modules/iam/shared";

/**
 * Reports, QA review, delivery and closure (PRD 5.9, 10, screens 18 to 21).
 *
 * The end of the chain. PRD 10.1's workflow is a seven-stage line and it is
 * modelled as one here rather than as a free status, because the point of a
 * workflow is the stages it will not let you skip.
 */

export const REPORT_STATUSES = [
  "draft",
  "investigator_review",
  "supervisor_review",
  "qa_review",
  "approval",
  "final",
  "delivered",
  "withdrawn",
] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  draft: "Draft",
  investigator_review: "Investigator review",
  supervisor_review: "Supervisor review",
  qa_review: "QA review",
  approval: "Awaiting approval",
  final: "Final",
  delivered: "Delivered to the client",
  withdrawn: "Withdrawn",
};

/** The same line, as a reader of a progress rail sees it. */
export const REPORT_WORKFLOW: readonly ReportStatus[] = [
  "draft",
  "investigator_review",
  "supervisor_review",
  "qa_review",
  "approval",
  "final",
  "delivered",
];

export const VERSION_STATUSES = [
  "draft",
  "investigator_review",
  "supervisor_review",
  "qa_review",
  "approval",
  "final",
  "superseded",
  "returned",
] as const;

export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const REPORT_TYPES = [
  "investigation_report",
  "interim_report",
  "due_diligence_report",
  "intelligence_brief",
  "memorandum",
  "closure_summary",
  "other",
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  investigation_report: "Investigation report",
  interim_report: "Interim report",
  due_diligence_report: "Due diligence report",
  intelligence_brief: "Intelligence brief",
  memorandum: "Memorandum",
  closure_summary: "Closure summary",
  other: "Other",
};

export const SECTION_TYPES = [
  "narrative",
  "background",
  "methodology",
  "finding",
  "analysis",
  "exhibit_schedule",
  "conclusion",
  "recommendation",
  "appendix",
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];

export const SECTION_TYPE_LABELS: Record<SectionType, string> = {
  narrative: "Narrative",
  background: "Background",
  methodology: "Methodology",
  finding: "Finding",
  analysis: "Analysis",
  exhibit_schedule: "Schedule of exhibits",
  conclusion: "Conclusion",
  recommendation: "Recommendation",
  appendix: "Appendix",
};

export const CITATION_TYPES = [
  "finding",
  "evidence",
  "document",
  "information",
] as const;

export type CitationType = (typeof CITATION_TYPES)[number];

export const CITATION_TYPE_LABELS: Record<CitationType, string> = {
  finding: "Finding",
  evidence: "Exhibit",
  document: "Document",
  information: "Information",
};

export const DELIVERY_METHODS = [
  "secure_link",
  "encrypted_email",
  "hand_delivery",
  "courier",
  "client_portal",
  "in_person_briefing",
  "other",
] as const;

export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const DELIVERY_METHOD_LABELS: Record<DeliveryMethod, string> = {
  secure_link: "Secure link",
  encrypted_email: "Encrypted email",
  hand_delivery: "Hand delivery",
  courier: "Courier",
  client_portal: "Client portal",
  in_person_briefing: "In-person briefing",
  other: "Other",
};

export const QA_RESULTS = ["pass", "fail", "not_applicable"] as const;

export type QaItemResult = (typeof QA_RESULTS)[number];

export const QA_RESULT_LABELS: Record<QaItemResult, string> = {
  pass: "Pass",
  fail: "Fail",
  not_applicable: "Not applicable",
};

export const CLOSURE_STATUSES = ["proposed", "approved", "returned"] as const;

export type ClosureStatus = (typeof CLOSURE_STATUSES)[number];

export const CLOSURE_STATUS_LABELS: Record<ClosureStatus, string> = {
  proposed: "Awaiting a supervisor",
  approved: "Approved",
  returned: "Returned for more work",
};

/* --------------------------------------------------------------- records */

export interface Report {
  id: string;
  reportId: string;
  caseId: string;
  caseReference: string;
  caseTitle: string;
  clientName: string;
  title: string;
  reportType: ReportType;
  status: ReportStatus;
  author: string;
  authorName: string | null;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  classification: ClassificationLevel;
  current: ReportVersion | null;
  versionCount: number;
  deliveryCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
}

export interface ReportVersion {
  id: string;
  reportId: string;
  versionNo: number;
  versionLabel: string;
  status: VersionStatus;
  executiveSummary: string | null;
  scopeStatement: string | null;
  methodology: string | null;
  limitations: string | null;
  conclusion: string | null;
  changeNote: string | null;
  isCurrent: boolean;
  isApproved: boolean;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  updatedAt: string;
  version: number;
  sectionCount: number;
}

export interface ReportSection {
  id: string;
  versionId: string;
  position: number;
  heading: string;
  body: string | null;
  sectionType: SectionType;
  citations: SectionCitation[];
  version: number;
}

export interface SectionCitation {
  id: string;
  sectionId: string;
  citationType: CitationType;
  findingId: string | null;
  evidenceItemId: string | null;
  documentId: string | null;
  informationId: string | null;
  /** The human identifier of whatever this cites. */
  targetReference: string;
  targetLabel: string;
  note: string | null;
  href: string;
}

export interface ReportTransition {
  id: string;
  reportId: string;
  versionId: string | null;
  versionLabel: string | null;
  fromStatus: string;
  toStatus: string;
  decision: "submitted" | "approved" | "returned" | "withdrawn" | "delivered";
  notes: string | null;
  decidedBy: string;
  decidedByName: string | null;
  decidedAt: string;
}

export interface QaChecklistItem {
  key: string;
  label: string;
  guidance: string | null;
  position: number;
}

export interface QaReview {
  id: string;
  reportId: string;
  versionId: string;
  versionLabel: string;
  reviewer: string;
  reviewerName: string | null;
  result: "approved" | "returned" | null;
  summary: string | null;
  startedAt: string;
  completedAt: string | null;
  items: QaReviewItem[];
  version: number;
}

export interface QaReviewItem {
  id: string;
  reviewId: string;
  itemKey: string;
  label: string;
  guidance: string | null;
  position: number;
  result: QaItemResult;
  comment: string | null;
}

export interface Delivery {
  id: string;
  reportId: string;
  versionId: string;
  versionLabel: string;
  deliveredTo: string;
  deliveryMethod: DeliveryMethod;
  deliveredAt: string;
  deliveredBy: string;
  deliveredByName: string | null;
  acknowledgement: string | null;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  notes: string | null;
  version: number;
}

export interface RetentionClass {
  code: string;
  name: string;
  years: number;
  description: string | null;
}

export interface CaseClosure {
  id: string;
  caseId: string;
  caseReference: string;
  objectivesOutcome: string;
  evidenceDisposition: string;
  outstandingIssues: string | null;
  financialStatus: string;
  retentionClass: string;
  retentionClassName: string | null;
  whatWorked: string | null;
  whatDidNotWork: string | null;
  challenges: string | null;
  newSources: string | null;
  newTypologies: string | null;
  methodologicalLessons: string | null;
  recommendations: string | null;
  contributeToKnowledgeBase: boolean;
  status: ClosureStatus;
  proposedBy: string;
  proposedByName: string | null;
  proposedAt: string;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  reviewNotes: string | null;
  version: number;
}

/**
 * The management reports PRD 10.4 asks for.
 *
 * One shape, because they are one screen: a set of figures a manager reads
 * together, each exportable. Kept here rather than in the feature layer so
 * the export and the screen cannot disagree about what a figure means.
 */
export interface ManagementReport {
  caseRegister: Array<{
    caseId: string;
    caseReference: string;
    title: string;
    clientName: string;
    stageName: string;
    riskLevel: string;
    openedAt: string;
    closedAt: string | null;
    leadInvestigatorName: string | null;
    daysOpen: number;
  }>;
  turnaround: {
    closedCases: number;
    medianDays: number | null;
    longestDays: number | null;
  };
  workload: Array<{
    userId: string;
    name: string;
    openCases: number;
    openTasks: number;
    overdueTasks: number;
  }>;
  overdueTasks: Array<{
    taskId: string;
    taskReference: string;
    title: string;
    caseReference: string;
    assigneeName: string | null;
    dueAt: string;
    daysOverdue: number;
  }>;
  qaReturnRate: {
    reviewsCompleted: number;
    returned: number;
    /** Null rather than zero when nothing has been reviewed. */
    rate: number | null;
  };
  revenueVersusCost: Array<{
    caseId: string;
    caseReference: string;
    title: string;
    currency: string;
    billed: number;
    cost: number;
    margin: number;
  }>;
}

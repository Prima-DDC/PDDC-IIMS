import type { ClassificationLevel } from "@/modules/iam/shared";
import type {
  CaseClosure,
  CitationType,
  Delivery,
  DeliveryMethod,
  ManagementReport,
  QaChecklistItem,
  QaItemResult,
  QaReview,
  Report,
  ReportSection,
  ReportStatus,
  ReportTransition,
  ReportType,
  ReportVersion,
  RetentionClass,
  SectionType,
} from "../domain/types";

/** Ports for reports, QA, delivery and closure (PRD 5.9, 10). */

export interface Page<T> {
  rows: T[];
  total: number;
}

export interface ListReportsFilter {
  caseId?: string;
  search?: string;
  status?: ReportStatus;
  reportType?: ReportType;
  author?: string;
  /** Reports waiting on this person's decision, for a dashboard queue. */
  awaitingReview?: boolean;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface ReportRepository {
  list(filter: ListReportsFilter): Promise<Page<Report>>;
  findById(id: string): Promise<Report | null>;

  /**
   * Creates the report and its first version together.
   *
   * A report with no version is a title: nothing can be read from it and
   * nothing can be reviewed.
   */
  create(input: {
    caseId: string;
    title: string;
    reportType: ReportType;
    author: string;
    classification: ClassificationLevel;
    executiveSummary?: string | null;
    scopeStatement?: string | null;
    methodology?: string | null;
  }): Promise<Report>;

  update(
    id: string,
    input: {
      title?: string;
      reportType?: ReportType;
      classification?: ClassificationLevel;
    },
    expectedVersion: number,
  ): Promise<Report>;

  /**
   * Moves the report along PRD 10.1's line and records the decision.
   *
   * The transition and its history are written in one transaction, because a
   * stage change nobody can see the reason for is the thing PRD 10.1 is
   * written to prevent.
   */
  transition(input: {
    id: string;
    to: ReportStatus;
    decision: "submitted" | "approved" | "returned" | "withdrawn" | "delivered";
    notes?: string | null;
    /** Set when the move approves the version, so the lock closes with it. */
    approveVersion?: boolean;
  }): Promise<Report>;

  history(id: string): Promise<ReportTransition[]>;

  softDelete(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;

  /* ---------------------------------------------------------- versions */

  versions(reportId: string): Promise<ReportVersion[]>;
  findVersion(versionId: string): Promise<ReportVersion | null>;

  addVersion(input: {
    reportId: string;
    versionLabel: string;
    changeNote?: string | null;
    /** Carried forward from the version it replaces, so nothing is retyped. */
    copyFromVersionId?: string | null;
  }): Promise<ReportVersion>;

  updateVersion(
    versionId: string,
    input: {
      executiveSummary?: string | null;
      scopeStatement?: string | null;
      methodology?: string | null;
      limitations?: string | null;
      conclusion?: string | null;
    },
    expectedVersion: number,
  ): Promise<ReportVersion>;

  /* ---------------------------------------------------------- sections */

  sections(versionId: string): Promise<ReportSection[]>;

  addSection(input: {
    versionId: string;
    heading: string;
    body?: string | null;
    sectionType: SectionType;
  }): Promise<ReportSection>;

  updateSection(
    sectionId: string,
    input: { heading?: string; body?: string | null; sectionType?: SectionType },
    expectedVersion: number,
  ): Promise<ReportSection>;

  /** Moves a section up or down, renumbering what it passes. */
  moveSection(sectionId: string, direction: "up" | "down"): Promise<void>;
  removeSection(sectionId: string): Promise<void>;

  cite(input: {
    sectionId: string;
    citationType: CitationType;
    targetId: string;
    note?: string | null;
  }): Promise<void>;
  uncite(citationId: string): Promise<void>;

  /**
   * What a case has that a report could cite: its accepted findings, its
   * sound exhibits, its approved documents and its information.
   *
   * Only what is citable, because a picker offering a draft finding is a
   * picker offering something the database will refuse.
   */
  citable(caseId: string): Promise<{
    findings: Array<{ id: string; reference: string; label: string }>;
    evidence: Array<{ id: string; reference: string; label: string }>;
    documents: Array<{ id: string; reference: string; label: string }>;
    information: Array<{ id: string; reference: string; label: string }>;
  }>;

  summary(filter: { caseId?: string }): Promise<{
    total: number;
    drafts: number;
    inReview: number;
    final: number;
    delivered: number;
  }>;
}

/* ---------------------------------------------------------------- QA */

export interface QaRepository {
  checklist(): Promise<QaChecklistItem[]>;

  /**
   * Which checks fail most often (PRD 11, the QA dashboard).
   *
   * The one widget in PRD 11 that is a question about QA itself rather than
   * about a report, and the only one worth acting on: a check that fails
   * repeatedly is either a habit worth training out or a check worth
   * rewording. Counted over completed reviews only, because an open review
   * has answers that are still being changed.
   */
  commonFailures(limit?: number): Promise<
    Array<{
      itemKey: string;
      label: string;
      failures: number;
      reviewsAnswered: number;
      /** Null rather than zero when the check has never been answered. */
      failureRate: number | null;
    }>
  >;

  reviews(reportId: string): Promise<QaReview[]>;
  findReview(reviewId: string): Promise<QaReview | null>;

  /** Opens a review, or returns the one already open on this version. */
  open(input: { reportId: string; versionId: string }): Promise<QaReview>;

  answer(input: {
    reviewId: string;
    itemKey: string;
    result: QaItemResult;
    comment?: string | null;
  }): Promise<void>;

  /**
   * Completes the review. The result is derived from the items by the
   * application, and the database refuses an approval with a failed item.
   */
  complete(input: {
    reviewId: string;
    result: "approved" | "returned";
    summary?: string | null;
  }): Promise<QaReview>;

  /** The return rate PRD 10.4 asks for. */
  returnRate(filter: { since?: string }): Promise<{
    reviewsCompleted: number;
    returned: number;
    rate: number | null;
  }>;
}

/* ---------------------------------------------------------- delivery */

export interface DeliveryRepository {
  forReport(reportId: string): Promise<Delivery[]>;

  record(input: {
    reportId: string;
    versionId: string;
    deliveredTo: string;
    deliveryMethod: DeliveryMethod;
    notes?: string | null;
  }): Promise<Delivery>;

  acknowledge(input: {
    deliveryId: string;
    acknowledgement: string;
    acknowledgedByName?: string | null;
  }): Promise<Delivery>;

  /** Whether any report on this case has been delivered, for the closure gate. */
  anyForCase(caseId: string): Promise<boolean>;
}

/* ----------------------------------------------------------- closure */

export interface ClosureRepository {
  retentionClasses(): Promise<RetentionClass[]>;

  forCase(caseId: string): Promise<CaseClosure | null>;

  /** Everything the gate needs, read from the records rather than attested. */
  gateState(caseId: string): Promise<{
    openTaskCount: number;
    reportApproved: boolean;
    deliveryRecorded: boolean;
    evidenceOnRelease: number;
    objectivesRecorded: boolean;
  }>;

  propose(input: {
    caseId: string;
    objectivesOutcome: string;
    evidenceDisposition: string;
    outstandingIssues?: string | null;
    financialStatus: string;
    retentionClass: string;
    whatWorked?: string | null;
    whatDidNotWork?: string | null;
    challenges?: string | null;
    newSources?: string | null;
    newTypologies?: string | null;
    methodologicalLessons?: string | null;
    recommendations?: string | null;
    contributeToKnowledgeBase?: boolean;
  }): Promise<CaseClosure>;

  update(
    caseId: string,
    input: Partial<{
      objectivesOutcome: string;
      evidenceDisposition: string;
      outstandingIssues: string | null;
      financialStatus: string;
      retentionClass: string;
      whatWorked: string | null;
      whatDidNotWork: string | null;
      challenges: string | null;
      newSources: string | null;
      newTypologies: string | null;
      methodologicalLessons: string | null;
      recommendations: string | null;
      contributeToKnowledgeBase: boolean;
    }>,
    expectedVersion: number,
  ): Promise<CaseClosure>;

  /**
   * Records the supervisor's decision. Approving also closes the case, in the
   * same transaction: a closure approved without the case closing would leave
   * the two disagreeing, and whichever a screen read would be wrong.
   */
  decide(input: {
    caseId: string;
    status: "approved" | "returned";
    reviewNotes?: string | null;
  }): Promise<CaseClosure>;

  /** The lessons-learned entries offered to the knowledge base. */
  knowledgeBase(filter: { limit?: number }): Promise<CaseClosure[]>;
}

/* ------------------------------------------------- management reports */

export interface ManagementRepository {
  /** PRD 10.4, in one read, because it is one screen. */
  report(filter: { since?: string; office?: string }): Promise<ManagementReport>;
}

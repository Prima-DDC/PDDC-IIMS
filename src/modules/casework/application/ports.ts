import type { ClassificationLevel } from "@/modules/iam/domain/classification";
import type {
  AssignmentRole,
  Case,
  CaseAssignment,
  CaseCommunication,
  CaseObjective,
  CasePriority,
  CaseType,
  CommunicationChannel,
  CommunicationDirection,
  CommunicationKind,
  RiskAssessment,
  RiskLevel,
  ScopeChangeRequest,
  ScopeVersion,
  WorkflowDefinition,
  WorkflowStage,
  WorkflowTransition,
} from "../domain/types";

/** What the casework use cases need from the outside world. */

export interface Page<T> {
  rows: T[];
  total: number;
}

/* -------------------------------------------------------------- workflow */

/**
 * The configurable lifecycle (PRD 4.3).
 *
 * Separate from the case repository because it is read on nearly every screen
 * and changes almost never, which makes it the one thing in this module worth
 * caching per request.
 */
export interface WorkflowRepository {
  /** The definition new cases are opened against. */
  defaultDefinition(): Promise<WorkflowDefinition>;
  definition(id: string): Promise<WorkflowDefinition | null>;
  listDefinitions(): Promise<WorkflowDefinition[]>;
  /** The legal moves out of a stage, with the permission each needs. */
  transitionsFrom(stageId: string): Promise<WorkflowTransition[]>;
  stage(id: string): Promise<WorkflowStage | null>;
  /**
   * One transition by id, with the stage it leaves.
   *
   * The administration screen needs to know which stage a route belongs to
   * before it will take it away. Asking `transitionsFrom` for every stage in
   * turn would be fourteen round trips to answer a question one can.
   */
  transition(id: string): Promise<
    | {
        id: string;
        fromStageId: string;
        fromStageName: string;
        fromStageIsTerminal: boolean;
        toStageId: string;
        toStageName: string;
        /** How many other routes leave the same stage. */
        siblingCount: number;
      }
    | null
  >;
  caseTypes(includeInactive?: boolean): Promise<CaseType[]>;

  /* Administration of the lifecycle itself (PRD 4.3, 3.5). */
  createStage(input: {
    definitionId: string;
    key: string;
    name: string;
    position: number;
    methodologyStage?: string | null;
    isTerminal?: boolean;
    requiresApproval?: boolean;
    description?: string | null;
  }): Promise<WorkflowStage>;
  renameStage(id: string, name: string): Promise<WorkflowStage>;
  reorderStages(definitionId: string, orderedStageIds: string[]): Promise<void>;
  addTransition(input: {
    definitionId: string;
    fromStageId: string;
    toStageId: string;
    requiredPermission?: string | null;
    requiresReason?: boolean;
  }): Promise<void>;
  removeTransition(id: string): Promise<void>;

  /**
   * How many live cases sit in each stage of a definition.
   *
   * The administration screen needs it before it lets anybody take a route
   * away: removing the only way out of a stage that holds cases strands them,
   * and the refusal can then say how many and where.
   */
  stageUsage(definitionId: string): Promise<Array<{ stageId: string; cases: number }>>;

  upsertCaseType(input: {
    key: string;
    name: string;
    description?: string | null;
    isActive?: boolean;
    position?: number;
  }): Promise<CaseType>;
  setCaseTypeActive(key: string, isActive: boolean): Promise<void>;
}

/* ------------------------------------------------------------------ cases */

export interface ListCasesFilter {
  search?: string;
  stageKey?: string;
  /** Open, closed, or everything. Cheaper than naming every stage. */
  openness?: "open" | "closed" | "all";
  priority?: CasePriority;
  riskLevel?: RiskLevel;
  caseType?: string;
  clientId?: string;
  engagementId?: string;
  /** Cases this user holds a live assignment on. Drives "my cases". */
  assignedTo?: string;
  overdueOnly?: boolean;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
  sort?: "opened" | "target" | "priority" | "risk" | "title" | "stage";
}

export interface CreateCaseInput {
  title: string;
  clientId: string;
  engagementId: string;
  caseType: string;
  jurisdictionCountry?: string | null;
  jurisdictionRegion?: string | null;
  officeId?: string | null;
  priority: CasePriority;
  /**
   * When the work began, which may precede the row.
   *
   * Defaults to now. A case entered for work that started before the platform
   * did carries its real date, which is what PDDC needs while it moves off
   * the previous manual process: such a case's target may already have passed.
   */
  openedAt?: string | null;
  targetCompletionAt?: string | null;
  classification: ClassificationLevel;
  /** Omitted for the default lifecycle, which is the usual case. */
  definitionId?: string;
}

export type UpdateCaseInput = Partial<Omit<CreateCaseInput, "clientId" | "engagementId">> & {
  expectedVersion: number;
};

/**
 * The counts the case file's tab bar shows, for this module's schemas.
 *
 * One query rather than one per figure. The tab bar is nine numbers and used
 * to be nine transactions: on a pooler that serves this project with a small
 * server pool, a page asking for nine connections at once queues at the
 * pooler, and a queued client is one the pooler may close. Three queries, one
 * per module, is the same information for a third of the connections.
 */
export interface CaseworkTabCounts {
  openTasks: number;
  overdueTasks: number;
  activities: number;
  planAwaitingReview: boolean;
}

export interface CaseRepository {
  /** Tab-bar counts for this module, in one round trip. */
  tabCounts(caseId: string): Promise<CaseworkTabCounts>;

  list(filter: ListCasesFilter): Promise<Page<Case>>;
  findById(id: string): Promise<Case | null>;
  /** Looks a case up by its PDDC-YYYY-NNNNNN identifier. */
  findByReference(reference: string): Promise<Case | null>;
  create(input: CreateCaseInput): Promise<Case>;
  update(id: string, input: UpdateCaseInput): Promise<Case>;

  /**
   * Moves a case to a new stage.
   *
   * The caller has applied the transition rules; this records the move with
   * its reason and the before/after stage, which is what PRD 4.2 requires of
   * every transition.
   */
  moveToStage(input: {
    id: string;
    toStageId: string;
    reason: string | null;
  }): Promise<Case>;

  /** Records the PRD 5.1 override, which is a decision with an owner. */
  recordObjectiveOverride(id: string, reason: string): Promise<Case>;

  softDelete(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;

  /* ---------------------------------------------------------- assignment */

  assignments(caseId: string, includeHistoric?: boolean): Promise<CaseAssignment[]>;
  assign(input: {
    caseId: string;
    userId: string;
    role: AssignmentRole;
    reason?: string | null;
  }): Promise<CaseAssignment>;
  unassign(assignmentId: string, reason: string): Promise<void>;

  /* ---------------------------------------------------------- objectives */

  objective(caseId: string): Promise<CaseObjective | null>;
  setObjective(input: {
    caseId: string;
    clientInstruction?: string | null;
    objective: string;
    questions: string[];
    deliverables: string[];
    deadline?: string | null;
    /** Present when editing an existing objective. */
    expectedVersion?: number;
  }): Promise<CaseObjective>;

  /* ---------------------------------------------------------------- risk */

  riskAssessments(caseId: string): Promise<RiskAssessment[]>;
  addRiskAssessment(input: {
    caseId: string;
    operationalRisk: RiskLevel;
    legalRisk: RiskLevel;
    reputationalRisk: RiskLevel;
    safetyRisk: RiskLevel;
    sensitivityRisk: RiskLevel;
    overallRisk: RiskLevel;
    rationale: string;
  }): Promise<RiskAssessment>;
  /** PRD 5.3's Operations Manager sign-off on a critical case. */
  approveRiskAssessment(id: string): Promise<RiskAssessment>;

  /* --------------------------------------------------------------- scope */

  scopeVersions(caseId: string): Promise<ScopeVersion[]>;
  /** Version 1 only: later versions come from an approved change request. */
  setOriginalScope(input: {
    caseId: string;
    scope: string;
    outOfScope?: string | null;
  }): Promise<ScopeVersion>;

  scopeChangeRequests(caseId: string): Promise<ScopeChangeRequest[]>;
  requestScopeChange(input: {
    caseId: string;
    reason: string;
    proposedScope: string;
    proposedOutOfScope?: string | null;
    additionalCost?: number | null;
    additionalCostCurrency?: string | null;
    additionalDays?: number | null;
    clientApprovalReference?: string | null;
  }): Promise<ScopeChangeRequest>;
  /**
   * Approves or rejects a change request.
   *
   * Approving writes the next scope version in the same transaction, so the
   * revised scope and the decision that produced it can never be out of step.
   */
  decideScopeChange(input: {
    id: string;
    approve: boolean;
    decisionReason: string;
  }): Promise<ScopeChangeRequest>;
  withdrawScopeChange(id: string, reason: string): Promise<ScopeChangeRequest>;

  /* ------------------------------------------------------ communications */

  communications(caseId: string): Promise<CaseCommunication[]>;
  logCommunication(input: {
    caseId: string;
    occurredAt?: string | null;
    direction: CommunicationDirection;
    kind: CommunicationKind;
    channel: CommunicationChannel;
    sender: string;
    recipient: string;
    subject: string;
    body?: string | null;
    attachmentReference?: string | null;
    classification: ClassificationLevel;
  }): Promise<CaseCommunication>;
  updateCommunication(
    id: string,
    input: {
      subject?: string;
      body?: string | null;
      attachmentReference?: string | null;
      expectedVersion: number;
    },
  ): Promise<CaseCommunication>;
  removeCommunication(id: string, reason: string): Promise<void>;

  /* ------------------------------------------------------------- summary */

  /** Counts for the case list header, in one round trip. */
  summary(forUserId?: string): Promise<{
    total: number;
    open: number;
    mine: number;
    overdue: number;
    criticalRisk: number;
    awaitingApproval: number;
  }>;
}

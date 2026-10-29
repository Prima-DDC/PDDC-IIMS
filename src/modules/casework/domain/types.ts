import type { ClassificationLevel } from "@/modules/iam/domain/classification";

/**
 * Casework entities (PRD 5, 9).
 *
 * One thing here is unlike the CRM module and is the single most important
 * decision in M3: **the case lifecycle is data, not a union type.** PRD 4.3
 * says administrators can "rename, add or reorder stages, and attach required
 * checks to each, without code changes", which rules out an enum here as much
 * as it rules out a CHECK constraint in the database. A case therefore carries
 * a `stage` object loaded from config.workflow_stages, and the legal next
 * steps come from config.workflow_transitions rather than from a map in this
 * file.
 *
 * The things that are NOT configurable stay typed: priority, the five risk
 * dimensions, assignment roles and communication kinds are all fixed
 * vocabularies in the PRD, and each is a CHECK constraint in migration 0022.
 */

/* ---------------------------------------------------------- the lifecycle */

/** The methodology stages of PRD 4.3, which group the lifecycle states. */
export const METHODOLOGY_STAGES = [
  "planning",
  "collection",
  "verification",
  "analysis",
  "assessment",
  "reporting",
] as const;
export type MethodologyStage = (typeof METHODOLOGY_STAGES)[number];

export const METHODOLOGY_LABELS: Record<MethodologyStage, string> = {
  planning: "Planning",
  collection: "Collection",
  verification: "Verification",
  analysis: "Analysis",
  assessment: "Assessment",
  reporting: "Reporting",
};

export interface WorkflowStage {
  id: string;
  definitionId: string;
  key: string;
  name: string;
  position: number;
  methodologyStage: string | null;
  isTerminal: boolean;
  requiresApproval: boolean;
  description: string | null;
}

/**
 * A legal move out of a stage.
 *
 * `requiredPermission` is the resource:action a caller needs to make it, or
 * null when ordinary cases:edit is enough. The use case reads it rather than
 * deciding for itself, so adding a gated transition is configuration.
 */
export interface WorkflowTransition {
  id: string;
  toStageId: string;
  toStageKey: string;
  toStageName: string;
  requiredPermission: string | null;
  requiresReason: boolean;
}

export interface WorkflowDefinition {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  stages: WorkflowStage[];
}

/* ---------------------------------------------------------------- the case */

export const CASE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

export const CASE_PRIORITY_LABELS: Record<CasePriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export interface CaseType {
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  position: number;
}

export interface Case {
  id: string;
  caseId: string;
  title: string;

  clientId: string;
  clientName: string;
  clientReference: string;
  engagementId: string;
  engagementReference: string;
  engagementTitle: string;

  caseType: string;
  caseTypeName: string;
  jurisdictionCountry: string | null;
  jurisdictionCountryName: string | null;
  jurisdictionRegion: string | null;
  officeId: string | null;
  officeName: string | null;

  priority: CasePriority;
  riskLevel: RiskLevel;

  /** The lifecycle position, loaded rather than inferred. */
  definitionId: string;
  stageId: string;
  stageKey: string;
  stageName: string;
  stagePosition: number;
  stageIsTerminal: boolean;
  methodologyStage: string | null;

  openedAt: string;
  targetCompletionAt: string | null;
  actualCompletionAt: string | null;
  /** Negative when the target has passed and the case is still open. */
  daysToTarget: number | null;
  isOverdue: boolean;

  classification: ClassificationLevel;

  retentionClass: string | null;
  closureSummary: string | null;
  closedBy: string | null;
  closedByName: string | null;
  closedAt: string | null;

  /** PRD 5.1's override, recorded rather than implied by an absent objective. */
  objectiveOverrideReason: string | null;
  objectiveOverrideBy: string | null;
  objectiveOverrideAt: string | null;

  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  updatedAt: string;
  version: number;
  deletedAt: string | null;

  /** Counts and summaries the list and header need without a second query. */
  assignmentCount: number;
  openTaskCount: number;
  overdueTaskCount: number;
  hasObjective: boolean;
  leadInvestigatorName: string | null;
  supervisorName: string | null;
}

/* ----------------------------------------------------------- assignments */

export const ASSIGNMENT_ROLES = [
  "lead_investigator",
  "supporting_investigator",
  "supervisor",
  "analyst",
  "specialist",
  "operations_manager",
  "observer",
] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const ASSIGNMENT_ROLE_LABELS: Record<AssignmentRole, string> = {
  lead_investigator: "Lead investigator",
  supporting_investigator: "Supporting investigator",
  supervisor: "Supervisor",
  analyst: "Analyst",
  specialist: "Specialist",
  operations_manager: "Operations manager",
  observer: "Observer",
};

/** The roles there can be only one of at a time, enforced by a unique index. */
export const SINGULAR_ASSIGNMENT_ROLES: readonly AssignmentRole[] = [
  "lead_investigator",
  "supervisor",
];

export interface CaseAssignment {
  id: string;
  caseId: string;
  userId: string;
  userName: string;
  userEmail: string;
  role: AssignmentRole;
  assignedAt: string;
  assignedBy: string | null;
  assignedByName: string | null;
  reason: string | null;
  unassignedAt: string | null;
  unassignedBy: string | null;
  unassignReason: string | null;
}

/* ------------------------------------------------------------ objectives */

export interface CaseObjective {
  id: string;
  caseId: string;
  clientInstruction: string | null;
  objective: string;
  questions: string[];
  deliverables: string[];
  deadline: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  version: number;
}

/* ------------------------------------------------------------------ risk */

/** The five dimensions PRD 5.3 names, plus the overall rating. */
export const RISK_DIMENSIONS = [
  "operational",
  "legal",
  "reputational",
  "safety",
  "sensitivity",
] as const;
export type RiskDimension = (typeof RISK_DIMENSIONS)[number];

export const RISK_DIMENSION_LABELS: Record<RiskDimension, string> = {
  operational: "Operational",
  legal: "Legal and regulatory",
  reputational: "Reputational",
  safety: "Investigator safety",
  sensitivity: "Information sensitivity",
};

export interface RiskAssessment {
  id: string;
  caseId: string;
  operationalRisk: RiskLevel;
  legalRisk: RiskLevel;
  reputationalRisk: RiskLevel;
  safetyRisk: RiskLevel;
  sensitivityRisk: RiskLevel;
  overallRisk: RiskLevel;
  rationale: string;
  assessedBy: string | null;
  assessedByName: string | null;
  assessedAt: string;
  /** PRD 5.3: a critical case needs Operations Manager approval to be assigned. */
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  createdAt: string;
}

/* ----------------------------------------------------------------- scope */

export interface ScopeVersion {
  id: string;
  caseId: string;
  versionNo: number;
  scope: string;
  outOfScope: string | null;
  changeRequestId: string | null;
  changeRequestReference: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
}

export const SCOPE_CHANGE_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
] as const;
export type ScopeChangeStatus = (typeof SCOPE_CHANGE_STATUSES)[number];

export const SCOPE_CHANGE_STATUS_LABELS: Record<ScopeChangeStatus, string> = {
  pending: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export interface ScopeChangeRequest {
  id: string;
  changeId: string;
  caseId: string;
  reason: string;
  proposedScope: string;
  proposedOutOfScope: string | null;
  additionalCost: number | null;
  additionalCostCurrency: string | null;
  additionalDays: number | null;
  clientApprovalReference: string | null;
  status: ScopeChangeStatus;
  requestedBy: string | null;
  requestedByName: string | null;
  requestedAt: string;
  approvingOfficer: string | null;
  approvingOfficerName: string | null;
  approvedAt: string | null;
  decisionReason: string | null;
  resultingVersionId: string | null;
  resultingVersionNo: number | null;
  createdAt: string;
  version: number;
}

/* -------------------------------------------------------- communications */

export const COMMUNICATION_KINDS = [
  "instruction",
  "clarification",
  "scope_change",
  "deadline_change",
  "approval",
  "decision",
  "status_update",
  "other",
] as const;
export type CommunicationKind = (typeof COMMUNICATION_KINDS)[number];

export const COMMUNICATION_KIND_LABELS: Record<CommunicationKind, string> = {
  instruction: "Instruction",
  clarification: "Clarification",
  scope_change: "Scope change",
  deadline_change: "Deadline change",
  approval: "Approval",
  decision: "Decision",
  status_update: "Status update",
  other: "Other",
};

export const COMMUNICATION_DIRECTIONS = ["inbound", "outbound", "internal"] as const;
export type CommunicationDirection = (typeof COMMUNICATION_DIRECTIONS)[number];

export const COMMUNICATION_DIRECTION_LABELS: Record<CommunicationDirection, string> = {
  inbound: "Received",
  outbound: "Sent",
  internal: "Internal",
};

export const COMMUNICATION_CHANNELS = [
  "email",
  "telephone",
  "meeting",
  "letter",
  "portal",
  "other",
] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export const COMMUNICATION_CHANNEL_LABELS: Record<CommunicationChannel, string> = {
  email: "Email",
  telephone: "Telephone",
  meeting: "Meeting",
  letter: "Letter",
  portal: "Client portal",
  other: "Other",
};

export interface CaseCommunication {
  id: string;
  caseId: string;
  occurredAt: string;
  direction: CommunicationDirection;
  kind: CommunicationKind;
  channel: CommunicationChannel;
  sender: string;
  recipient: string;
  subject: string;
  body: string | null;
  attachmentReference: string | null;
  classification: ClassificationLevel;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
}

/* ----------------------------------------------------------------- tasks */

/** PRD 9.1's statuses. `blocked` and `cancelled` each require a reason. */
export const TASK_STATUSES = [
  "not_started",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** The statuses that mean a task is no longer waiting on anybody. */
export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ["completed", "cancelled"];

/** The statuses that demand a reason, per PRD 9.1. */
export const TASK_STATUSES_NEEDING_REASON: readonly TaskStatus[] = [
  "blocked",
  "cancelled",
];

export interface Task {
  id: string;
  taskId: string;
  caseId: string;
  caseReference: string;
  caseTitle: string;
  title: string;
  description: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  priority: CasePriority;
  startDate: string | null;
  dueDate: string | null;
  status: TaskStatus;
  statusReason: string | null;
  completedAt: string | null;
  methodologyStage: string | null;
  parentTaskId: string | null;
  parentTaskTitle: string | null;
  planVersionId: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
  /** Negative when the due date has passed and the task is still open. */
  daysToDue: number | null;
  isOverdue: boolean;
  commentCount: number;
  subTaskCount: number;
}

export interface TaskComment {
  id: string;
  taskId: string;
  body: string;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
}

/* ------------------------------------------------------------ activities */

export const ACTIVITY_TYPES = [
  "research",
  "interview",
  "surveillance",
  "site_visit",
  "document_review",
  "evidence_collection",
  "analysis",
  "liaison",
  "travel",
  "other",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  research: "Research",
  interview: "Interview",
  surveillance: "Surveillance",
  site_visit: "Site visit",
  document_review: "Document review",
  evidence_collection: "Evidence collection",
  analysis: "Analysis",
  liaison: "Liaison",
  travel: "Travel",
  other: "Other",
};

export interface Activity {
  id: string;
  activityId: string;
  caseId: string;
  occurredAt: string;
  activityType: ActivityType;
  description: string;
  location: string | null;
  relatedSourceId: string | null;
  relatedEvidenceId: string | null;
  relatedDocumentId: string | null;
  relatedTaskId: string | null;
  relatedTaskTitle: string | null;
  /** Set when this entry corrects an earlier one (PRD 9.4). */
  correctsActivityId: string | null;
  correctsActivityReference: string | null;
  correctionReason: string | null;
  /** Set when a later entry corrects this one, so the log can say so. */
  correctedByActivityId: string | null;
  correctedByReference: string | null;
  classification: ClassificationLevel;
  recordedAt: string;
  recordedBy: string | null;
  recordedByName: string | null;
}

/* ------------------------------------------------- investigation plans */

export const PLAN_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "returned",
  "superseded",
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: "Draft",
  submitted: "Awaiting review",
  approved: "Approved",
  returned: "Returned for changes",
  superseded: "Superseded",
};

export interface PlanVersion {
  id: string;
  planId: string;
  versionNo: number;
  objective: string;
  scope: string | null;
  methodology: string;
  sourcesToConsult: string[];
  assignedPersonnel: string[];
  timeline: string | null;
  risks: string | null;
  resources: string | null;
  expectedDeliverables: string[];
  status: PlanStatus;
  submittedAt: string | null;
  submittedBy: string | null;
  submittedByName: string | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  version: number;
}

export interface InvestigationPlan {
  id: string;
  planId: string;
  caseId: string;
  createdAt: string;
  createdBy: string | null;
  versions: PlanVersion[];
  /** The approved version in force, if there is one. */
  current: PlanVersion | null;
  /** The version being worked on or reviewed, if there is one. */
  working: PlanVersion | null;
}

/* ------------------------------------------------- investigator safety */

export const SITE_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type SiteRiskLevel = (typeof SITE_RISK_LEVELS)[number];

export interface SafetyPlan {
  id: string;
  caseId: string;
  location: string;
  siteVisitRisk: SiteRiskLevel;
  knownHazards: string | null;
  safetyInstructions: string | null;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactNote: string | null;
  /** Null means no check-in schedule, which is not the same as zero hours. */
  checkInFrequencyHours: number | null;
  checkInInstructions: string | null;
  isActive: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  version: number;
}

export const CHECK_IN_EVENTS = ["check_in", "check_out"] as const;
export type CheckInEvent = (typeof CHECK_IN_EVENTS)[number];

export const CHECK_IN_EVENT_LABELS: Record<CheckInEvent, string> = {
  check_in: "Checked in",
  check_out: "Checked out",
};

export interface CheckIn {
  id: string;
  checkInId: string;
  caseId: string;
  caseReference: string;
  userId: string;
  userName: string | null;
  event: CheckInEvent;
  occurredAt: string;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  nextDueAt: string | null;
  isSafe: boolean;
  notes: string | null;
  recordedAt: string;
  recordedBy: string | null;
  recordedByName: string | null;
  /** True when this is the latest event for the person and the next one is late. */
  isOverdue: boolean;
  minutesLate: number | null;
}

export const INCIDENT_TYPES = [
  "threat",
  "assault",
  "surveillance_detected",
  "detention",
  "road_accident",
  "health",
  "equipment_loss",
  "data_loss",
  "legal_challenge",
  "other",
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  threat: "Threat or intimidation",
  assault: "Assault",
  surveillance_detected: "Surveillance detected",
  detention: "Detention or questioning",
  road_accident: "Road accident",
  health: "Health emergency",
  equipment_loss: "Equipment lost or stolen",
  data_loss: "Data lost or exposed",
  legal_challenge: "Legal challenge",
  other: "Other",
};

export const INCIDENT_STATUSES = ["open", "under_review", "closed"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  open: "Open",
  under_review: "Under review",
  closed: "Closed",
};

export interface Incident {
  id: string;
  incidentId: string;
  caseId: string;
  caseReference: string;
  occurredAt: string;
  incidentType: IncidentType;
  severity: SiteRiskLevel;
  location: string | null;
  description: string;
  immediateAction: string | null;
  injuries: boolean;
  injuryDetail: string | null;
  policeNotified: boolean;
  policeReference: string | null;
  affectedUserId: string | null;
  affectedUserName: string | null;
  status: IncidentStatus;
  resolution: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  classification: ClassificationLevel;
  reportedAt: string;
  reportedBy: string | null;
  reportedByName: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/* ------------------------------------------- financials, time and costs */

export const PAYMENT_STATUSES = [
  "not_invoiced",
  "invoiced",
  "part_paid",
  "paid",
  "overdue",
  "written_off",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  not_invoiced: "Not invoiced",
  invoiced: "Invoiced",
  part_paid: "Part paid",
  paid: "Paid",
  overdue: "Overdue",
  written_off: "Written off",
};

export interface CaseFinancials {
  id: string;
  caseId: string;
  currency: string;
  quotedFee: number | null;
  approvedFee: number | null;
  additionalFees: number;
  invoiceNumber: string | null;
  amountInvoiced: number;
  amountPaid: number;
  /** Computed by the database, so it cannot disagree with its own inputs. */
  outstanding: number;
  paymentStatus: PaymentStatus;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  version: number;
}

export const WORK_KINDS = [
  "investigation",
  "analysis",
  "surveillance",
  "field_work",
  "interview",
  "travel",
  "report_writing",
  "liaison",
  "review",
  "administration",
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const WORK_KIND_LABELS: Record<WorkKind, string> = {
  investigation: "Investigation",
  analysis: "Analysis",
  surveillance: "Surveillance",
  field_work: "Field work",
  interview: "Interview",
  travel: "Travel",
  report_writing: "Report writing",
  liaison: "Liaison",
  review: "Review",
  administration: "Administration",
};

export const TIME_UNITS = ["hours", "days"] as const;
export type TimeUnit = (typeof TIME_UNITS)[number];

export interface TimeEntry {
  id: string;
  caseId: string;
  caseReference: string;
  userId: string;
  userName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  workedOn: string;
  quantity: number;
  unit: TimeUnit;
  workKind: WorkKind;
  description: string | null;
  isBillable: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export const EXPENSE_CATEGORIES = [
  "travel",
  "accommodation",
  "subsistence",
  "external_services",
  "specialist_fees",
  "records_and_searches",
  "equipment",
  "communications",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  travel: "Travel",
  accommodation: "Accommodation",
  subsistence: "Subsistence",
  external_services: "External services",
  specialist_fees: "Specialist fees",
  records_and_searches: "Records and searches",
  equipment: "Equipment",
  communications: "Communications",
  other: "Other",
};

export const EXPENSE_STATUSES = [
  "claimed",
  "approved",
  "rejected",
  "reimbursed",
] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  claimed: "Claimed",
  approved: "Approved",
  rejected: "Rejected",
  reimbursed: "Reimbursed",
};

export interface Expense {
  id: string;
  expenseId: string;
  caseId: string;
  caseReference: string;
  incurredOn: string;
  category: ExpenseCategory;
  description: string;
  amount: number;
  currency: string;
  isBillable: boolean;
  receiptReference: string | null;
  incurredBy: string | null;
  incurredByName: string | null;
  status: ExpenseStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decisionReason: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** What a case has cost and earned, as the finance panel shows it. */
export interface CaseCostSummary {
  /** Hours and days are summed separately: PRD 5.7 keeps both units. */
  hours: number;
  days: number;
  billableHours: number;
  expenseTotal: number;
  billableExpenseTotal: number;
  approvedExpenseTotal: number;
  claimedExpenseCount: number;
  currency: string;
}

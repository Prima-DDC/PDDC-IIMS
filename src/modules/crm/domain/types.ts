import type { ClassificationLevel } from "@/modules/iam/domain/classification";

/**
 * CRM entities and the vocabularies they use (PRD 8, 4.1).
 *
 * The structure the PRD fixes is Client -> Engagement -> Case. Intake runs
 * Enquiry -> Client/KYC -> Conflict Check -> Assessment -> Quotation ->
 * Engagement Approval -> Case Creation.
 *
 * Every list here is also a CHECK constraint in migrations 0018 and 0019.
 * They are duplicated deliberately: the database is the guarantee, and these
 * are what the interface renders and what zod validates, so a value that is
 * not in both cannot reach the database at all.
 *
 * `ClassificationLevel` is imported from the IAM domain's classification leaf,
 * which has no imports of its own. @/lib/db/client does the same.
 */

/* ----------------------------------------------------------------- clients */

export const CLIENT_TYPES = [
  "corporate",
  "financial_institution",
  "insurer",
  "government",
  "law_firm",
  "individual",
  "ngo",
  "other",
] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const CLIENT_TYPE_LABELS: Record<ClientType, string> = {
  corporate: "Corporate",
  financial_institution: "Financial institution",
  insurer: "Insurer",
  government: "Government",
  law_firm: "Law firm",
  individual: "Individual",
  ngo: "NGO",
  other: "Other",
};

export const CLIENT_STATUSES = [
  "prospect",
  "active",
  "dormant",
  "suspended",
  "closed",
] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const CLIENT_STATUS_LABELS: Record<ClientStatus, string> = {
  prospect: "Prospect",
  active: "Active",
  dormant: "Dormant",
  suspended: "Suspended",
  closed: "Closed",
};

export const RISK_RATINGS = ["low", "medium", "high", "critical"] as const;
export type RiskRating = (typeof RISK_RATINGS)[number];

export const RISK_RATING_LABELS: Record<RiskRating, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const KYC_STATUSES = [
  "not_started",
  "in_progress",
  "completed",
  "failed",
  "expired",
] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const KYC_STATUS_LABELS: Record<KycStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  expired: "Expired",
};

export interface Client {
  id: string;
  clientId: string;
  organisationName: string;
  contactPerson: string | null;
  position: string | null;
  telephone: string | null;
  email: string | null;
  address: string | null;
  countryCode: string | null;
  countryName: string | null;
  officeId: string | null;
  officeName: string | null;
  industry: string | null;
  clientType: ClientType;
  kycStatus: KycStatus;
  kycCompletedAt: string | null;
  riskRating: RiskRating;
  accountManagerId: string | null;
  accountManagerName: string | null;
  dateOnboarded: string | null;
  status: ClientStatus;
  classification: ClassificationLevel;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
  /** Counts, present on the list and the detail page. */
  engagementCount: number;
  contactCount: number;
}

export interface ClientContact {
  id: string;
  clientId: string;
  fullName: string;
  position: string | null;
  email: string | null;
  telephone: string | null;
  isPrimary: boolean;
  notes: string | null;
  createdAt: string;
  version: number;
  deletedAt: string | null;
}

export const DOCUMENT_TYPES = [
  "registration",
  "identification",
  "nda",
  "engagement_letter",
  "contract",
  "purchase_order",
  "kyc_evidence",
  "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  registration: "Certificate of registration",
  identification: "Identification",
  nda: "Non-disclosure agreement",
  engagement_letter: "Engagement letter",
  contract: "Contract",
  purchase_order: "Purchase order",
  kyc_evidence: "KYC evidence",
  other: "Other",
};

export interface ClientDocument {
  id: string;
  clientId: string;
  documentType: DocumentType;
  title: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  sha256Hash: string | null;
  storageKey: string | null;
  classification: ClassificationLevel;
  expiresAt: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
  uploadedByName: string | null;
  deletedAt: string | null;
}

/* --------------------------------------------------------------------- KYC */

export const KYC_CHECK_TYPES = [
  "identity",
  "registration",
  "ownership",
  "sanctions",
  "adverse_media",
  "pep",
  "source_of_funds",
  "other",
] as const;
export type KycCheckType = (typeof KYC_CHECK_TYPES)[number];

export const KYC_CHECK_LABELS: Record<KycCheckType, string> = {
  identity: "Identity verification",
  registration: "Company registration",
  ownership: "Beneficial ownership",
  sanctions: "Sanctions screening",
  adverse_media: "Adverse media",
  pep: "Politically exposed person",
  source_of_funds: "Source of funds",
  other: "Other",
};

export const KYC_OUTCOMES = ["pending", "pass", "fail", "inconclusive"] as const;
export type KycOutcome = (typeof KYC_OUTCOMES)[number];

export const KYC_OUTCOME_LABELS: Record<KycOutcome, string> = {
  pending: "Pending",
  pass: "Pass",
  fail: "Fail",
  inconclusive: "Inconclusive",
};

export interface KycRecord {
  id: string;
  clientId: string;
  checkType: KycCheckType;
  outcome: KycOutcome;
  summary: string | null;
  evidenceDocumentId: string | null;
  performedBy: string | null;
  performedByName: string | null;
  performedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  version: number;
}

/* --------------------------------------------------------------- enquiries */

export const ENQUIRY_CHANNELS = [
  "email",
  "telephone",
  "meeting",
  "website",
  "referral",
  "existing_client",
  "other",
] as const;
export type EnquiryChannel = (typeof ENQUIRY_CHANNELS)[number];

export const ENQUIRY_CHANNEL_LABELS: Record<EnquiryChannel, string> = {
  email: "Email",
  telephone: "Telephone",
  meeting: "Meeting",
  website: "Website",
  referral: "Referral",
  existing_client: "Existing client",
  other: "Other",
};

export const URGENCY_LEVELS = ["low", "normal", "high", "urgent"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export const URGENCY_LABELS: Record<UrgencyLevel, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const ENQUIRY_STATUSES = [
  "new",
  "assessing",
  "conflict_check",
  "quoted",
  "accepted",
  "declined",
  "lapsed",
] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const ENQUIRY_STATUS_LABELS: Record<EnquiryStatus, string> = {
  new: "New",
  assessing: "Being assessed",
  conflict_check: "Conflict check",
  quoted: "Quoted",
  accepted: "Accepted",
  declined: "Declined",
  lapsed: "Lapsed",
};

export interface Enquiry {
  id: string;
  enquiryId: string;
  receivedAt: string;
  receivedVia: EnquiryChannel;
  clientId: string | null;
  clientName: string | null;
  clientReference: string | null;
  prospectName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  subject: string;
  summary: string | null;
  requestedService: string | null;
  urgency: UrgencyLevel;
  status: EnquiryStatus;
  declineReason: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  countryCode: string | null;
  officeId: string | null;
  classification: ClassificationLevel;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Set when a conflict check exists for this enquiry. */
  conflictStatus: ConflictStatus | null;
  engagementId: string | null;
  engagementReference: string | null;
}

/** The party an enquiry names, whether an existing client or a prospect. */
export function enquiryParty(enquiry: Enquiry): string {
  return enquiry.clientName ?? enquiry.prospectName ?? "unnamed party";
}

/* ------------------------------------------------------------- engagements */

export const ENGAGEMENT_TYPES = [
  "due_diligence",
  "corporate_investigation",
  "insurance_investigation",
  "fraud_investigation",
  "background_screening",
  "asset_search",
  "corporate_intelligence",
  "digital_forensics",
  "retainer",
  "other",
] as const;
export type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

export const ENGAGEMENT_TYPE_LABELS: Record<EngagementType, string> = {
  due_diligence: "Due diligence",
  corporate_investigation: "Corporate investigation",
  insurance_investigation: "Insurance investigation",
  fraud_investigation: "Fraud investigation",
  background_screening: "Background screening",
  asset_search: "Asset search",
  corporate_intelligence: "Corporate intelligence",
  digital_forensics: "Digital forensics",
  retainer: "Retainer",
  other: "Other",
};

export const ENGAGEMENT_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "active",
  "on_hold",
  "completed",
  "cancelled",
] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export const ENGAGEMENT_STATUS_LABELS: Record<EngagementStatus, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

export interface Engagement {
  id: string;
  engagementId: string;
  clientId: string;
  clientName: string;
  clientReference: string;
  enquiryId: string | null;
  enquiryReference: string | null;
  title: string;
  engagementType: EngagementType;
  startDate: string | null;
  endDate: string | null;
  contractReference: string | null;
  ndaReference: string | null;
  scopeOfServices: string | null;
  commercialTerms: string | null;
  responsibleManagerId: string | null;
  responsibleManagerName: string | null;
  status: EngagementStatus;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  countryCode: string | null;
  officeId: string | null;
  classification: ClassificationLevel;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
  /** The decision on the engagement's conflict check, if one has been run. */
  conflictStatus: ConflictStatus | null;
  caseCount: number;
}

/* --------------------------------------------------------- conflict checks */

export const CONFLICT_STATUSES = [
  "open",
  "cleared",
  "further_review",
  "declined",
] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

export const CONFLICT_STATUS_LABELS: Record<ConflictStatus, string> = {
  open: "Awaiting decision",
  cleared: "Cleared",
  further_review: "Further review required",
  declined: "Conflict declined",
};

/** The three decisions PRD 8.3 names. `open` is the absence of a decision. */
export const CONFLICT_DECISIONS = ["cleared", "further_review", "declined"] as const;
export type ConflictDecision = (typeof CONFLICT_DECISIONS)[number];

export const CONFLICT_DECISION_LABELS: Record<ConflictDecision, string> = {
  cleared: "Cleared",
  further_review: "Further review required",
  declined: "Conflict declined",
};

export interface ConflictMatch {
  id: string;
  checkId: string;
  searchedTerm: string;
  matchedTable: string;
  matchedId: string;
  matchedLabel: string;
  /** Trigram similarity, 0 to 1. */
  similarity: number;
  phoneticMatch: boolean;
  matchReason: string | null;
  createdAt: string;
}

export interface ConflictCheck {
  id: string;
  checkId: string;
  enquiryId: string | null;
  enquiryReference: string | null;
  engagementId: string | null;
  engagementReference: string | null;
  clientId: string | null;
  clientName: string | null;
  searchedTerms: string[];
  status: ConflictStatus;
  decision: ConflictDecision | null;
  decisionReason: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  matchCount: number;
  highestScore: number | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  version: number;
  matches: ConflictMatch[];
}

/**
 * A candidate match, as the screening function returns it before anything is
 * recorded. Deliberately has no field that asserts sameness: the system finds
 * potential matches and never concludes two records are the same (PRD 8.3).
 */
export interface ConflictCandidate {
  searchedTerm: string;
  matchedTable: string;
  matchedId: string;
  matchedLabel: string;
  similarity: number;
  phoneticMatch: boolean;
  matchReason: string;
}

import type { ClassificationLevel } from "@/modules/iam/domain/classification";

/**
 * Evidence, chain of custody and documents (PRD 6, 7).
 *
 * The vocabularies are here rather than in the database as enums, for the
 * reason the rest of the platform follows: an enum needs a migration to add a
 * value and cannot carry a label, and these have both a key the database
 * checks and a name people read.
 */

/* ------------------------------------------------------------- evidence */

export const EVIDENCE_TYPES = [
  "document",
  "photograph",
  "video",
  "audio",
  "email",
  "cctv",
  "digital_file",
  "device",
  "physical_item",
  "interview_record",
  "public_record",
  "registry_record",
  "financial_record",
  "other",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  document: "Document",
  photograph: "Photograph",
  video: "Video",
  audio: "Audio",
  email: "Email",
  cctv: "CCTV",
  digital_file: "Digital file",
  device: "Device",
  physical_item: "Physical item",
  interview_record: "Interview record",
  public_record: "Public record",
  registry_record: "Registry record",
  financial_record: "Financial record",
  other: "Other",
};

export const EVIDENCE_STATUSES = [
  "registered",
  "in_review",
  "released",
  "returned",
  "archived",
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const EVIDENCE_STATUS_LABELS: Record<EvidenceStatus, string> = {
  registered: "Registered",
  in_review: "In review",
  released: "Released",
  returned: "Returned",
  archived: "Archived",
};

export const COPY_STATUSES = ["original", "working_copy"] as const;
export type CopyStatus = (typeof COPY_STATUSES)[number];

export const COPY_STATUS_LABELS: Record<CopyStatus, string> = {
  original: "Original",
  working_copy: "Working copy",
};

/**
 * Where an item's integrity stands (PRD 6.3).
 *
 * `hash_unverified` is a first-class state, not a transient one: the browser
 * declared a hash and the server has not yet confirmed it against the stored
 * object. An investigator seeing a seal needs to know which of the two they
 * are looking at.
 */
export const INTEGRITY_STATUSES = [
  "no_file",
  "hash_unverified",
  "verified",
  "mismatch",
] as const;
export type IntegrityStatus = (typeof INTEGRITY_STATUSES)[number];

export const INTEGRITY_STATUS_LABELS: Record<IntegrityStatus, string> = {
  no_file: "No file",
  hash_unverified: "Awaiting verification",
  verified: "Verified",
  mismatch: "Hash mismatch",
};

export interface EvidenceItem {
  id: string;
  evidenceId: string;
  caseId: string;
  caseReference: string;
  exhibitNo: string | null;
  evidenceType: EvidenceType;
  description: string;
  sourceId: string | null;

  collectedBy: string;
  collectedByName: string | null;
  collectedAt: string;
  collectionLocation: string;
  collectionMethod: string;

  copyStatus: CopyStatus;
  originalEvidenceId: string | null;
  originalEvidenceReference: string | null;
  /** How many working copies have been taken from this item. */
  workingCopyCount: number;

  fileName: string | null;
  fileType: string | null;
  fileSize: number | null;
  declaredSha256: string | null;
  computedSha256: string | null;
  integrityStatus: IntegrityStatus;
  verifiedAt: string | null;
  storageBucket: string | null;
  storagePath: string | null;

  classification: ClassificationLevel;
  currentCustodian: string | null;
  currentCustodianName: string | null;
  status: EvidenceStatus;

  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
  /** Custody events recorded against it, which is the chain's length. */
  custodyEventCount: number;
}

/* ------------------------------------------------------- chain of custody */

export const CUSTODY_EVENT_TYPES = [
  "registered",
  "released",
  "received",
  "returned",
  "copied",
  "examined",
  "transferred",
  "archived",
  "correction",
] as const;
export type CustodyEventType = (typeof CUSTODY_EVENT_TYPES)[number];

export const CUSTODY_EVENT_LABELS: Record<CustodyEventType, string> = {
  registered: "Registered",
  released: "Released",
  received: "Received",
  returned: "Returned",
  copied: "Working copy taken",
  examined: "Examined",
  transferred: "Transferred",
  archived: "Archived",
  correction: "Correction",
};

/** The movements that need both a releasing and a receiving person. */
export const CUSTODY_MOVEMENTS: readonly CustodyEventType[] = [
  "released",
  "transferred",
];

export interface CustodyEvent {
  id: string;
  evidenceItemId: string;
  eventType: CustodyEventType;
  occurredAt: string;
  releasedBy: string | null;
  releasedByName: string | null;
  receivedBy: string | null;
  receivedByName: string | null;
  purpose: string;
  location: string | null;
  condition: string | null;
  confirmation: string | null;
  correctsEventId: string | null;
  correctionReason: string | null;
  /** Set when a later event corrects this one, so the ledger can say so. */
  correctedByEventId: string | null;
  recordedAt: string;
  recordedBy: string;
  recordedByName: string | null;
  seq: string;
  prevHash: string;
  rowHash: string;
}

export interface IntegrityCheck {
  id: string;
  evidenceItemId: string;
  checkedAt: string;
  expectedSha256: string;
  actualSha256: string | null;
  result: "match" | "mismatch" | "unreadable";
  checkedBy: string | null;
  checkedByName: string | null;
  notes: string | null;
}

/* ------------------------------------------------------------- documents */

export const DOCUMENT_TYPES = [
  "engagement_letter",
  "nda",
  "client_instruction",
  "kyc",
  "investigation_plan",
  "field_note",
  "interview_record",
  "corporate_record",
  "financial_record",
  "analysis",
  "draft_report",
  "final_report",
  "correspondence",
  "closure",
  "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  engagement_letter: "Engagement letter",
  nda: "Non-disclosure agreement",
  client_instruction: "Client instruction",
  kyc: "KYC record",
  investigation_plan: "Investigation plan",
  field_note: "Field note",
  interview_record: "Interview record",
  corporate_record: "Corporate record",
  financial_record: "Financial record",
  analysis: "Analysis",
  draft_report: "Draft report",
  final_report: "Final report",
  correspondence: "Correspondence",
  closure: "Closure document",
  other: "Other",
};

export interface CaseFolder {
  id: string;
  caseId: string;
  key: string;
  name: string;
  position: number;
  isSystem: boolean;
  /** Live documents filed here, so an empty folder reads as empty. */
  documentCount: number;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  versionNo: number;
  versionLabel: string;
  changeNote: string | null;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  storageBucket: string;
  storagePath: string;
  isCurrent: boolean;
  isApproved: boolean;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
}

export interface CaseDocument {
  id: string;
  documentId: string;
  caseId: string;
  caseReference: string;
  folderId: string | null;
  folderName: string | null;
  title: string;
  documentType: DocumentType;
  classification: ClassificationLevel;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  relatedSourceId: string | null;
  relatedEvidenceId: string | null;
  relatedEvidenceReference: string | null;
  relatedTaskId: string | null;
  relatedTaskTitle: string | null;
  tags: string[];
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
  /** The current version, which is what every screen shows. */
  current: DocumentVersion | null;
  versionCount: number;
}

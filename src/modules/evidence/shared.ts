/**
 * The client-safe half of the evidence module.
 *
 * Types, vocabularies and pure rules only: no "server-only" marker and no
 * database client, so a client component can import this without pulling
 * postgres into the browser bundle.
 *
 * Client components import from "@/modules/evidence/shared"; server code
 * imports from "@/modules/evidence", which re-exports everything here.
 */

export {
  COPY_STATUSES,
  COPY_STATUS_LABELS,
  CUSTODY_EVENT_LABELS,
  CUSTODY_EVENT_TYPES,
  CUSTODY_MOVEMENTS,
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  EVIDENCE_STATUSES,
  EVIDENCE_STATUS_LABELS,
  EVIDENCE_TYPES,
  EVIDENCE_TYPE_LABELS,
  INTEGRITY_STATUSES,
  INTEGRITY_STATUS_LABELS,
  type CaseDocument,
  type CaseFolder,
  type CopyStatus,
  type CustodyEvent,
  type CustodyEventType,
  type DocumentType,
  type DocumentVersion,
  type EvidenceItem,
  type EvidenceStatus,
  type EvidenceType,
  type IntegrityCheck,
  type IntegrityStatus,
} from "./domain/types";

export {
  EVIDENCE_ERROR_STATUS,
  EvidenceError,
  isEvidenceError,
  type EvidenceErrorCode,
} from "./domain/errors";

export {
  allowedEvidenceTransitions,
  assertCitable,
  assertCollectedInThePast,
  assertCollectionRecorded,
  assertCopyIsOfAnOriginal,
  assertCustodyCorrectionUsable,
  assertCustodyPurpose,
  assertEvidenceRemovable,
  assertEvidenceTransition,
  assertMovementHasBothEnds,
  assertNotApprovingOwnVersion,
  assertOriginalFileImmutable,
  assertStatusMatchesCustody,
  assertVersionChangeNote,
  assertVersionEditable,
  assertWorkingCopyHasOriginal,
  integrityVerdict,
  nextVersionLabel,
} from "./domain/policies";

/**
 * File-type rules (PRD 14).
 *
 * In the client-safe barrel because the upload component uses the same
 * allow-list to set its file picker's `accept` attribute. The picker is a
 * convenience and the server check is the control; sharing the list is what
 * stops them disagreeing about which is which.
 */
export {
  PERMITTED_FILE_TYPES,
  SIGNATURE_BYTES,
  checkDeclaredType,
  checkSignature,
  extensionOf,
  sniffType,
} from "./domain/file-types";
export type { FileTypeVerdict } from "./domain/file-types";

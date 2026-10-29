import type { ClassificationLevel } from "@/modules/iam/shared";
import type {
  CaseDocument,
  CaseFolder,
  CopyStatus,
  CustodyEvent,
  CustodyEventType,
  DocumentType,
  DocumentVersion,
  EvidenceItem,
  EvidenceStatus,
  EvidenceType,
  IntegrityCheck,
} from "../domain/types";

/** Ports for evidence, chain of custody and documents (PRD 6, 7). */

export interface Page<T> {
  rows: T[];
  total: number;
}

export interface ListEvidenceFilter {
  caseId?: string;
  search?: string;
  evidenceType?: EvidenceType;
  status?: EvidenceStatus | "all";
  copyStatus?: CopyStatus;
  custodian?: string;
  /** Items whose stored file has not been confirmed, or has failed. */
  integrityConcernsOnly?: boolean;
  originalEvidenceId?: string;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
  sort?: "collected" | "registered" | "exhibit" | "type";
}

export interface RegisterEvidenceInput {
  caseId: string;
  evidenceType: EvidenceType;
  description: string;
  collectedBy: string;
  collectedAt: string;
  collectionLocation: string;
  collectionMethod: string;
  exhibitNo?: string | null;
  sourceId?: string | null;
  classification: ClassificationLevel;
  currentCustodian?: string | null;
  /** A working copy names the original it was taken from. */
  copyStatus?: CopyStatus;
  originalEvidenceId?: string | null;
}

export interface AttachFileInput {
  /** Computed in the browser before the upload (PRD 6.3). */
  declaredSha256: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  storageBucket: string;
  storagePath: string;
}

/**
 * The case file's tab-bar counts for this module's schemas, in one query.
 *
 * See the note on the casework equivalent: nine transactions for a row of
 * badges is what a small pooler server pool cannot serve, and three is.
 */
export interface EvidenceTabCounts {
  evidence: number;
  evidenceConcerns: number;
  documents: number;
  documentsAwaitingApproval: number;
}

export interface EvidenceRepository {
  /** Tab-bar counts for evidence and documents together, in one round trip. */
  tabCounts(caseId: string): Promise<EvidenceTabCounts>;

  list(filter: ListEvidenceFilter): Promise<Page<EvidenceItem>>;
  findById(id: string): Promise<EvidenceItem | null>;
  findByEvidenceId(evidenceId: string): Promise<EvidenceItem | null>;

  /**
   * Registers an item and its first custody event in one transaction.
   *
   * The two belong together: an item with no custody record has a chain that
   * starts nowhere, and PRD 6.2 makes registration itself an event.
   */
  register(input: RegisterEvidenceInput): Promise<EvidenceItem>;

  update(
    id: string,
    input: {
      description?: string;
      exhibitNo?: string | null;
      evidenceType?: EvidenceType;
      classification?: ClassificationLevel;
      sourceId?: string | null;
      collectionLocation?: string;
      collectionMethod?: string;
    },
    expectedVersion: number,
  ): Promise<EvidenceItem>;

  /**
   * Records the file a browser has just uploaded, with its declared hash.
   *
   * The item moves to `hash_unverified`: the server has not yet seen the
   * object. Nothing here trusts the declared hash.
   */
  attachFile(id: string, input: AttachFileInput): Promise<EvidenceItem>;

  /**
   * Records the server's own hash of the stored object, which decides whether
   * the item is verified or a mismatch, and writes an integrity check either
   * way (PRD 6.3).
   */
  recordVerification(input: {
    id: string;
    computedSha256: string | null;
    result: "match" | "mismatch" | "unreadable";
    notes?: string | null;
  }): Promise<EvidenceItem>;

  setStatus(input: {
    id: string;
    status: EvidenceStatus;
    custodian?: string | null;
  }): Promise<EvidenceItem>;

  softDelete(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;

  integrityChecks(id: string): Promise<IntegrityCheck[]>;

  summary(filter: { caseId?: string }): Promise<{
    total: number;
    originals: number;
    workingCopies: number;
    awaitingVerification: number;
    mismatched: number;
    released: number;
  }>;
}

export interface CustodyRepository {
  /** The ledger for one item, oldest first: a chain reads forwards. */
  events(evidenceItemId: string): Promise<CustodyEvent[]>;

  record(input: {
    evidenceItemId: string;
    eventType: CustodyEventType;
    occurredAt?: string | null;
    releasedBy?: string | null;
    receivedBy?: string | null;
    purpose: string;
    location?: string | null;
    condition?: string | null;
    confirmation?: string | null;
  }): Promise<CustodyEvent>;

  /**
   * Corrects an earlier event by recording a new one that points at it.
   *
   * There is no update and no delete here, by design: the table refuses both
   * and no policy would let the application reach the trigger.
   */
  correct(input: {
    correctsEventId: string;
    correctionReason: string;
    eventType: CustodyEventType;
    occurredAt?: string | null;
    releasedBy?: string | null;
    receivedBy?: string | null;
    purpose: string;
    location?: string | null;
    condition?: string | null;
    confirmation?: string | null;
  }): Promise<CustodyEvent>;

  findEventById(id: string): Promise<CustodyEvent | null>;

  /** Walks the hash chain for one item and says whether it holds. */
  verifyChain(evidenceItemId: string): Promise<{
    events: number;
    intact: boolean;
    brokeAt: string | null;
  }>;
}

/* ------------------------------------------------------------- documents */

export interface ListDocumentsFilter {
  caseId?: string;
  folderId?: string;
  search?: string;
  documentType?: DocumentType;
  tag?: string;
  approvedOnly?: boolean;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface DocumentRepository {
  folders(caseId: string): Promise<CaseFolder[]>;

  list(filter: ListDocumentsFilter): Promise<Page<CaseDocument>>;
  findById(id: string): Promise<CaseDocument | null>;
  versions(documentId: string): Promise<DocumentVersion[]>;

  /**
   * Creates the document and its first version together.
   *
   * A document with no version is a title with no file, which no screen can
   * usefully show and no report can cite.
   */
  create(input: {
    caseId: string;
    folderId?: string | null;
    title: string;
    documentType: DocumentType;
    classification: ClassificationLevel;
    relatedSourceId?: string | null;
    relatedEvidenceId?: string | null;
    relatedTaskId?: string | null;
    tags?: string[];
    version: {
      versionLabel: string;
      changeNote?: string | null;
      fileName: string;
      mimeType: string;
      fileSize: number;
      sha256: string;
      storageBucket: string;
      storagePath: string;
    };
  }): Promise<CaseDocument>;

  update(
    id: string,
    input: {
      title?: string;
      folderId?: string | null;
      documentType?: DocumentType;
      classification?: ClassificationLevel;
      relatedSourceId?: string | null;
      relatedEvidenceId?: string | null;
      relatedTaskId?: string | null;
      tags?: string[];
    },
    expectedVersion: number,
  ): Promise<CaseDocument>;

  /** Adds the next version and makes it current (PRD 7.2). */
  addVersion(input: {
    documentId: string;
    versionLabel: string;
    changeNote?: string | null;
    fileName: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
    storageBucket: string;
    storagePath: string;
  }): Promise<DocumentVersion>;

  /**
   * Approves a version, which locks it and becomes the document's approved
   * version. Whether the actor may approve it is the domain's business.
   */
  approveVersion(versionId: string): Promise<DocumentVersion>;

  softDelete(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;

  /** The shared tag vocabulary. */
  tags(): Promise<Array<{ key: string; name: string }>>;
  upsertTag(key: string, name: string): Promise<void>;

  summary(filter: { caseId?: string }): Promise<{
    total: number;
    approved: number;
    drafts: number;
    byFolder: Array<{ folderId: string; documents: number }>;
  }>;
}

import type { ClassificationLevel } from "@/modules/iam/domain/classification";
import type {
  Client,
  ClientContact,
  ClientDocument,
  ClientStatus,
  ClientType,
  ConflictCandidate,
  ConflictCheck,
  ConflictDecision,
  DocumentType,
  Engagement,
  EngagementStatus,
  EngagementType,
  Enquiry,
  EnquiryChannel,
  EnquiryStatus,
  KycCheckType,
  KycOutcome,
  KycRecord,
  RiskRating,
  UrgencyLevel,
} from "../domain/types";

/**
 * What the CRM use cases need from the outside world.
 *
 * Same shape as the IAM module's ports: interfaces only, implemented in
 * ../infrastructure and wired in the module's index.ts.
 */

export interface Page<T> {
  rows: T[];
  total: number;
}

/* ----------------------------------------------------------------- clients */

export interface ListClientsFilter {
  search?: string;
  status?: ClientStatus | "all";
  clientType?: ClientType;
  kycStatus?: string;
  riskRating?: RiskRating;
  accountManagerId?: string;
  countryCode?: string;
  officeId?: string;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
  sort?: "name" | "created" | "risk" | "kyc" | "status";
  direction?: "asc" | "desc";
}

export interface CreateClientInput {
  organisationName: string;
  clientType: ClientType;
  contactPerson?: string | null;
  position?: string | null;
  telephone?: string | null;
  email?: string | null;
  address?: string | null;
  countryCode?: string | null;
  officeId?: string | null;
  industry?: string | null;
  riskRating: RiskRating;
  accountManagerId?: string | null;
  dateOnboarded?: string | null;
  status: ClientStatus;
  classification: ClassificationLevel;
  notes?: string | null;
}

export type UpdateClientInput = Partial<CreateClientInput> & {
  /** Optimistic concurrency (PRD 21.7). */
  expectedVersion: number;
};

export interface ClientRepository {
  list(filter: ListClientsFilter): Promise<Page<Client>>;
  findById(id: string): Promise<Client | null>;
  /** Looks a client up by its CLI-YYYY-NNNNNN identifier. */
  findByReference(reference: string): Promise<Client | null>;
  create(input: CreateClientInput): Promise<Client>;
  update(id: string, input: UpdateClientInput): Promise<Client>;
  setStatus(id: string, status: ClientStatus, reason: string): Promise<Client>;
  softDelete(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;

  contacts(clientId: string): Promise<ClientContact[]>;
  addContact(input: {
    clientId: string;
    fullName: string;
    position?: string | null;
    email?: string | null;
    telephone?: string | null;
    isPrimary?: boolean;
    notes?: string | null;
  }): Promise<ClientContact>;
  updateContact(
    id: string,
    input: {
      fullName?: string;
      position?: string | null;
      email?: string | null;
      telephone?: string | null;
      isPrimary?: boolean;
      notes?: string | null;
      expectedVersion: number;
    },
  ): Promise<ClientContact>;
  removeContact(id: string, reason: string): Promise<void>;

  documents(clientId: string): Promise<ClientDocument[]>;
  addDocument(input: {
    clientId: string;
    documentType: DocumentType;
    title: string;
    fileName?: string | null;
    mimeType?: string | null;
    fileSize?: number | null;
    sha256Hash?: string | null;
    storageKey?: string | null;
    classification: ClassificationLevel;
    expiresAt?: string | null;
  }): Promise<ClientDocument>;
  removeDocument(id: string, reason: string): Promise<void>;

  kycRecords(clientId: string): Promise<KycRecord[]>;
  addKycRecord(input: {
    clientId: string;
    checkType: KycCheckType;
    outcome: KycOutcome;
    summary?: string | null;
    evidenceDocumentId?: string | null;
    performedAt?: string | null;
    expiresAt?: string | null;
  }): Promise<KycRecord>;
  updateKycRecord(
    id: string,
    input: {
      outcome?: KycOutcome;
      summary?: string | null;
      expiresAt?: string | null;
      expectedVersion: number;
    },
  ): Promise<KycRecord>;
  /**
   * Recomputes crm.clients.kyc_status from the records and stores it.
   *
   * The derived status is the truth (see assessKyc); the column is a cache so
   * lists and filters do not have to load every record.
   */
  refreshKycStatus(clientId: string): Promise<Client>;

  /** Engagements that are neither completed nor cancelled. Gates removal. */
  activeEngagementCount(clientId: string): Promise<number>;

  /** Counts for the clients dashboard, in one round trip. */
  summary(): Promise<{
    total: number;
    active: number;
    prospects: number;
    kycOutstanding: number;
    highRisk: number;
  }>;
}

/* ------------------------------------------------------------- engagements */

export interface ListEngagementsFilter {
  search?: string;
  clientId?: string;
  status?: EngagementStatus | "all";
  engagementType?: EngagementType;
  responsibleManagerId?: string;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
  sort?: "created" | "title" | "status" | "start";
}

export interface CreateEngagementInput {
  clientId: string;
  enquiryId?: string | null;
  title: string;
  engagementType: EngagementType;
  startDate?: string | null;
  endDate?: string | null;
  contractReference?: string | null;
  ndaReference?: string | null;
  scopeOfServices?: string | null;
  commercialTerms?: string | null;
  responsibleManagerId?: string | null;
  countryCode?: string | null;
  officeId?: string | null;
  classification: ClassificationLevel;
}

export type UpdateEngagementInput = Partial<Omit<CreateEngagementInput, "clientId">> & {
  expectedVersion: number;
};

export interface EngagementRepository {
  list(filter: ListEngagementsFilter): Promise<Page<Engagement>>;
  findById(id: string): Promise<Engagement | null>;
  create(input: CreateEngagementInput): Promise<Engagement>;
  update(id: string, input: UpdateEngagementInput): Promise<Engagement>;
  /**
   * Moves an engagement along its state machine.
   *
   * The caller has already applied the domain rules; this records the change
   * and its reason, and stamps the approver when the new status is `approved`.
   */
  setStatus(input: {
    id: string;
    status: EngagementStatus;
    reason: string;
    /** Set when approving, so approved_by and approved_at are recorded. */
    approve?: boolean;
  }): Promise<Engagement>;
  softDelete(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;
}

/* ------------------------------------------------- enquiries and screening */

export interface ListEnquiriesFilter {
  search?: string;
  status?: EnquiryStatus | "all";
  urgency?: UrgencyLevel;
  assignedTo?: string;
  clientId?: string;
  limit?: number;
  offset?: number;
  sort?: "received" | "urgency" | "status";
}

export interface CreateEnquiryInput {
  receivedAt?: string | null;
  receivedVia: EnquiryChannel;
  clientId?: string | null;
  prospectName?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  subject: string;
  summary?: string | null;
  requestedService?: string | null;
  urgency: UrgencyLevel;
  assignedTo?: string | null;
  countryCode?: string | null;
  officeId?: string | null;
  classification: ClassificationLevel;
}

export type UpdateEnquiryInput = Partial<CreateEnquiryInput> & {
  expectedVersion: number;
};

export interface IntakeRepository {
  listEnquiries(filter: ListEnquiriesFilter): Promise<Page<Enquiry>>;
  findEnquiry(id: string): Promise<Enquiry | null>;
  createEnquiry(input: CreateEnquiryInput): Promise<Enquiry>;
  updateEnquiry(id: string, input: UpdateEnquiryInput): Promise<Enquiry>;
  setEnquiryStatus(input: {
    id: string;
    status: EnquiryStatus;
    reason?: string | null;
  }): Promise<Enquiry>;
  assignEnquiry(id: string, userId: string | null, reason: string): Promise<Enquiry>;

  /**
   * Searches PDDC's records for potential matches on the given terms.
   *
   * Read-only, and it records nothing: it finds candidates and scores them.
   * Nothing is merged and nothing is decided (PRD 8.3).
   */
  screen(terms: string[], threshold?: number): Promise<ConflictCandidate[]>;

  /**
   * Runs a screening and stores it as a conflict check with its matches.
   *
   * Stored because the check has to be reproducible later: an engagement
   * approved on the strength of a clearance must be able to show what was
   * searched for, what came back and who decided.
   */
  recordCheck(input: {
    enquiryId?: string | null;
    engagementId?: string | null;
    clientId?: string | null;
    terms: string[];
    threshold?: number;
  }): Promise<ConflictCheck>;

  findCheck(id: string): Promise<ConflictCheck | null>;
  listChecks(filter: {
    status?: string;
    /** Narrow to one subject. Without this a client's own checks would have
     *  to be filtered out of a system-wide page, which silently loses any
     *  that fall outside it. */
    clientId?: string;
    enquiryId?: string;
    engagementId?: string;
    limit?: number;
    offset?: number;
  }): Promise<Page<ConflictCheck>>;

  /**
   * Records the manager's decision. Permitted once and only once: the
   * database enforces it with a trigger as well (migration 0019).
   */
  decideCheck(input: {
    id: string;
    decision: ConflictDecision;
    reason: string;
  }): Promise<ConflictCheck>;

  /** The most recent check covering an enquiry or an engagement. */
  latestCheckFor(subject: {
    enquiryId?: string;
    engagementId?: string;
  }): Promise<ConflictCheck | null>;

  summary(): Promise<{
    openEnquiries: number;
    awaitingConflictDecision: number;
    quoted: number;
    urgent: number;
  }>;
}

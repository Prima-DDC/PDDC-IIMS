import type { ClassificationLevel } from "@/modules/iam/shared";
import type {
  AliasType,
  CaseSubject,
  ConfidenceLevel,
  Corroboration,
  Entity,
  EntityMerge,
  EntityType,
  Finding,
  FindingLink,
  FindingLinkType,
  FindingStatus,
  Information,
  InformationCredibility,
  InformationEvidence,
  InformationVerificationStatus,
  MatchFlag,
  MatchFlagStatus,
  MatchFlagType,
  Relationship,
  RelationshipType,
  ResolutionStatus,
  Source,
  SourceReliability,
  SourceType,
  SubjectRole,
  Traceability,
  VerificationStatus,
} from "../domain/types";

/** Ports for entities, sources, information and findings (PRD 6.4, 8.4, 15). */

export interface Page<T> {
  rows: T[];
  total: number;
}

/* ------------------------------------------------------------- entities */

export interface ListEntitiesFilter {
  search?: string;
  entityType?: EntityType;
  resolutionStatus?: ResolutionStatus;
  country?: string;
  /** Entities that are a subject of this case. */
  caseId?: string;
  /** Entities with an undecided duplicate or match flag against them. */
  flaggedOnly?: boolean;
  includeMerged?: boolean;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface EntityInput {
  entityType: EntityType;
  name: string;
  registrationNo?: string | null;
  /** Stored encrypted, through intel.set_id_reference (PRD 15). */
  idReference?: string | null;
  nationality?: string | null;
  country?: string | null;
  address?: string | null;
  dateOfBirth?: string | null;
  incorporatedOn?: string | null;
  notes?: string | null;
  classification: ClassificationLevel;
}

/**
 * The case file's tab-bar counts for this module, in one query.
 *
 * See the note on the casework equivalent.
 */
export interface IntelTabCounts {
  subjects: number;
  subjectFlags: number;
  sources: number;
  information: number;
  uncorroborated: number;
  findings: number;
  findingsAwaitingReview: number;
  unsupportedFindings: number;
}

export interface EntityRepository {
  /** Tab-bar counts across this module, in one round trip. */
  tabCounts(caseId: string): Promise<IntelTabCounts>;

  list(filter: ListEntitiesFilter): Promise<Page<Entity>>;
  findById(id: string): Promise<Entity | null>;

  create(input: EntityInput): Promise<Entity>;
  update(
    id: string,
    input: Partial<EntityInput>,
    expectedVersion: number,
  ): Promise<Entity>;

  /**
   * The decrypted identity reference, which is audited every time it is read
   * (PRD 13, PRD 15). Null when none is held.
   */
  idReference(id: string): Promise<string | null>;

  softDelete(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;

  addAlias(input: {
    entityId: string;
    alias: string;
    aliasType: AliasType;
    sourceNote?: string | null;
  }): Promise<void>;
  removeAlias(aliasId: string): Promise<void>;

  /** The cases this entity appears on, and in what part. */
  subjectOf(entityId: string): Promise<CaseSubject[]>;

  /**
   * Records that are plausibly the same thing as this one (PRD 8.4).
   *
   * Name and alias similarity plus the phonetic key, which between them catch
   * "John K. Mensah" against "John Mensah" and "ABC Holdings Ghana Limited"
   * against "ABC Holdings Ltd". Never merged automatically.
   */
  findSimilar(input: {
    entityId?: string;
    name: string;
    entityType?: EntityType;
    threshold?: number;
    limit?: number;
  }): Promise<Array<{ entity: Entity; score: number; matchedOn: string }>>;

  summary(filter: { caseId?: string }): Promise<{
    total: number;
    people: number;
    companies: number;
    unresolved: number;
    openFlags: number;
  }>;
}

/* ---------------------------------------------- an entity on a case */

export interface CaseSubjectRepository {
  forCase(caseId: string, includeRemoved?: boolean): Promise<CaseSubject[]>;

  add(input: {
    caseId: string;
    entityId: string;
    subjectRole: SubjectRole;
    relationshipToCase?: string | null;
  }): Promise<CaseSubject>;

  update(
    id: string,
    input: { subjectRole?: SubjectRole; relationshipToCase?: string | null },
    expectedVersion: number,
  ): Promise<CaseSubject>;

  /** Taking a subject off a case is a state change, never a deletion. */
  remove(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;
}

/* -------------------------------------------------------- relationships */

export interface RelationshipRepository {
  /** Everything touching this entity, in either direction. */
  forEntity(entityId: string): Promise<Relationship[]>;

  /**
   * The graph around a set of entities, to the given depth (screen 10, 17).
   *
   * Depth is capped: a register of any size produces a graph nobody can read
   * past two hops, and an uncapped walk on a shared pooler connection is how
   * one screen takes the whole platform down.
   */
  graph(input: {
    entityIds: string[];
    depth?: 1 | 2;
  }): Promise<{ entities: Entity[]; relationships: Relationship[] }>;

  create(input: {
    fromEntityId: string;
    toEntityId: string;
    relationshipType: RelationshipType;
    description?: string | null;
    percentage?: number | null;
    heldFrom?: string | null;
    heldTo?: string | null;
    sourceId?: string | null;
    evidenceItemId?: string | null;
    confidence: ConfidenceLevel;
  }): Promise<Relationship>;

  update(
    id: string,
    input: {
      relationshipType?: RelationshipType;
      description?: string | null;
      percentage?: number | null;
      heldFrom?: string | null;
      heldTo?: string | null;
      sourceId?: string | null;
      evidenceItemId?: string | null;
      confidence?: ConfidenceLevel;
    },
    expectedVersion: number,
  ): Promise<Relationship>;

  softDelete(id: string, reason: string): Promise<void>;
}

/* ---------------------------------------------- resolution (PRD 8.4) */

export interface ResolutionRepository {
  flags(filter: {
    entityId?: string;
    status?: MatchFlagStatus;
    limit?: number;
  }): Promise<MatchFlag[]>;

  flag(input: {
    entityAId: string;
    entityBId: string;
    flagType: MatchFlagType;
    similarityScore?: number | null;
    detectedBy?: "manual" | "name_similarity" | "identifier" | "phonetic";
    notes?: string | null;
  }): Promise<MatchFlag>;

  decide(input: {
    flagId: string;
    status: MatchFlagStatus;
    reason: string;
  }): Promise<MatchFlag>;

  /**
   * Merges one record into another, reversibly (PRD 8.4).
   *
   * Nothing is deleted. The loser's aliases, case subjects, relationships,
   * information and finding links are reassigned to the survivor, the loser's
   * name is kept as an alias of the survivor so a search for it still finds
   * something, and everything moved is recorded so the merge can be undone.
   */
  merge(input: {
    survivingEntityId: string;
    mergedEntityId: string;
    reason: string;
  }): Promise<EntityMerge>;

  reverse(input: { mergeId: string; reason: string }): Promise<EntityMerge>;

  merges(filter: { entityId?: string; limit?: number }): Promise<EntityMerge[]>;
}

/* -------------------------------------------------------------- sources */

export interface ListSourcesFilter {
  caseId?: string;
  search?: string;
  sourceType?: SourceType;
  sourceReliability?: SourceReliability;
  verificationStatus?: VerificationStatus;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface SourceRepository {
  list(filter: ListSourcesFilter): Promise<Page<Source>>;
  findById(id: string): Promise<Source | null>;

  create(input: {
    caseId: string;
    sourceType: SourceType;
    description: string;
    dateObtained: string;
    obtainedBy: string;
    sourceReliability: SourceReliability;
    accessRestrictions?: string | null;
    identityName?: string | null;
    identityContact?: string | null;
    identityNotes?: string | null;
    classification: ClassificationLevel;
  }): Promise<Source>;

  update(
    id: string,
    input: {
      sourceType?: SourceType;
      description?: string;
      sourceReliability?: SourceReliability;
      accessRestrictions?: string | null;
      verificationStatus?: VerificationStatus;
      identityName?: string | null;
      identityContact?: string | null;
      identityNotes?: string | null;
      classification?: ClassificationLevel;
    },
    expectedVersion: number,
  ): Promise<Source>;

  softDelete(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;

  summary(filter: { caseId?: string }): Promise<{
    total: number;
    reliable: number;
    humanSources: number;
    unverified: number;
  }>;
}

/* ---------------------------------------------------------- information */

export interface ListInformationFilter {
  caseId?: string;
  sourceId?: string;
  entityId?: string;
  search?: string;
  credibility?: InformationCredibility;
  verificationStatus?: InformationVerificationStatus;
  /** Statements nothing else bears out, which is what to look at first. */
  uncorroboratedOnly?: boolean;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface InformationRepository {
  list(filter: ListInformationFilter): Promise<Page<Information>>;
  findById(id: string): Promise<Information | null>;

  create(input: {
    caseId: string;
    sourceId: string;
    dateObtained: string;
    description: string;
    informationCredibility: InformationCredibility;
    confidence: ConfidenceLevel;
    analyst?: string | null;
    entityId?: string | null;
    classification: ClassificationLevel;
  }): Promise<Information>;

  update(
    id: string,
    input: {
      description?: string;
      informationCredibility?: InformationCredibility;
      verificationStatus?: InformationVerificationStatus;
      confidence?: ConfidenceLevel;
      entityId?: string | null;
      classification?: ClassificationLevel;
    },
    expectedVersion: number,
  ): Promise<Information>;

  softDelete(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;

  corroborations(informationId: string): Promise<Corroboration[]>;
  addCorroboration(input: {
    informationId: string;
    corroboratingInformationId: string;
    note?: string | null;
  }): Promise<void>;
  removeCorroboration(id: string): Promise<void>;

  evidence(informationId: string): Promise<InformationEvidence[]>;
  linkEvidence(input: {
    informationId: string;
    evidenceItemId: string;
    note?: string | null;
  }): Promise<void>;
  unlinkEvidence(id: string): Promise<void>;

  /** How many findings rest on this, which decides whether it may be removed. */
  citedByFindings(informationId: string): Promise<number>;

  summary(filter: { caseId?: string }): Promise<{
    total: number;
    confirmed: number;
    uncorroborated: number;
    contradicted: number;
  }>;
}

/* ------------------------------------------------------------- findings */

export interface ListFindingsFilter {
  caseId?: string;
  search?: string;
  status?: FindingStatus;
  confidence?: ConfidenceLevel;
  analyst?: string;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface FindingRepository {
  list(filter: ListFindingsFilter): Promise<Page<Finding>>;
  findById(id: string): Promise<Finding | null>;

  create(input: {
    caseId: string;
    statement: string;
    detail?: string | null;
    analyst: string;
    confidence: ConfidenceLevel;
    findingDate?: string;
    classification: ClassificationLevel;
  }): Promise<Finding>;

  update(
    id: string,
    input: {
      statement?: string;
      detail?: string | null;
      confidence?: ConfidenceLevel;
      findingDate?: string;
      classification?: ClassificationLevel;
    },
    expectedVersion: number,
  ): Promise<Finding>;

  /** Puts a finding forward, or records a decision on one. */
  setStatus(input: {
    id: string;
    status: FindingStatus;
    reviewNotes?: string | null;
    reviewer?: string | null;
  }): Promise<Finding>;

  softDelete(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;

  links(findingId: string): Promise<FindingLink[]>;
  link(input: {
    findingId: string;
    linkType: FindingLinkType;
    targetId: string;
    relevance?: string | null;
  }): Promise<void>;
  unlink(linkId: string): Promise<void>;

  /** Source to Information to Evidence to Finding, for one finding (PRD 23). */
  traceability(findingId: string): Promise<Traceability | null>;

  /** What a finding rests on, for the confidence ceiling. */
  support(findingId: string): Promise<{
    information: Array<{
      credibility: InformationCredibility;
      reliability: SourceReliability;
    }>;
    evidenceCount: number;
  }>;

  summary(filter: { caseId?: string }): Promise<{
    total: number;
    accepted: number;
    awaitingReview: number;
    returned: number;
    unsupported: number;
  }>;
}

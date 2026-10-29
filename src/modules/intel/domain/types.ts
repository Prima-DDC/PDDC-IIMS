import type { ClassificationLevel } from "@/modules/iam/shared";

/**
 * Entities, sources, information and findings (PRD 6.4, 8.4, 15).
 *
 * The two vocabularies at the top are the ones to read carefully. PRD 6.4
 * rates a SOURCE's reliability and a piece of INFORMATION's credibility on
 * two different scales, and keeping them apart is most of what this module is
 * for: a reliable source can report something nobody has confirmed, and an
 * unreliable one can report something that turns out to be true. A single
 * "quality" number would lose that, and losing it is how an intelligence
 * product misleads its reader.
 */

/* ------------------------------------------------------------ entities */

export const ENTITY_TYPES = [
  "person",
  "company",
  "organisation",
  "government_body",
  "property",
  "vehicle",
  "account",
  "asset",
  "other",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  person: "Person",
  company: "Company",
  organisation: "Organisation",
  government_body: "Government body",
  property: "Property",
  vehicle: "Vehicle",
  account: "Account",
  asset: "Asset",
  other: "Other",
};

export const RESOLUTION_STATUSES = [
  "unresolved",
  "resolved",
  "merged",
  "disputed",
] as const;

export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export const RESOLUTION_STATUS_LABELS: Record<ResolutionStatus, string> = {
  unresolved: "Not yet resolved",
  resolved: "Resolved",
  merged: "Merged into another record",
  disputed: "Disputed",
};

export const ALIAS_TYPES = [
  "also_known_as",
  "former_name",
  "trading_name",
  "abbreviation",
  "transliteration",
  "misspelling",
] as const;

export type AliasType = (typeof ALIAS_TYPES)[number];

export const ALIAS_TYPE_LABELS: Record<AliasType, string> = {
  also_known_as: "Also known as",
  former_name: "Former name",
  trading_name: "Trading name",
  abbreviation: "Abbreviation",
  transliteration: "Transliteration",
  misspelling: "Misspelling seen in a record",
};

export const SUBJECT_ROLES = [
  "primary_subject",
  "secondary_subject",
  "person_of_interest",
  "witness",
  "complainant",
  "related_party",
  "client_contact",
  "other",
] as const;

export type SubjectRole = (typeof SUBJECT_ROLES)[number];

export const SUBJECT_ROLE_LABELS: Record<SubjectRole, string> = {
  primary_subject: "Primary subject",
  secondary_subject: "Secondary subject",
  person_of_interest: "Person of interest",
  witness: "Witness",
  complainant: "Complainant",
  related_party: "Related party",
  client_contact: "Client contact",
  other: "Other",
};

export const RELATIONSHIP_TYPES = [
  "director_of",
  "shareholder_of",
  "beneficial_owner_of",
  "employee_of",
  "officer_of",
  "owns",
  "subsidiary_of",
  "parent_of",
  "associated_with",
  "family_member_of",
  "spouse_of",
  "business_partner_of",
  "signatory_on",
  "resident_at",
  "registered_at",
  "other",
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const RELATIONSHIP_TYPE_LABELS: Record<RelationshipType, string> = {
  director_of: "Director of",
  shareholder_of: "Shareholder of",
  beneficial_owner_of: "Beneficial owner of",
  employee_of: "Employee of",
  officer_of: "Officer of",
  owns: "Owns",
  subsidiary_of: "Subsidiary of",
  parent_of: "Parent of",
  associated_with: "Associated with",
  family_member_of: "Family member of",
  spouse_of: "Spouse of",
  business_partner_of: "Business partner of",
  signatory_on: "Signatory on",
  resident_at: "Resident at",
  registered_at: "Registered at",
  other: "Other",
};

/**
 * The three relationship types a percentage belongs to.
 *
 * "A director of B, 40%" is either a mistake or a shareholding recorded under
 * the wrong type, and the database refuses it either way.
 */
export const HOLDING_RELATIONSHIPS: readonly RelationshipType[] = [
  "shareholder_of",
  "beneficial_owner_of",
  "owns",
];

/* -------------------------------------------- sources and information */

/**
 * PRD 6.4's left-hand column: how far what this source says can be relied on
 * in general. A property of the source, not of any one thing it said.
 */
export const SOURCE_RELIABILITIES = [
  "reliable",
  "usually_reliable",
  "unknown",
  "questionable",
  "unreliable",
] as const;

export type SourceReliability = (typeof SOURCE_RELIABILITIES)[number];

export const SOURCE_RELIABILITY_LABELS: Record<SourceReliability, string> = {
  reliable: "Reliable",
  usually_reliable: "Usually reliable",
  unknown: "Unknown",
  questionable: "Questionable",
  unreliable: "Unreliable",
};

/**
 * PRD 6.4's right-hand column: how far this particular statement is borne out.
 * A property of the information, not of the source that gave it.
 */
export const INFORMATION_CREDIBILITIES = [
  "confirmed",
  "probable",
  "possible",
  "doubtful",
  "unverified",
] as const;

export type InformationCredibility = (typeof INFORMATION_CREDIBILITIES)[number];

export const INFORMATION_CREDIBILITY_LABELS: Record<
  InformationCredibility,
  string
> = {
  confirmed: "Confirmed",
  probable: "Probable",
  possible: "Possible",
  doubtful: "Doubtful",
  unverified: "Unverified",
};

export const SOURCE_TYPES = [
  "public_registry",
  "government_record",
  "interview",
  "human_source",
  "client",
  "open_source",
  "media",
  "database",
  "corporate_filing",
  "financial_record",
  "court_record",
  "site_visit",
  "other",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  public_registry: "Public registry",
  government_record: "Government record",
  interview: "Interview",
  human_source: "Human source",
  client: "The client",
  open_source: "Open source",
  media: "Media",
  database: "Commercial database",
  corporate_filing: "Corporate filing",
  financial_record: "Financial record",
  court_record: "Court record",
  site_visit: "Site visit",
  other: "Other",
};

export const VERIFICATION_STATUSES = [
  "unverified",
  "verifying",
  "verified",
  "failed",
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  unverified: "Not verified",
  verifying: "Being verified",
  verified: "Verified",
  failed: "Verification failed",
};

export const INFORMATION_VERIFICATION_STATUSES = [
  "unverified",
  "verifying",
  "verified",
  "contradicted",
] as const;

export type InformationVerificationStatus =
  (typeof INFORMATION_VERIFICATION_STATUSES)[number];

export const INFORMATION_VERIFICATION_LABELS: Record<
  InformationVerificationStatus,
  string
> = {
  unverified: "Not verified",
  verifying: "Being verified",
  verified: "Verified",
  contradicted: "Contradicted",
};

/**
 * The analyst's judgement of what something is worth, given everything else
 * known. Not the same as credibility: a probable statement from a usually
 * reliable source can still be worth little if it contradicts three things
 * that are confirmed.
 */
export const CONFIDENCE_LEVELS = ["high", "moderate", "low", "unverified"] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  high: "High",
  moderate: "Moderate",
  low: "Low",
  unverified: "Unverified",
};

/* ------------------------------------------------------------ findings */

export const FINDING_STATUSES = [
  "draft",
  "submitted",
  "accepted",
  "returned",
  "withdrawn",
] as const;

export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FINDING_STATUS_LABELS: Record<FindingStatus, string> = {
  draft: "Draft",
  submitted: "Awaiting review",
  accepted: "Accepted",
  returned: "Returned for more work",
  withdrawn: "Withdrawn",
};

export const FINDING_LINK_TYPES = [
  "information",
  "evidence",
  "document",
  "entity",
] as const;

export type FindingLinkType = (typeof FINDING_LINK_TYPES)[number];

export const FINDING_LINK_TYPE_LABELS: Record<FindingLinkType, string> = {
  information: "Information",
  evidence: "Evidence",
  document: "Document",
  entity: "Subject",
};

/* ----------------------------------------------- entity resolution (8.4) */

export const MATCH_FLAG_TYPES = ["potential_duplicate", "potential_match"] as const;

export type MatchFlagType = (typeof MATCH_FLAG_TYPES)[number];

export const MATCH_FLAG_TYPE_LABELS: Record<MatchFlagType, string> = {
  potential_duplicate: "Potential duplicate",
  potential_match: "Potential match",
};

export const MATCH_FLAG_STATUSES = [
  "open",
  "same_entity",
  "different_entities",
  "undecided",
] as const;

export type MatchFlagStatus = (typeof MATCH_FLAG_STATUSES)[number];

export const MATCH_FLAG_STATUS_LABELS: Record<MatchFlagStatus, string> = {
  open: "Awaiting a decision",
  same_entity: "The same thing",
  different_entities: "Different things",
  undecided: "Could not be decided",
};

/* --------------------------------------------------------------- records */

export interface Entity {
  id: string;
  entityId: string;
  entityType: EntityType;
  name: string;
  normalisedName: string;
  registrationNo: string | null;
  /** The last four characters of the identity reference, in clear. */
  idReferenceHint: string | null;
  hasIdReference: boolean;
  nationality: string | null;
  nationalityName: string | null;
  country: string | null;
  countryName: string | null;
  address: string | null;
  dateOfBirth: string | null;
  incorporatedOn: string | null;
  notes: string | null;
  resolutionStatus: ResolutionStatus;
  mergedIntoId: string | null;
  mergedIntoReference: string | null;
  classification: ClassificationLevel;
  aliases: EntityAlias[];
  /** How many cases this entity appears on, which is the register's value. */
  caseCount: number;
  openMatchFlags: number;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
}

export interface EntityAlias {
  id: string;
  entityId: string;
  alias: string;
  aliasType: AliasType;
  sourceNote: string | null;
}

export interface CaseSubject {
  id: string;
  caseId: string;
  caseReference: string;
  entityId: string;
  entityReference: string;
  entityName: string;
  entityType: EntityType;
  entityClassification: ClassificationLevel;
  subjectRole: SubjectRole;
  relationshipToCase: string | null;
  removedAt: string | null;
  removalReason: string | null;
  createdAt: string;
  createdByName: string | null;
  version: number;
}

export interface Relationship {
  id: string;
  fromEntityId: string;
  fromEntityName: string;
  fromEntityReference: string;
  toEntityId: string;
  toEntityName: string;
  toEntityReference: string;
  relationshipType: RelationshipType;
  description: string | null;
  percentage: number | null;
  heldFrom: string | null;
  heldTo: string | null;
  sourceId: string | null;
  sourceReference: string | null;
  evidenceItemId: string | null;
  evidenceReference: string | null;
  confidence: ConfidenceLevel;
  createdAt: string;
  createdByName: string | null;
  version: number;
  deletedAt: string | null;
}

export interface MatchFlag {
  id: string;
  entityAId: string;
  entityAName: string;
  entityAReference: string;
  entityBId: string;
  entityBName: string;
  entityBReference: string;
  flagType: MatchFlagType;
  similarityScore: number | null;
  detectedBy: "manual" | "name_similarity" | "identifier" | "phonetic";
  notes: string | null;
  status: MatchFlagStatus;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
  version: number;
}

export interface EntityMerge {
  id: string;
  survivingEntityId: string;
  survivingEntityReference: string;
  survivingEntityName: string;
  mergedEntityId: string;
  mergedEntityReference: string;
  mergedEntityName: string;
  reason: string;
  moved: {
    aliases?: number;
    caseSubjects?: number;
    relationshipsFrom?: number;
    relationshipsTo?: number;
    information?: number;
    findingLinks?: number;
    nameAsAlias?: string;
  };
  mergedBy: string;
  mergedByName: string | null;
  mergedAt: string;
  reversedAt: string | null;
  reversedByName: string | null;
  reversalReason: string | null;
}

export interface Source {
  id: string;
  sourceId: string;
  caseId: string;
  caseReference: string;
  sourceType: SourceType;
  description: string;
  dateObtained: string;
  obtainedBy: string;
  obtainedByName: string | null;
  sourceReliability: SourceReliability;
  accessRestrictions: string | null;
  verificationStatus: VerificationStatus;
  identityRestricted: boolean;
  /**
   * Null for anybody who may not see it, which is not the same as the source
   * having no identity recorded. `identityWithheld` says which it is.
   */
  identityName: string | null;
  identityContact: string | null;
  identityNotes: string | null;
  identityWithheld: boolean;
  classification: ClassificationLevel;
  informationCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
}

export interface Information {
  id: string;
  informationId: string;
  caseId: string;
  caseReference: string;
  sourceId: string;
  sourceReference: string;
  sourceDescription: string;
  sourceType: SourceType;
  /** Shown beside the credibility, never merged with it (PRD 6.4). */
  sourceReliability: SourceReliability;
  dateObtained: string;
  description: string;
  informationCredibility: InformationCredibility;
  verificationStatus: InformationVerificationStatus;
  confidence: ConfidenceLevel;
  analyst: string | null;
  analystName: string | null;
  entityId: string | null;
  entityName: string | null;
  entityReference: string | null;
  classification: ClassificationLevel;
  corroborationCount: number;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
}

export interface Corroboration {
  id: string;
  informationId: string;
  corroboratingInformationId: string;
  corroboratingReference: string;
  corroboratingDescription: string;
  corroboratingSourceReference: string;
  corroboratingSourceReliability: SourceReliability;
  note: string | null;
  createdAt: string;
}

export interface InformationEvidence {
  id: string;
  informationId: string;
  evidenceItemId: string;
  evidenceReference: string;
  evidenceDescription: string;
  note: string | null;
  createdAt: string;
}

export interface Finding {
  id: string;
  findingId: string;
  caseId: string;
  caseReference: string;
  statement: string;
  detail: string | null;
  analyst: string;
  analystName: string | null;
  confidence: ConfidenceLevel;
  findingDate: string;
  status: FindingStatus;
  reviewer: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  classification: ClassificationLevel;
  links: FindingLink[];
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
}

export interface FindingLink {
  id: string;
  findingId: string;
  linkType: FindingLinkType;
  informationId: string | null;
  evidenceItemId: string | null;
  documentId: string | null;
  entityId: string | null;
  /** The human identifier of whatever this points at. */
  targetReference: string;
  /** A line a reader can recognise the target by. */
  targetLabel: string;
  relevance: string | null;
  createdAt: string;
}

/**
 * The traceability strip (PRD 23, screen 17).
 *
 * Source to Information to Evidence to Finding, as one finding's worth of it.
 * Assembled by the repository because it crosses four tables, and shown on
 * every finding because a conclusion whose support cannot be walked back to
 * is a conclusion nobody can defend.
 */
export interface TraceabilityHop {
  kind: "source" | "information" | "evidence" | "document" | "entity";
  id: string;
  reference: string;
  label: string;
  /** The rating that belongs to this kind of hop, where it has one. */
  rating: string | null;
  href: string;
}

export interface Traceability {
  findingId: string;
  findingReference: string;
  hops: TraceabilityHop[];
  /** True when nothing supports the finding at all. */
  unsupported: boolean;
}

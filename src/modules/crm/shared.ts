/**
 * The client-safe half of the CRM module.
 *
 * Types, vocabularies and pure rules only: no "server-only" marker, no
 * database client, so a client component can import this without pulling
 * postgres into the browser bundle.
 *
 * Client components import from "@/modules/crm/shared"; server code imports
 * from "@/modules/crm", which re-exports everything here.
 */

export {
  CLIENT_STATUS_LABELS,
  CLIENT_STATUSES,
  CLIENT_TYPE_LABELS,
  CLIENT_TYPES,
  CONFLICT_DECISION_LABELS,
  CONFLICT_DECISIONS,
  CONFLICT_STATUS_LABELS,
  CONFLICT_STATUSES,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPES,
  ENGAGEMENT_STATUS_LABELS,
  ENGAGEMENT_STATUSES,
  ENGAGEMENT_TYPE_LABELS,
  ENGAGEMENT_TYPES,
  ENQUIRY_CHANNEL_LABELS,
  ENQUIRY_CHANNELS,
  ENQUIRY_STATUS_LABELS,
  ENQUIRY_STATUSES,
  KYC_CHECK_LABELS,
  KYC_CHECK_TYPES,
  KYC_OUTCOME_LABELS,
  KYC_OUTCOMES,
  KYC_STATUS_LABELS,
  KYC_STATUSES,
  RISK_RATING_LABELS,
  RISK_RATINGS,
  URGENCY_LABELS,
  URGENCY_LEVELS,
  enquiryParty,
  type Client,
  type ClientContact,
  type ClientDocument,
  type ClientStatus,
  type ClientType,
  type ConflictCandidate,
  type ConflictCheck,
  type ConflictDecision,
  type ConflictMatch,
  type ConflictStatus,
  type DocumentType,
  type Engagement,
  type EngagementStatus,
  type EngagementType,
  type Enquiry,
  type EnquiryChannel,
  type EnquiryStatus,
  type KycCheckType,
  type KycOutcome,
  type KycRecord,
  type KycStatus,
  type RiskRating,
  type UrgencyLevel,
} from "./domain/types";

export {
  CRM_ERROR_STATUS,
  CrmError,
  isCrmError,
  type CrmErrorCode,
} from "./domain/errors";

export {
  KYC_BASELINE_CHECKS,
  KYC_ENHANCED_CHECKS,
  allowedEngagementTransitions,
  allowedEnquiryTransitions,
  assertClientRemovable,
  assertConflictDecidable,
  assertDeclineReason,
  assertDecisionReason,
  assertEngagementApprovable,
  assertEngagementDates,
  assertEngagementRemovable,
  assertEngagementTransition,
  assertEnquiryTransition,
  assessKyc,
  canTransitionEngagement,
  canTransitionEnquiry,
  matchStrength,
  matchSummary,
  requiredKycChecks,
  screeningTerms,
  type KycAssessment,
  type MatchStrength,
} from "./domain/policies";

import type {
  CheckIn,
  CheckInEvent,
  Incident,
  IncidentStatus,
  IncidentType,
  SafetyPlan,
  SiteRiskLevel,
} from "../domain/types";
import type { ClassificationLevel } from "@/modules/iam/shared";
import type { Page } from "./ports";

/** Ports for investigator safety (PRD 5.8). */

export interface SafetyPlanInput {
  location: string;
  siteVisitRisk: SiteRiskLevel;
  knownHazards?: string | null;
  safetyInstructions?: string | null;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactNote?: string | null;
  checkInFrequencyHours?: number | null;
  checkInInstructions?: string | null;
  isActive?: boolean;
}

export interface ListCheckInsFilter {
  caseId?: string;
  userId?: string;
  /** Only the latest event per person, which is what "who is out there" needs. */
  latestPerUser?: boolean;
  overdueOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListIncidentsFilter {
  caseId?: string;
  status?: IncidentStatus | "all";
  openOnly?: boolean;
  severity?: SiteRiskLevel;
  incidentType?: IncidentType;
  affectedUserId?: string;
  limit?: number;
  offset?: number;
}

export interface SafetyRepository {
  /* ------------------------------------------------------------- plans */

  planForCase(caseId: string): Promise<SafetyPlan | null>;
  savePlan(caseId: string, input: SafetyPlanInput): Promise<SafetyPlan>;
  updatePlan(
    id: string,
    input: Partial<SafetyPlanInput>,
    expectedVersion: number,
  ): Promise<SafetyPlan>;

  /* ---------------------------------------------------------- check-ins */

  /**
   * Records a check-in or check-out.
   *
   * Insert only: the table refuses UPDATE and DELETE, and `nextDueAt` is
   * computed by the caller from the plan as it stands now, so a later change
   * to the schedule cannot make a past check-in late.
   */
  recordCheckIn(input: {
    caseId: string;
    userId: string;
    event: CheckInEvent;
    occurredAt?: string | null;
    location?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    nextDueAt?: string | null;
    isSafe?: boolean;
    notes?: string | null;
  }): Promise<CheckIn>;

  listCheckIns(filter: ListCheckInsFilter): Promise<Page<CheckIn>>;

  /** The latest event for one person on one case, to compute what is due. */
  latestCheckIn(caseId: string, userId: string): Promise<CheckIn | null>;

  /* ---------------------------------------------------------- incidents */

  listIncidents(filter: ListIncidentsFilter): Promise<Page<Incident>>;
  findIncidentById(id: string): Promise<Incident | null>;

  reportIncident(input: {
    caseId: string;
    occurredAt: string;
    incidentType: IncidentType;
    severity: SiteRiskLevel;
    location?: string | null;
    description: string;
    immediateAction?: string | null;
    injuries?: boolean;
    injuryDetail?: string | null;
    policeNotified?: boolean;
    policeReference?: string | null;
    affectedUserId?: string | null;
    classification: ClassificationLevel;
  }): Promise<Incident>;

  updateIncident(
    id: string,
    input: {
      occurredAt?: string;
      incidentType?: IncidentType;
      severity?: SiteRiskLevel;
      location?: string | null;
      description?: string;
      immediateAction?: string | null;
      injuries?: boolean;
      injuryDetail?: string | null;
      policeNotified?: boolean;
      policeReference?: string | null;
      affectedUserId?: string | null;
      classification?: ClassificationLevel;
    },
    expectedVersion: number,
  ): Promise<Incident>;

  setIncidentStatus(input: {
    id: string;
    status: IncidentStatus;
    resolution?: string | null;
  }): Promise<Incident>;

  /** Counts for the safety panel and the field screen. */
  safetySummary(filter: { caseId?: string }): Promise<{
    openIncidents: number;
    criticalIncidents: number;
    peopleOut: number;
    overdueCheckIns: number;
  }>;
}

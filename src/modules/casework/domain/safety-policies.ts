import { CaseworkError } from "./errors";
import type { CheckIn, Incident, IncidentStatus, SafetyPlan } from "./types";

/**
 * Investigator safety rules (PRD 5.8).
 *
 * Pure functions, no imports beyond this folder, so every rule here is
 * testable without a database and is the same rule wherever it is applied.
 *
 * The database holds the same constraints as CHECK clauses. That is not
 * duplication for its own sake: a constraint cannot explain itself to
 * somebody filling in a form, and a policy in TypeScript cannot stop a
 * careless script. Each covers what the other cannot.
 */

/** A check-in schedule nobody knows how to follow is not a schedule. */
export function assertSafetySchedule(
  frequencyHours: number | null | undefined,
  instructions: string | null | undefined,
): void {
  if (frequencyHours === null || frequencyHours === undefined) return;

  if (frequencyHours < 1 || frequencyHours > 168) {
    throw new CaseworkError(
      "validation_failed",
      "A check-in interval has to be between 1 hour and a week.",
    );
  }
  if ((instructions ?? "").trim().length === 0) {
    throw new CaseworkError(
      "validation_failed",
      "Say how to check in. A schedule nobody knows how to follow is not a schedule.",
    );
  }
}

/**
 * When the next check-in falls due.
 *
 * Checking out ends the schedule, so it has no next due time: somebody who
 * has left the site is not late for anything. The interval is read from the
 * plan as it stands when the check-in happens, and the caller stores the
 * result, so a later change to the schedule cannot retrospectively make a
 * past check-in late.
 */
export function nextCheckInDue(
  plan: Pick<SafetyPlan, "checkInFrequencyHours" | "isActive"> | null,
  event: "check_in" | "check_out",
  occurredAt: string,
): string | null {
  if (event === "check_out") return null;
  if (!plan || !plan.isActive || plan.checkInFrequencyHours === null) return null;

  const at = new Date(occurredAt);
  if (Number.isNaN(at.getTime())) return null;

  return new Date(
    at.getTime() + plan.checkInFrequencyHours * 60 * 60 * 1000,
  ).toISOString();
}

/** A check-in that reports trouble has to say what the trouble is. */
export function assertCheckInNote(
  isSafe: boolean,
  notes: string | null | undefined,
): void {
  if (isSafe) return;
  if ((notes ?? "").trim().length >= 5) return;

  throw new CaseworkError(
    "validation_failed",
    "Say what is wrong. A check-in that reports trouble and nothing else cannot be acted on.",
  );
}

/**
 * Whether somebody is late, and by how much.
 *
 * Takes the clock as an argument rather than reading it, so the rule is
 * testable and so a caller that has a database clock in hand can pass it.
 */
export function checkInLateness(
  latest: Pick<CheckIn, "event" | "nextDueAt"> | null,
  now: Date,
): { isOverdue: boolean; minutesLate: number | null } {
  if (!latest || latest.event === "check_out" || latest.nextDueAt === null) {
    return { isOverdue: false, minutesLate: null };
  }

  const due = new Date(latest.nextDueAt).getTime();
  if (Number.isNaN(due)) return { isOverdue: false, minutesLate: null };

  const minutes = Math.floor((now.getTime() - due) / 60_000);
  return minutes > 0
    ? { isOverdue: true, minutesLate: minutes }
    : { isOverdue: false, minutesLate: null };
}

/** An incident report that says somebody was hurt has to say how. */
export function assertInjuryDetail(
  injuries: boolean,
  detail: string | null | undefined,
): void {
  if (!injuries) return;
  if ((detail ?? "").trim().length > 0) return;

  throw new CaseworkError(
    "validation_failed",
    "Say what the injuries were.",
  );
}

/** A police reference with no police notification is a contradiction. */
export function assertPoliceReference(
  notified: boolean,
  reference: string | null | undefined,
): void {
  if (notified) return;
  if ((reference ?? "").trim().length === 0) return;

  throw new CaseworkError(
    "validation_failed",
    "There is a police reference but the report says the police were not notified. Fix one or the other.",
  );
}

const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ["under_review", "closed"],
  under_review: ["open", "closed"],
  // Reopening a closed incident is deliberately not offered: a new incident
  // referencing it is a clearer record than one that closed and reopened.
  closed: [],
};

export function allowedIncidentTransitions(
  from: IncidentStatus,
): readonly IncidentStatus[] {
  return INCIDENT_TRANSITIONS[from];
}

export function assertIncidentTransition(
  from: IncidentStatus,
  to: IncidentStatus,
): void {
  if (from === to) {
    throw new CaseworkError(
      "illegal_transition",
      "The incident is already at that status.",
    );
  }
  if (!INCIDENT_TRANSITIONS[from].includes(to)) {
    throw new CaseworkError(
      "illegal_transition",
      from === "closed"
        ? "A closed incident stays closed. If something further happened, report it as a new incident referring to this one."
        : `An incident that is ${from.replace(/_/g, " ")} can only move to: ${INCIDENT_TRANSITIONS[
            from
          ]
            .map((s) => s.replace(/_/g, " "))
            .join(", ")}.`,
      { from, to },
    );
  }
}

/** Closing an incident needs a resolution somebody can read. */
export function assertIncidentResolution(
  to: IncidentStatus,
  resolution: string | null | undefined,
): void {
  if (to !== "closed") return;
  if ((resolution ?? "").trim().length >= 10) return;

  throw new CaseworkError(
    "validation_failed",
    "Say how the incident was resolved, in at least 10 characters. A closed incident with no resolution teaches nobody anything.",
  );
}

/**
 * PRD 16: authors cannot approve their own work, applied to incidents.
 *
 * Whoever an incident happened to is the last person who should be deciding
 * it is resolved, and the person who reported it is not much better.
 */
export function assertIncidentClosableBy(
  incident: Pick<Incident, "affectedUserId" | "reportedBy" | "incidentId">,
  actorId: string,
): void {
  if (incident.affectedUserId === actorId) {
    throw new CaseworkError(
      "self_approval_forbidden",
      `${incident.incidentId} happened to you, so somebody else has to close it.`,
    );
  }
  if (incident.reportedBy === actorId) {
    throw new CaseworkError(
      "self_approval_forbidden",
      `You reported ${incident.incidentId}, so somebody else has to close it.`,
    );
  }
}

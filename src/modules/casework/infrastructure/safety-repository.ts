import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { CaseworkError } from "../domain/errors";
import type { CheckIn, Incident, SafetyPlan } from "../domain/types";
import type {
  ListCheckInsFilter,
  ListIncidentsFilter,
  SafetyPlanInput,
  SafetyRepository,
} from "../application/safety-ports";
import type { Page } from "../application/ports";

/**
 * Investigator safety (PRD 5.8).
 *
 * The three tables here have three different attitudes to change, and the
 * repository keeps them:
 *
 *   The plan is edited, with optimistic concurrency.
 *   A check-in is inserted and never touched again. There is no update and no
 *   delete method, because the table refuses both and no policy would let the
 *   application reach the trigger.
 *   An incident is edited through a lifecycle.
 *
 * Whether somebody is late is computed in SQL against the database's clock,
 * not this process's. Two reasons: the machine rendering a page may be in
 * another region, and a "minutes late" that disagrees between two screens of
 * the same platform is worse than no number at all.
 */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

/* -------------------------------------------------------------- plans */

interface PlanRow {
  id: string;
  case_id: string;
  location: string;
  site_visit_risk: SafetyPlan["siteVisitRisk"];
  known_hazards: string | null;
  safety_instructions: string | null;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  emergency_contact_note: string | null;
  check_in_frequency_hours: number | null;
  check_in_instructions: string | null;
  is_active: boolean;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  version: number;
}

function toPlan(row: PlanRow): SafetyPlan {
  return {
    id: row.id,
    caseId: row.case_id,
    location: row.location,
    siteVisitRisk: row.site_visit_risk,
    knownHazards: row.known_hazards,
    safetyInstructions: row.safety_instructions,
    emergencyContactName: row.emergency_contact_name,
    emergencyContactPhone: row.emergency_contact_phone,
    emergencyContactNote: row.emergency_contact_note,
    checkInFrequencyHours:
      row.check_in_frequency_hours === null
        ? null
        : Number(row.check_in_frequency_hours),
    checkInInstructions: row.check_in_instructions,
    isActive: row.is_active,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function planAuditShape(row: PlanRow) {
  return {
    location: row.location,
    siteVisitRisk: row.site_visit_risk,
    knownHazards: row.known_hazards,
    emergencyContactName: row.emergency_contact_name,
    emergencyContactPhone: row.emergency_contact_phone,
    checkInFrequencyHours: row.check_in_frequency_hours,
    isActive: row.is_active,
  };
}

/* ----------------------------------------------------------- check-ins */

interface CheckInRow {
  id: string;
  check_in_id: string;
  case_id: string;
  case_reference: string;
  user_id: string;
  user_name: string | null;
  event: CheckIn["event"];
  occurred_at: string;
  location: string | null;
  latitude: string | null;
  longitude: string | null;
  next_due_at: string | null;
  is_safe: boolean;
  notes: string | null;
  recorded_at: string;
  recorded_by: string | null;
  recorded_by_name: string | null;
  minutes_late: string | null;
  seq: string;
}

function toCheckIn(row: CheckInRow): CheckIn {
  const late = row.minutes_late === null ? null : Number(row.minutes_late);
  return {
    id: row.id,
    checkInId: row.check_in_id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    userId: row.user_id,
    userName: row.user_name,
    event: row.event,
    occurredAt: row.occurred_at,
    location: row.location,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    nextDueAt: row.next_due_at,
    isSafe: row.is_safe,
    notes: row.notes,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
    recordedByName: row.recorded_by_name,
    isOverdue: late !== null && late > 0,
    minutesLate: late !== null && late > 0 ? late : null,
  };
}

/**
 * The projection every check-in read shares.
 *
 * `minutes_late` is only meaningful for a check-in that is still the latest
 * event for that person on that case: a check-in from Tuesday is not late, it
 * is superseded. The window function decides that in the same query rather
 * than leaving the caller to work it out and get it wrong.
 */
const CHECK_IN_SELECT = (sql: postgres.TransactionSql) => sql`
  select ci.*,
         c.case_id as case_reference,
         dir.full_name as user_name,
         rec.full_name as recorded_by_name,
         case
           when ci.event = 'check_out' or ci.next_due_at is null then null
           when row_number() over (
             partition by ci.case_id, ci.user_id order by ci.occurred_at desc, ci.seq desc
           ) > 1 then null
           else floor(extract(epoch from (now() - ci.next_due_at)) / 60)
         end as minutes_late
  from casework.check_ins ci
  join casework.cases c on c.id = ci.case_id
  left join directory dir on dir.user_id = ci.user_id
  left join directory rec on rec.user_id = ci.recorded_by
`;

/* ----------------------------------------------------------- incidents */

interface IncidentRow {
  id: string;
  incident_id: string;
  case_id: string;
  case_reference: string;
  occurred_at: string;
  incident_type: Incident["incidentType"];
  severity: Incident["severity"];
  location: string | null;
  description: string;
  immediate_action: string | null;
  injuries: boolean;
  injury_detail: string | null;
  police_notified: boolean;
  police_reference: string | null;
  affected_user_id: string | null;
  affected_user_name: string | null;
  status: Incident["status"];
  resolution: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  classification: Incident["classification"];
  reported_at: string;
  reported_by: string | null;
  reported_by_name: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    incidentId: row.incident_id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    occurredAt: row.occurred_at,
    incidentType: row.incident_type,
    severity: row.severity,
    location: row.location,
    description: row.description,
    immediateAction: row.immediate_action,
    injuries: row.injuries,
    injuryDetail: row.injury_detail,
    policeNotified: row.police_notified,
    policeReference: row.police_reference,
    affectedUserId: row.affected_user_id,
    affectedUserName: row.affected_user_name,
    status: row.status,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolvedByName: row.resolved_by_name,
    classification: row.classification,
    reportedAt: row.reported_at,
    reportedBy: row.reported_by,
    reportedByName: row.reported_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function incidentAuditShape(row: IncidentRow) {
  return {
    incidentType: row.incident_type,
    severity: row.severity,
    status: row.status,
    injuries: row.injuries,
    policeNotified: row.police_notified,
    classification: row.classification,
  };
}

const INCIDENT_SELECT = (sql: postgres.TransactionSql) => sql`
  select i.*,
         c.case_id as case_reference,
         aff.full_name as affected_user_name,
         res.full_name as resolved_by_name,
         rep.full_name as reported_by_name
  from casework.incidents i
  join casework.cases c on c.id = i.case_id
  left join directory aff on aff.user_id = i.affected_user_id
  left join directory res on res.user_id = i.resolved_by
  left join directory rep on rep.user_id = i.reported_by
`;

export function createSafetyRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): SafetyRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  const loadPlan = async (
    sql: postgres.TransactionSql,
    caseId: string,
  ): Promise<SafetyPlan | null> => {
    const rows = await sql<PlanRow[]>`
      select * from casework.safety_plans where case_id = ${caseId}::uuid
    `;
    return rows.length > 0 ? toPlan(rows[0]) : null;
  };

  const loadIncident = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Incident | null> => {
    const rows = await sql<IncidentRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${INCIDENT_SELECT(sql)}
      where i.id = ${id}::uuid
    `;
    return rows.length > 0 ? toIncident(rows[0]) : null;
  };

  return {
    /* ----------------------------------------------------------- plans */

    async planForCase(caseId) {
      return tx((sql) => loadPlan(sql, caseId));
    },

    async savePlan(caseId, input: SafetyPlanInput) {
      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          insert into casework.safety_plans (
            case_id, location, site_visit_risk, known_hazards, safety_instructions,
            emergency_contact_name, emergency_contact_phone, emergency_contact_note,
            check_in_frequency_hours, check_in_instructions, is_active, created_by
          ) values (
            ${caseId}::uuid, ${input.location}, ${input.siteVisitRisk},
            ${input.knownHazards ?? null}, ${input.safetyInstructions ?? null},
            ${input.emergencyContactName}, ${input.emergencyContactPhone},
            ${input.emergencyContactNote ?? null},
            ${input.checkInFrequencyHours ?? null},
            ${input.checkInInstructions ?? null},
            ${input.isActive ?? true}, ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'safety_plan.created', 'casework.safety_plans', ${rows[0].id},
            ${caseId}::uuid, null,
            ${sql.json({
              location: input.location,
              siteVisitRisk: input.siteVisitRisk,
              checkInFrequencyHours: input.checkInFrequencyHours ?? null,
            })},
            null
          )
        `;

        const created = await loadPlan(sql, caseId);
        if (!created) {
          throw new CaseworkError(
            "not_found",
            "The safety plan could not be read back after saving.",
          );
        }
        return created;
      });
    },

    async updatePlan(id, input, expectedVersion) {
      return tx(async (sql) => {
        const before = await sql<PlanRow[]>`
          select * from casework.safety_plans where id = ${id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That safety plan no longer exists.");
        }
        if (before[0].version !== expectedVersion) {
          throw new CaseworkError(
            "stale_version",
            "The safety plan changed since you opened it. Reload and try again.",
            { expected: expectedVersion, actual: before[0].version },
          );
        }

        const updated = await sql<{ id: string }[]>`
          update casework.safety_plans set
            location = coalesce(${input.location ?? null}, location),
            site_visit_risk = coalesce(${input.siteVisitRisk ?? null}, site_visit_risk),
            known_hazards = ${input.knownHazards === undefined ? sql`known_hazards` : input.knownHazards},
            safety_instructions = ${input.safetyInstructions === undefined ? sql`safety_instructions` : input.safetyInstructions},
            emergency_contact_name = coalesce(${input.emergencyContactName ?? null}, emergency_contact_name),
            emergency_contact_phone = coalesce(${input.emergencyContactPhone ?? null}, emergency_contact_phone),
            emergency_contact_note = ${input.emergencyContactNote === undefined ? sql`emergency_contact_note` : input.emergencyContactNote},
            check_in_frequency_hours = ${input.checkInFrequencyHours === undefined ? sql`check_in_frequency_hours` : input.checkInFrequencyHours},
            check_in_instructions = ${input.checkInInstructions === undefined ? sql`check_in_instructions` : input.checkInInstructions},
            is_active = coalesce(${input.isActive ?? null}, is_active),
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${expectedVersion}
          returning id
        `;
        if (updated.length === 0) {
          throw new CaseworkError(
            "stale_version",
            "The safety plan changed while saving. Reload and try again.",
          );
        }

        const after = await sql<PlanRow[]>`
          select * from casework.safety_plans where id = ${id}::uuid
        `;

        await sql`
          select audit.write(
            'safety_plan.updated', 'casework.safety_plans', ${id},
            ${before[0].case_id}::uuid,
            ${sql.json(planAuditShape(before[0]))},
            ${sql.json(planAuditShape(after[0]))},
            null
          )
        `;

        return toPlan(after[0]);
      });
    },

    /* -------------------------------------------------------- check-ins */

    async recordCheckIn(input) {
      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          insert into casework.check_ins (
            case_id, user_id, event, occurred_at, location, latitude, longitude,
            next_due_at, is_safe, notes, recorded_by
          ) values (
            ${input.caseId}::uuid, ${input.userId}::uuid, ${input.event},
            coalesce(${input.occurredAt ?? null}::timestamptz, now()),
            ${input.location ?? null},
            ${input.latitude ?? null}, ${input.longitude ?? null},
            ${input.nextDueAt ?? null}::timestamptz,
            ${input.isSafe ?? true}, ${input.notes ?? null},
            ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            ${input.isSafe === false ? "check_in.unsafe" : "check_in.recorded"},
            'casework.check_ins', ${rows[0].id}, ${input.caseId}::uuid, null,
            ${sql.json({
              event: input.event,
              isSafe: input.isSafe ?? true,
              nextDueAt: input.nextDueAt ?? null,
            })},
            ${input.notes ?? null}
          )
        `;

        const created = await sql<CheckInRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${CHECK_IN_SELECT(sql)}
          where ci.id = ${rows[0].id}::uuid
        `;
        if (created.length === 0) {
          throw new CaseworkError(
            "not_found",
            "The check-in could not be read back after recording.",
          );
        }
        return toCheckIn(created[0]);
      });
    },

    async listCheckIns(filter: ListCheckInsFilter): Promise<Page<CheckIn>> {
      const limit = Math.min(filter.limit ?? 50, 200);
      const offset = Math.max(filter.offset ?? 0, 0);

      return tx(async (sql) => {
        const rows = await sql<(CheckInRow & { total_count: string })[]>`
          with directory as (${DIRECTORY(sql)}),
          projected as (
            ${CHECK_IN_SELECT(sql)}
            where (${filter.caseId ?? null}::uuid is null or ci.case_id = ${filter.caseId ?? null}::uuid)
              and (${filter.userId ?? null}::uuid is null or ci.user_id = ${filter.userId ?? null}::uuid)
          ),
          ranked as (
            select p.*, row_number() over (
              partition by p.case_id, p.user_id order by p.occurred_at desc, p.seq desc
            ) as recency
            from projected p
          ),
          filtered as (
            select r.* from ranked r
            where (not ${filter.latestPerUser ?? false} or r.recency = 1)
              and (not ${filter.overdueOnly ?? false} or coalesce(r.minutes_late, 0) > 0)
          )
          select f.*, count(*) over () as total_count
          from filtered f
          order by f.occurred_at desc, f.seq desc
          limit ${limit} offset ${offset}
        `;

        return {
          rows: rows.map(toCheckIn),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async latestCheckIn(caseId, userId) {
      return tx(async (sql) => {
        const rows = await sql<CheckInRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${CHECK_IN_SELECT(sql)}
          where ci.case_id = ${caseId}::uuid and ci.user_id = ${userId}::uuid
          order by ci.occurred_at desc, ci.seq desc
          limit 1
        `;
        return rows.length > 0 ? toCheckIn(rows[0]) : null;
      });
    },

    /* -------------------------------------------------------- incidents */

    async listIncidents(filter: ListIncidentsFilter): Promise<Page<Incident>> {
      const limit = Math.min(filter.limit ?? 50, 200);
      const offset = Math.max(filter.offset ?? 0, 0);

      return tx(async (sql) => {
        const rows = await sql<(IncidentRow & { total_count: string })[]>`
          with directory as (${DIRECTORY(sql)}),
          filtered as (
            ${INCIDENT_SELECT(sql)}
            where (${filter.caseId ?? null}::uuid is null or i.case_id = ${filter.caseId ?? null}::uuid)
              and (${filter.status ?? "all"} = 'all' or i.status = ${filter.status ?? "all"})
              and (not ${filter.openOnly ?? false} or i.status <> 'closed')
              and (${filter.severity ?? null}::text is null or i.severity = ${filter.severity ?? null})
              and (${filter.incidentType ?? null}::text is null or i.incident_type = ${filter.incidentType ?? null})
              and (${filter.affectedUserId ?? null}::uuid is null or i.affected_user_id = ${filter.affectedUserId ?? null}::uuid)
          )
          select f.*, count(*) over () as total_count
          from filtered f
          -- Worst first, then most recent: an open critical incident is the
          -- thing somebody opening this screen has to see.
          order by
            case f.status when 'open' then 0 when 'under_review' then 1 else 2 end,
            case f.severity
              when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3
            end,
            f.occurred_at desc
          limit ${limit} offset ${offset}
        `;

        return {
          rows: rows.map(toIncident),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async findIncidentById(id) {
      return tx((sql) => loadIncident(sql, id));
    },

    async reportIncident(input) {
      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          insert into casework.incidents (
            case_id, occurred_at, incident_type, severity, location, description,
            immediate_action, injuries, injury_detail, police_notified,
            police_reference, affected_user_id, classification,
            reported_by, created_by
          ) values (
            ${input.caseId}::uuid, ${input.occurredAt}::timestamptz,
            ${input.incidentType}, ${input.severity}, ${input.location ?? null},
            ${input.description}, ${input.immediateAction ?? null},
            ${input.injuries ?? false}, ${input.injuryDetail ?? null},
            ${input.policeNotified ?? false}, ${input.policeReference ?? null},
            ${input.affectedUserId ?? null}::uuid, ${input.classification},
            ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'incident.reported', 'casework.incidents', ${rows[0].id},
            ${input.caseId}::uuid, null,
            ${sql.json({
              incidentType: input.incidentType,
              severity: input.severity,
              injuries: input.injuries ?? false,
            })},
            null, ${input.classification}
          )
        `;

        const created = await loadIncident(sql, rows[0].id);
        if (!created) {
          throw new CaseworkError(
            "not_found",
            "The incident could not be read back after reporting.",
          );
        }
        return created;
      });
    },

    async updateIncident(id, input, expectedVersion) {
      return tx(async (sql) => {
        const before = await sql<IncidentRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${INCIDENT_SELECT(sql)}
          where i.id = ${id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That incident no longer exists.");
        }
        if (before[0].version !== expectedVersion) {
          throw new CaseworkError(
            "stale_version",
            "This incident changed since you opened it. Reload and try again.",
            { expected: expectedVersion, actual: before[0].version },
          );
        }

        const updated = await sql<{ id: string }[]>`
          update casework.incidents set
            occurred_at = coalesce(${input.occurredAt ?? null}::timestamptz, occurred_at),
            incident_type = coalesce(${input.incidentType ?? null}, incident_type),
            severity = coalesce(${input.severity ?? null}, severity),
            location = ${input.location === undefined ? sql`location` : input.location},
            description = coalesce(${input.description ?? null}, description),
            immediate_action = ${input.immediateAction === undefined ? sql`immediate_action` : input.immediateAction},
            injuries = coalesce(${input.injuries ?? null}, injuries),
            injury_detail = ${input.injuryDetail === undefined ? sql`injury_detail` : input.injuryDetail},
            police_notified = coalesce(${input.policeNotified ?? null}, police_notified),
            police_reference = ${input.policeReference === undefined ? sql`police_reference` : input.policeReference},
            affected_user_id = ${input.affectedUserId === undefined ? sql`affected_user_id` : sql`${input.affectedUserId}::uuid`},
            classification = coalesce(${input.classification ?? null}, classification),
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${expectedVersion}
          returning id
        `;
        if (updated.length === 0) {
          throw new CaseworkError(
            "stale_version",
            "This incident changed while saving. Reload and try again.",
          );
        }

        const after = await sql<IncidentRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${INCIDENT_SELECT(sql)}
          where i.id = ${id}::uuid
        `;

        await sql`
          select audit.write(
            'incident.updated', 'casework.incidents', ${id},
            ${before[0].case_id}::uuid,
            ${sql.json(incidentAuditShape(before[0]))},
            ${sql.json(incidentAuditShape(after[0]))},
            null, ${after[0].classification}
          )
        `;

        return toIncident(after[0]);
      });
    },

    async setIncidentStatus(input) {
      return tx(async (sql) => {
        const before = await sql<
          { status: Incident["status"]; case_id: string; classification: string }[]
        >`
          select status, case_id, classification from casework.incidents
          where id = ${input.id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That incident no longer exists.");
        }

        // resolved_at and resolved_by are set here rather than by the caller,
        // so they cannot disagree with the status.
        await sql`
          update casework.incidents set
            status = ${input.status},
            resolution = ${input.resolution === undefined ? sql`resolution` : input.resolution},
            resolved_at = ${
              input.status === "closed" ? sql`coalesce(resolved_at, now())` : null
            },
            resolved_by = ${
              input.status === "closed"
                ? sql`coalesce(resolved_by, ${actor.userId}::uuid)`
                : null
            },
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid
        `;

        await sql`
          select audit.write(
            ${input.status === "closed" ? "incident.closed" : "incident.status_changed"},
            'casework.incidents', ${input.id}, ${before[0].case_id}::uuid,
            ${sql.json({ status: before[0].status })},
            ${sql.json({ status: input.status })},
            ${input.resolution ?? null}, ${before[0].classification}
          )
        `;

        const after = await loadIncident(sql, input.id);
        if (!after) {
          throw new CaseworkError(
            "not_found",
            "The incident could not be read back after the change.",
          );
        }
        return after;
      });
    },

    async safetySummary(filter) {
      return tx(async (sql) => {
        const rows = await sql<
          {
            open_incidents: string;
            critical_incidents: string;
            people_out: string;
            overdue_check_ins: string;
          }[]
        >`
          with scoped_incidents as (
            select * from casework.incidents
            where (${filter.caseId ?? null}::uuid is null or case_id = ${filter.caseId ?? null}::uuid)
          ),
          latest as (
            select ci.*, row_number() over (
              partition by ci.case_id, ci.user_id
              order by ci.occurred_at desc, ci.seq desc
            ) as recency
            from casework.check_ins ci
            where (${filter.caseId ?? null}::uuid is null or ci.case_id = ${filter.caseId ?? null}::uuid)
          )
          select
            (select count(*) from scoped_incidents where status <> 'closed')
              as open_incidents,
            (select count(*) from scoped_incidents
              where status <> 'closed' and severity = 'critical')
              as critical_incidents,
            -- Somebody is "out" when their latest event is a check-in: they
            -- have arrived somewhere and not yet reported leaving.
            (select count(*) from latest where recency = 1 and event = 'check_in')
              as people_out,
            (select count(*) from latest
              where recency = 1 and event = 'check_in'
                and next_due_at is not null and next_due_at < now())
              as overdue_check_ins
        `;

        const row = rows[0];
        return {
          openIncidents: Number(row?.open_incidents ?? 0),
          criticalIncidents: Number(row?.critical_incidents ?? 0),
          peopleOut: Number(row?.people_out ?? 0),
          overdueCheckIns: Number(row?.overdue_check_ins ?? 0),
        };
      });
    },
  };
}

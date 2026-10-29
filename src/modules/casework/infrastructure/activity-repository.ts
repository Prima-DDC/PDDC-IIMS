import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { CaseworkError } from "../domain/errors";
import type { Activity, InvestigationPlan, PlanVersion } from "../domain/types";
import type {
  ActivityRepository,
  ListActivitiesFilter,
  PlanRepository,
} from "../application/task-ports";
import type { Page } from "../application/ports";

/**
 * The investigation activity log and the investigation plan (PRD 9.3, 9.4).
 *
 * They share a file because they are the two halves of the same thing: the
 * plan is what PDDC intended to do and the log is what it actually did, and
 * reading one against the other is how a supervisor tells whether a case is
 * going to plan.
 *
 * There is no `update` and no `delete` on activities, deliberately. PRD 9.4
 * makes the log append-only, the database refuses the mutation with a trigger,
 * and there is no policy that would let the application reach the trigger. A
 * correction is a new row pointing at the original.
 */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

interface ActivityRow {
  id: string;
  activity_id: string;
  case_id: string;
  occurred_at: string;
  activity_type: Activity["activityType"];
  description: string;
  location: string | null;
  related_source_id: string | null;
  related_evidence_id: string | null;
  related_document_id: string | null;
  related_task_id: string | null;
  related_task_title: string | null;
  corrects_activity_id: string | null;
  corrects_activity_reference: string | null;
  correction_reason: string | null;
  corrected_by_activity_id: string | null;
  corrected_by_reference: string | null;
  classification: Activity["classification"];
  recorded_at: string;
  recorded_by: string | null;
  recorded_by_name: string | null;
  seq: string;
}

function toActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    activityId: row.activity_id,
    caseId: row.case_id,
    occurredAt: row.occurred_at,
    activityType: row.activity_type,
    description: row.description,
    location: row.location,
    relatedSourceId: row.related_source_id,
    relatedEvidenceId: row.related_evidence_id,
    relatedDocumentId: row.related_document_id,
    relatedTaskId: row.related_task_id,
    relatedTaskTitle: row.related_task_title,
    correctsActivityId: row.corrects_activity_id,
    correctsActivityReference: row.corrects_activity_reference,
    correctionReason: row.correction_reason,
    correctedByActivityId: row.corrected_by_activity_id,
    correctedByReference: row.corrected_by_reference,
    classification: row.classification,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
    recordedByName: row.recorded_by_name,
  };
}

/**
 * The projection every activity read shares.
 *
 * `corrected_by` is a reverse lookup: an entry does not know it has been
 * corrected, so the row that corrects it is found by looking for one that
 * points back. Without this the log would show a superseded entry as though it
 * still stood, which is exactly the thing PRD 9.4 is protecting against.
 */
const ACTIVITY_SELECT = (sql: postgres.TransactionSql) => sql`
  select a.*,
         orig.activity_id as corrects_activity_reference,
         fix.id           as corrected_by_activity_id,
         fix.activity_id  as corrected_by_reference,
         t.title          as related_task_title,
         dir.full_name    as recorded_by_name
  from casework.activities a
  left join casework.activities orig on orig.id = a.corrects_activity_id
  left join casework.activities fix  on fix.corrects_activity_id = a.id
  left join casework.tasks t on t.id = a.related_task_id
  left join directory dir on dir.user_id = a.recorded_by
`;

export function createActivityRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): ActivityRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  const load = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Activity | null> => {
    const rows = await sql<ActivityRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${ACTIVITY_SELECT(sql)}
      where a.id = ${id}::uuid
    `;
    return rows.length > 0 ? toActivity(rows[0]) : null;
  };

  return {
    async list(filter: ListActivitiesFilter): Promise<Page<Activity>> {
      const limit = Math.min(filter.limit ?? 50, 200);
      const offset = Math.max(filter.offset ?? 0, 0);

      return tx(async (sql) => {
        const rows = await sql<(ActivityRow & { total_count: string })[]>`
          with directory as (${DIRECTORY(sql)}),
          filtered as (
            ${ACTIVITY_SELECT(sql)}
            where a.case_id = ${filter.caseId}::uuid
              and (${filter.activityType ?? null}::text is null or a.activity_type = ${filter.activityType ?? null})
              and (${filter.from ?? null}::timestamptz is null or a.occurred_at >= ${filter.from ?? null}::timestamptz)
              and (${filter.to ?? null}::timestamptz is null or a.occurred_at <= ${filter.to ?? null}::timestamptz)
          )
          select f.*, count(*) over () as total_count
          from filtered f
          -- Chronological, newest first: a log is read backwards from now.
          -- The sequence breaks the tie, because two entries recorded together
          -- share a recorded_at: now() is the transaction timestamp.
          order by f.occurred_at desc, f.seq desc
          limit ${limit} offset ${offset}
        `;

        return {
          rows: rows.map(toActivity),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async findById(id: string): Promise<Activity | null> {
      return tx((sql) => load(sql, id));
    },

    async record(input): Promise<Activity> {
      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          insert into casework.activities (
            case_id, occurred_at, activity_type, description, location,
            related_task_id, classification, recorded_by
          ) values (
            ${input.caseId}::uuid,
            coalesce(${input.occurredAt ?? null}::timestamptz, now()),
            ${input.activityType}, ${input.description}, ${input.location ?? null},
            ${input.relatedTaskId ?? null}::uuid, ${input.classification},
            ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'activity.recorded', 'casework.activities', ${rows[0].id},
            ${input.caseId}::uuid, null,
            ${sql.json({
              activityType: input.activityType,
              occurredAt: input.occurredAt ?? null,
            })},
            null, ${input.classification}
          )
        `;

        const created = await load(sql, rows[0].id);
        if (!created) {
          throw new CaseworkError(
            "not_found",
            "The activity could not be read back after recording.",
          );
        }
        return created;
      });
    },

    async correct(input): Promise<Activity> {
      return tx(async (sql) => {
        const original = await sql<{ case_id: string; activity_id: string }[]>`
          select case_id, activity_id from casework.activities
          where id = ${input.correctsActivityId}::uuid
        `;
        if (original.length === 0) {
          throw new CaseworkError(
            "not_found",
            "The entry being corrected no longer exists.",
          );
        }

        // Refused here as well as in the domain rule, because this is the
        // check that holds against a concurrent second correction: the domain
        // rule reads a snapshot, this reads the row in the same transaction as
        // the insert.
        const alreadyCorrected = await sql<{ activity_id: string }[]>`
          select activity_id from casework.activities
          where corrects_activity_id = ${input.correctsActivityId}::uuid
          limit 1
        `;
        if (alreadyCorrected.length > 0) {
          throw new CaseworkError(
            "conflict",
            `${original[0].activity_id} has already been corrected by ${alreadyCorrected[0].activity_id}. Correct that entry instead, so the log reads as one sequence.`,
          );
        }

        const rows = await sql<{ id: string }[]>`
          insert into casework.activities (
            case_id, occurred_at, activity_type, description, location,
            corrects_activity_id, correction_reason, classification, recorded_by
          ) values (
            ${original[0].case_id}::uuid,
            coalesce(${input.occurredAt ?? null}::timestamptz, now()),
            ${input.activityType}, ${input.description}, ${input.location ?? null},
            ${input.correctsActivityId}::uuid, ${input.correctionReason},
            ${input.classification}, ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'activity.corrected', 'casework.activities', ${rows[0].id},
            ${original[0].case_id}::uuid,
            ${sql.json({ corrects: original[0].activity_id })},
            ${sql.json({ activityType: input.activityType })},
            ${input.correctionReason}, ${input.classification}
          )
        `;

        const created = await load(sql, rows[0].id);
        if (!created) {
          throw new CaseworkError(
            "not_found",
            "The correction could not be read back after recording.",
          );
        }
        return created;
      });
    },
  };
}

/* --------------------------------------------------- investigation plans */

interface PlanVersionRow {
  id: string;
  plan_id: string;
  version_no: number;
  objective: string;
  scope: string | null;
  methodology: string;
  sources_to_consult: string[];
  assigned_personnel: string[];
  timeline: string | null;
  risks: string | null;
  resources: string | null;
  expected_deliverables: string[];
  status: PlanVersion["status"];
  submitted_at: string | null;
  submitted_by: string | null;
  submitted_by_name: string | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  version: number;
}

function toPlanVersion(row: PlanVersionRow): PlanVersion {
  return {
    id: row.id,
    planId: row.plan_id,
    versionNo: row.version_no,
    objective: row.objective,
    scope: row.scope,
    methodology: row.methodology,
    sourcesToConsult: row.sources_to_consult ?? [],
    assignedPersonnel: row.assigned_personnel ?? [],
    timeline: row.timeline,
    risks: row.risks,
    resources: row.resources,
    expectedDeliverables: row.expected_deliverables ?? [],
    status: row.status,
    submittedAt: row.submitted_at,
    submittedBy: row.submitted_by,
    submittedByName: row.submitted_by_name,
    reviewedBy: row.reviewed_by,
    reviewedByName: row.reviewed_by_name,
    reviewedAt: row.reviewed_at,
    reviewNotes: row.review_notes,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export function createPlanRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): PlanRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  const loadVersions = async (
    sql: postgres.TransactionSql,
    planId: string,
  ): Promise<PlanVersion[]> => {
    const rows = await sql<PlanVersionRow[]>`
      with directory as (${DIRECTORY(sql)})
      select v.*, dir_s.full_name as submitted_by_name,
             dir_r.full_name as reviewed_by_name
      from casework.plan_versions v
      left join directory dir_s on dir_s.user_id = v.submitted_by
      left join directory dir_r on dir_r.user_id = v.reviewed_by
      where v.plan_id = ${planId}::uuid
      order by v.version_no desc
    `;
    return rows.map(toPlanVersion);
  };

  const loadVersion = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<PlanVersion> => {
    const rows = await sql<PlanVersionRow[]>`
      with directory as (${DIRECTORY(sql)})
      select v.*, dir_s.full_name as submitted_by_name,
             dir_r.full_name as reviewed_by_name
      from casework.plan_versions v
      left join directory dir_s on dir_s.user_id = v.submitted_by
      left join directory dir_r on dir_r.user_id = v.reviewed_by
      where v.id = ${id}::uuid
    `;
    if (rows.length === 0) {
      throw new CaseworkError(
        "not_found",
        "That plan version could not be read back.",
      );
    }
    return toPlanVersion(rows[0]);
  };

  return {
    async forCase(caseId: string): Promise<InvestigationPlan | null> {
      return tx(async (sql) => {
        const plans = await sql<
          { id: string; plan_id: string; created_at: string; created_by: string | null }[]
        >`
          select id, plan_id, created_at, created_by
          from casework.investigation_plans
          where case_id = ${caseId}::uuid
        `;
        if (plans.length === 0) return null;

        const versions = await loadVersions(sql, plans[0].id);

        return {
          id: plans[0].id,
          planId: plans[0].plan_id,
          caseId,
          createdAt: plans[0].created_at,
          createdBy: plans[0].created_by,
          versions,
          // The approved version in force. Superseded ones are history.
          current: versions.find((v) => v.status === "approved") ?? null,
          // The one somebody is working on or waiting on.
          working:
            versions.find((v) => v.status === "draft" || v.status === "submitted") ??
            null,
        };
      });
    },

    async createVersion(input): Promise<PlanVersion> {
      return tx(async (sql) => {
        // The plan itself is created on first use, so a case does not carry an
        // empty plan row until somebody writes one.
        const plans = await sql<{ id: string }[]>`
          insert into casework.investigation_plans (case_id, created_by)
          values (${input.caseId}::uuid, ${actor.userId}::uuid)
          on conflict (case_id) do update set case_id = excluded.case_id
          returning id
        `;
        const planId = plans[0].id;

        const next = await sql<{ next_no: number }[]>`
          select coalesce(max(version_no), 0) + 1 as next_no
          from casework.plan_versions where plan_id = ${planId}::uuid
        `;

        const rows = await sql<{ id: string }[]>`
          insert into casework.plan_versions (
            plan_id, version_no, objective, scope, methodology,
            sources_to_consult, assigned_personnel, timeline, risks, resources,
            expected_deliverables, created_by
          ) values (
            ${planId}::uuid, ${next[0].next_no}, ${input.objective},
            ${input.scope ?? null}, ${input.methodology},
            ${input.sourcesToConsult}::text[], ${input.assignedPersonnel}::text[],
            ${input.timeline ?? null}, ${input.risks ?? null},
            ${input.resources ?? null}, ${input.expectedDeliverables}::text[],
            ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'plan_version.created', 'casework.plan_versions', ${rows[0].id},
            ${input.caseId}::uuid, null,
            ${sql.json({ versionNo: next[0].next_no })},
            ${next[0].next_no === 1 ? "first investigation plan" : "revised plan, which needs approval of its own"}
          )
        `;

        return loadVersion(sql, rows[0].id);
      });
    },

    async updateVersion(id, input): Promise<PlanVersion> {
      return tx(async (sql) => {
        const before = await sql<{ status: string; version: number; plan_id: string }[]>`
          select status, version, plan_id from casework.plan_versions
          where id = ${id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That plan version no longer exists.");
        }
        if (before[0].version !== input.expectedVersion) {
          throw new CaseworkError(
            "stale_version",
            "This plan changed since you opened it. Reload and try again.",
          );
        }
        // The trigger refuses it too; this is here for the message.
        if (before[0].status === "approved" || before[0].status === "superseded") {
          throw new CaseworkError(
            "illegal_transition",
            "An approved plan cannot be edited. Create the next version, which needs approval of its own (PRD 9.3).",
          );
        }

        const rows = await sql<{ id: string }[]>`
          update casework.plan_versions set
            objective   = coalesce(${input.objective ?? null}, objective),
            scope       = ${input.scope === undefined ? sql`scope` : input.scope},
            methodology = coalesce(${input.methodology ?? null}, methodology),
            sources_to_consult = coalesce(${input.sourcesToConsult ?? null}::text[], sources_to_consult),
            assigned_personnel = coalesce(${input.assignedPersonnel ?? null}::text[], assigned_personnel),
            timeline    = ${input.timeline === undefined ? sql`timeline` : input.timeline},
            risks       = ${input.risks === undefined ? sql`risks` : input.risks},
            resources   = ${input.resources === undefined ? sql`resources` : input.resources},
            expected_deliverables = coalesce(${input.expectedDeliverables ?? null}::text[], expected_deliverables),
            -- A returned plan that is edited goes back to draft, so the
            -- reviewer's notes stay attached to what they reviewed.
            status      = case when status = 'returned' then 'draft' else status end,
            updated_by  = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${input.expectedVersion}
          returning id
        `;
        if (rows.length === 0) {
          throw new CaseworkError(
            "stale_version",
            "This plan changed while saving. Reload and try again.",
          );
        }

        await sql`
          select audit.write(
            'plan_version.updated', 'casework.plan_versions', ${id}, null,
            ${sql.json({ status: before[0].status })}, null, null
          )
        `;

        return loadVersion(sql, id);
      });
    },

    async submitVersion(id: string): Promise<PlanVersion> {
      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          update casework.plan_versions set
            status = 'submitted',
            submitted_at = now(),
            submitted_by = ${actor.userId}::uuid,
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and status in ('draft', 'returned')
          returning id
        `;
        if (rows.length === 0) {
          throw new CaseworkError(
            "illegal_transition",
            "Only a draft or returned plan can be submitted for review.",
          );
        }

        await sql`
          select audit.write(
            'plan_version.submitted', 'casework.plan_versions', ${id}, null,
            null, ${sql.json({ submittedBy: actor.userId })},
            'submitted for supervisor review'
          )
        `;

        return loadVersion(sql, id);
      });
    },

    async reviewVersion(input): Promise<PlanVersion> {
      return tx(async (sql) => {
        const before = await sql<
          { status: string; plan_id: string; submitted_by: string | null }[]
        >`
          select status, plan_id, submitted_by from casework.plan_versions
          where id = ${input.id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That plan version no longer exists.");
        }
        if (before[0].status !== "submitted") {
          throw new CaseworkError(
            "illegal_transition",
            `That plan is ${before[0].status}, so there is nothing to review.`,
          );
        }

        if (input.approve) {
          // Supersede whatever was approved before, in the same transaction,
          // so a case never has two approved plans. Only `status` changes,
          // which is the one thing the frozen-plan trigger permits.
          await sql`
            update casework.plan_versions set status = 'superseded'
            where plan_id = ${before[0].plan_id}::uuid and status = 'approved'
          `;
        }

        const rows = await sql<{ id: string }[]>`
          update casework.plan_versions set
            status = ${input.approve ? "approved" : "returned"},
            reviewed_by = ${actor.userId}::uuid,
            reviewed_at = now(),
            review_notes = ${input.notes ?? null},
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid
          returning id
        `;

        await sql`
          select audit.write(
            ${input.approve ? "plan_version.approved" : "plan_version.returned"},
            'casework.plan_versions', ${input.id}, null,
            ${sql.json({ status: "submitted" })},
            ${sql.json({ status: input.approve ? "approved" : "returned" })},
            ${input.notes ?? null}
          )
        `;

        return loadVersion(sql, rows[0].id);
      });
    },
  };
}

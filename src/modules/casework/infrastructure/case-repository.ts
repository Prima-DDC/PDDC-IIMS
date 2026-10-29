import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { CaseworkError } from "../domain/errors";
import type {
  Case,
  CaseAssignment,
  CaseCommunication,
  CaseObjective,
  RiskAssessment,
  ScopeChangeRequest,
  ScopeVersion,
} from "../domain/types";
import type {
  CaseRepository,
  CreateCaseInput,
  ListCasesFilter,
  Page,
  UpdateCaseInput,
} from "../application/ports";

/**
 * Postgres implementation of CaseRepository.
 *
 * Follows the pattern the IAM and CRM repositories established: one
 * transaction per method through withActor, the audit row written in the same
 * transaction as the change, and `existing` so a test can inject a transaction
 * it then rolls back.
 *
 * NOTE ON QUALIFYING COLUMNS
 * casework.cases has BOTH `id` (uuid) and `case_id` (the PDDC-YYYY-NNNNNN
 * text), while every child table has `case_id` as a uuid pointing at cases.id.
 * Every query here aliases its tables and writes the column out in full, which
 * is what stops `case_id` resolving to the text column and producing
 * "operator does not exist: uuid = text". The same trap bit migration 0020.
 *
 * `open_task_count` and `overdue_task_count` select 0 until the tasks table
 * exists. They are in the shape now because the domain rules that read them
 * (the closure gate and the removal rule) are already written and tested.
 */

/** The projection every case read shares. */
const CASE_COLUMNS = (sql: postgres.TransactionSql) => sql`
  c.*,
  cl.organisation_name as client_name,
  cl.client_id         as client_reference,
  e.engagement_id      as engagement_reference,
  e.title              as engagement_title,
  ct.name              as case_type_name,
  s.key                as stage_key,
  s.name               as stage_name,
  s.position           as stage_position,
  s.is_terminal        as stage_is_terminal,
  s.methodology_stage  as methodology_stage,
  co.name              as jurisdiction_country_name,
  o.name               as office_name,
  dir_created.full_name as created_by_name,
  dir_closed.full_name  as closed_by_name,
  (
    select count(*) from casework.case_assignments a
    where a.case_id = c.id and a.unassigned_at is null
  ) as assignment_count,
  (
    select dir.full_name from casework.case_assignments a
    join directory dir on dir.user_id = a.user_id
    where a.case_id = c.id and a.role = 'lead_investigator'
      and a.unassigned_at is null
    limit 1
  ) as lead_investigator_name,
  (
    select dir.full_name from casework.case_assignments a
    join directory dir on dir.user_id = a.user_id
    where a.case_id = c.id and a.role = 'supervisor'
      and a.unassigned_at is null
    limit 1
  ) as supervisor_name,
  exists (
    select 1 from casework.case_objectives ob where ob.case_id = c.id
  ) as has_objective,
  0 as open_task_count,
  0 as overdue_task_count,
  -- Two dates subtract to a plain integer. An interval would be more
  -- expressive and does not survive the driver predictably, which showed up
  -- as every case reporting itself on time.
  case
    when c.target_completion_at is null then null
    else (c.target_completion_at::date - now()::date)
  end as days_to_target
`;

/** The joins those columns need. `directory` is a CTE the caller supplies. */
const CASE_JOINS = (sql: postgres.TransactionSql) => sql`
  from casework.cases c
  join crm.clients cl       on cl.id = c.client_id
  join crm.engagements e    on e.id = c.engagement_id
  join config.case_types ct on ct.key = c.case_type
  join config.workflow_stages s on s.id = c.stage_id
  left join iam.countries co on co.code = c.jurisdiction_country
  left join iam.offices o    on o.id = c.office_id
  left join directory dir_created on dir_created.user_id = c.created_by
  left join directory dir_closed  on dir_closed.user_id = c.closed_by
`;

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name, email
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

interface CaseRow {
  id: string;
  case_id: string;
  title: string;
  client_id: string;
  client_name: string;
  client_reference: string;
  engagement_id: string;
  engagement_reference: string;
  engagement_title: string;
  case_type: string;
  case_type_name: string;
  jurisdiction_country: string | null;
  jurisdiction_country_name: string | null;
  jurisdiction_region: string | null;
  office_id: string | null;
  office_name: string | null;
  priority: Case["priority"];
  risk_level: Case["riskLevel"];
  definition_id: string;
  stage_id: string;
  stage_key: string;
  stage_name: string;
  stage_position: number;
  stage_is_terminal: boolean;
  methodology_stage: string | null;
  opened_at: string;
  target_completion_at: string | null;
  actual_completion_at: string | null;
  days_to_target: number | null;
  classification: Case["classification"];
  retention_class: string | null;
  closure_summary: string | null;
  closed_by: string | null;
  closed_by_name: string | null;
  closed_at: string | null;
  objective_override_reason: string | null;
  objective_override_by: string | null;
  objective_override_at: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: string;
  version: number;
  deleted_at: string | null;
  assignment_count: string;
  open_task_count: string;
  overdue_task_count: string;
  has_objective: boolean;
  lead_investigator_name: string | null;
  supervisor_name: string | null;
}

function toCase(row: CaseRow): Case {
  // Null when there is no target, so there is nothing to count towards.
  const days = row.days_to_target === null ? null : Number(row.days_to_target);

  return {
    id: row.id,
    caseId: row.case_id,
    title: row.title,
    clientId: row.client_id,
    clientName: row.client_name,
    clientReference: row.client_reference,
    engagementId: row.engagement_id,
    engagementReference: row.engagement_reference,
    engagementTitle: row.engagement_title,
    caseType: row.case_type,
    caseTypeName: row.case_type_name,
    jurisdictionCountry: row.jurisdiction_country,
    jurisdictionCountryName: row.jurisdiction_country_name,
    jurisdictionRegion: row.jurisdiction_region,
    officeId: row.office_id,
    officeName: row.office_name,
    priority: row.priority,
    riskLevel: row.risk_level,
    definitionId: row.definition_id,
    stageId: row.stage_id,
    stageKey: row.stage_key,
    stageName: row.stage_name,
    stagePosition: row.stage_position,
    stageIsTerminal: row.stage_is_terminal,
    methodologyStage: row.methodology_stage,
    openedAt: row.opened_at,
    targetCompletionAt: row.target_completion_at,
    actualCompletionAt: row.actual_completion_at,
    daysToTarget: days,
    // Overdue means the target has passed and the case has not finished.
    isOverdue: days !== null && days < 0 && !row.stage_is_terminal,
    classification: row.classification,
    retentionClass: row.retention_class,
    closureSummary: row.closure_summary,
    closedBy: row.closed_by,
    closedByName: row.closed_by_name,
    closedAt: row.closed_at,
    objectiveOverrideReason: row.objective_override_reason,
    objectiveOverrideBy: row.objective_override_by,
    objectiveOverrideAt: row.objective_override_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
    assignmentCount: Number(row.assignment_count ?? 0),
    openTaskCount: Number(row.open_task_count ?? 0),
    overdueTaskCount: Number(row.overdue_task_count ?? 0),
    hasObjective: row.has_objective,
    leadInvestigatorName: row.lead_investigator_name,
    supervisorName: row.supervisor_name,
  };
}

/** The fields an audit entry compares. */
function auditShape(row: CaseRow) {
  return {
    title: row.title,
    caseType: row.case_type,
    priority: row.priority,
    riskLevel: row.risk_level,
    stageKey: row.stage_key,
    jurisdictionCountry: row.jurisdiction_country,
    jurisdictionRegion: row.jurisdiction_region,
    officeId: row.office_id,
    targetCompletionAt: row.target_completion_at,
    classification: row.classification,
  };
}

async function loadCase(
  sql: postgres.TransactionSql,
  id: string,
): Promise<Case | null> {
  const rows = await sql<CaseRow[]>`
    with directory as (${DIRECTORY(sql)})
    select ${CASE_COLUMNS(sql)}
    ${CASE_JOINS(sql)}
    where c.id = ${id}::uuid
  `;
  return rows.length > 0 ? toCase(rows[0]) : null;
}

export function createCaseRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): CaseRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  const reload = async (sql: postgres.TransactionSql, id: string): Promise<Case> => {
    const found = await loadCase(sql, id);
    if (!found) {
      throw new CaseworkError(
        "not_found",
        "The case could not be read back after saving.",
      );
    }
    return found;
  };

  return {
    async list(filter: ListCasesFilter): Promise<Page<Case>> {
      const limit = Math.min(filter.limit ?? 25, 200);
      const offset = Math.max(filter.offset ?? 0, 0);
      const sort = filter.sort ?? "opened";
      const openness = filter.openness ?? "open";

      return tx(async (sql) => {
        const rows = await sql<(CaseRow & { total_count: string })[]>`
          with directory as (${DIRECTORY(sql)}),
          filtered as (
            select ${CASE_COLUMNS(sql)}
            ${CASE_JOINS(sql)}
            where (
                    ${filter.onlyDeleted ?? false} and c.deleted_at is not null
                    or ${filter.includeDeleted ?? false}
                    or (not ${filter.onlyDeleted ?? false} and c.deleted_at is null)
                  )
              -- Openness is read from the stage rather than from a column, so
              -- renaming or adding a terminal stage keeps this correct.
              and (
                ${openness} = 'all'
                or (${openness} = 'open'   and not s.is_terminal)
                or (${openness} = 'closed' and s.is_terminal)
              )
              and (${filter.stageKey ?? null}::text is null or s.key = ${filter.stageKey ?? null})
              and (${filter.priority ?? null}::text is null or c.priority = ${filter.priority ?? null})
              and (${filter.riskLevel ?? null}::text is null or c.risk_level = ${filter.riskLevel ?? null})
              and (${filter.caseType ?? null}::text is null or c.case_type = ${filter.caseType ?? null})
              and (${filter.clientId ?? null}::uuid is null or c.client_id = ${filter.clientId ?? null}::uuid)
              and (${filter.engagementId ?? null}::uuid is null or c.engagement_id = ${filter.engagementId ?? null}::uuid)
              and (
                ${filter.assignedTo ?? null}::uuid is null
                or exists (
                  select 1 from casework.case_assignments a
                  where a.case_id = c.id
                    and a.user_id = ${filter.assignedTo ?? null}::uuid
                    and a.unassigned_at is null
                )
              )
              and (
                not ${filter.overdueOnly ?? false}
                or (c.target_completion_at < now() and not s.is_terminal)
              )
              and (
                ${filter.search ?? null}::text is null
                or c.title ilike '%' || ${filter.search ?? ""} || '%'
                or c.case_id ilike '%' || ${filter.search ?? ""} || '%'
                or cl.organisation_name ilike '%' || ${filter.search ?? ""} || '%'
              )
          )
          select f.*, count(*) over () as total_count
          from filtered f
          order by
            case when ${sort} = 'title' then f.title end,
            case when ${sort} = 'stage' then f.stage_position end,
            case when ${sort} = 'target' then f.target_completion_at end asc nulls last,
            -- Most urgent first, not alphabetically.
            case when ${sort} = 'priority' then
              case f.priority when 'urgent' then 1 when 'high' then 2
                              when 'medium' then 3 else 4 end
            end,
            case when ${sort} = 'risk' then
              case f.risk_level when 'critical' then 1 when 'high' then 2
                                when 'medium' then 3 else 4 end
            end,
            f.opened_at desc
          limit ${limit} offset ${offset}
        `;

        return {
          rows: rows.map(toCase),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async findById(id: string): Promise<Case | null> {
      return tx(async (sql) => {
        const found = await loadCase(sql, id);
        if (found) {
          // Opening a case is an access event, and on a case it matters more
          // than anywhere else: PRD 13 wants it recorded against the case.
          await sql`select audit.record_access('cases', ${id}, ${id}::uuid, 'view')`;
        }
        return found;
      });
    },

    async findByReference(reference: string): Promise<Case | null> {
      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          select id from casework.cases where case_id = ${reference}
        `;
        if (rows.length === 0) return null;
        const found = await loadCase(sql, rows[0].id);
        if (found) {
          await sql`
            select audit.record_access('cases', ${rows[0].id}, ${rows[0].id}::uuid, 'view')
          `;
        }
        return found;
      });
    },

    async create(input: CreateCaseInput): Promise<Case> {
      return tx(async (sql) => {
        // The lifecycle to open against, and its first stage. Taken from the
        // definition rather than from a constant, so a PDDC-renamed first
        // stage is still the first stage.
        const definitions = await sql<{ id: string }[]>`
          select id from config.workflow_definitions
          where (${input.definitionId ?? null}::uuid is null and is_default)
             or id = ${input.definitionId ?? null}::uuid
          limit 1
        `;
        if (definitions.length === 0) {
          throw new CaseworkError(
            "not_found",
            "No case lifecycle is configured. An administrator has to set one up before cases can be opened.",
          );
        }
        const definitionId = definitions[0].id;

        const firstStage = await sql<{ id: string }[]>`
          select id from config.workflow_stages
          where definition_id = ${definitionId}::uuid
          order by position limit 1
        `;
        if (firstStage.length === 0) {
          throw new CaseworkError(
            "not_found",
            "That lifecycle has no stages, so a case cannot be opened against it.",
          );
        }

        const inserted = await sql<{ id: string }[]>`
          insert into casework.cases (
            title, client_id, engagement_id, case_type, jurisdiction_country,
            jurisdiction_region, office_id, priority, definition_id, stage_id,
            opened_at, target_completion_at, classification, created_by
          ) values (
            ${input.title}, ${input.clientId}::uuid, ${input.engagementId}::uuid,
            ${input.caseType}, ${input.jurisdictionCountry ?? null},
            ${input.jurisdictionRegion ?? null}, ${input.officeId ?? null}::uuid,
            ${input.priority}, ${definitionId}::uuid, ${firstStage[0].id}::uuid,
            coalesce(${input.openedAt ?? null}::timestamptz, now()),
            ${input.targetCompletionAt ?? null}::timestamptz,
            ${input.classification}, ${actor.userId}::uuid
          )
          returning id
        `;

        const id = inserted[0].id;
        const created = await reload(sql, id);

        await sql`
          select audit.write(
            'case.opened', 'casework.cases', ${id}, ${id}::uuid, null,
            ${sql.json({
              caseId: created.caseId,
              title: created.title,
              clientId: input.clientId,
              engagementId: input.engagementId,
              caseType: input.caseType,
              priority: input.priority,
              classification: input.classification,
            })},
            null, ${input.classification}
          )
        `;

        return created;
      });
    },

    async update(id: string, input: UpdateCaseInput): Promise<Case> {
      return tx(async (sql) => {
        const before = await sql<CaseRow[]>`
          with directory as (${DIRECTORY(sql)})
          select ${CASE_COLUMNS(sql)}
          ${CASE_JOINS(sql)}
          where c.id = ${id}::uuid and c.deleted_at is null
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That case no longer exists.");
        }
        if (before[0].version !== input.expectedVersion) {
          throw new CaseworkError(
            "stale_version",
            "This case changed since you opened it. Reload and try again.",
            { expected: input.expectedVersion, actual: before[0].version },
          );
        }

        const updated = await sql<{ id: string }[]>`
          update casework.cases set
            title      = coalesce(${input.title ?? null}, title),
            case_type  = coalesce(${input.caseType ?? null}, case_type),
            priority   = coalesce(${input.priority ?? null}, priority),
            jurisdiction_country = ${input.jurisdictionCountry === undefined ? sql`jurisdiction_country` : input.jurisdictionCountry},
            jurisdiction_region  = ${input.jurisdictionRegion === undefined ? sql`jurisdiction_region` : input.jurisdictionRegion},
            office_id  = ${input.officeId === undefined ? sql`office_id` : sql`${input.officeId}::uuid`},
            target_completion_at = ${input.targetCompletionAt === undefined ? sql`target_completion_at` : sql`${input.targetCompletionAt}::timestamptz`},
            classification = coalesce(${input.classification ?? null}, classification),
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${input.expectedVersion}
          returning id
        `;
        if (updated.length === 0) {
          throw new CaseworkError(
            "stale_version",
            "This case changed while saving. Reload and try again.",
          );
        }

        const after = await sql<CaseRow[]>`
          with directory as (${DIRECTORY(sql)})
          select ${CASE_COLUMNS(sql)}
          ${CASE_JOINS(sql)}
          where c.id = ${id}::uuid
        `;

        await sql`
          select audit.write(
            'case.updated', 'casework.cases', ${id}, ${id}::uuid,
            ${sql.json(auditShape(before[0]))},
            ${sql.json(auditShape(after[0]))},
            null, ${after[0].classification}
          )
        `;

        return toCase(after[0]);
      });
    },

    async moveToStage(input): Promise<Case> {
      return tx(async (sql) => {
        const before = await sql<CaseRow[]>`
          with directory as (${DIRECTORY(sql)})
          select ${CASE_COLUMNS(sql)}
          ${CASE_JOINS(sql)}
          where c.id = ${input.id}::uuid and c.deleted_at is null
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That case no longer exists.");
        }

        const target = await sql<{ key: string; name: string; is_terminal: boolean }[]>`
          select key, name, is_terminal from config.workflow_stages
          where id = ${input.toStageId}::uuid
        `;
        if (target.length === 0) {
          throw new CaseworkError("not_found", "That lifecycle stage no longer exists.");
        }

        await sql`
          update casework.cases set
            stage_id = ${input.toStageId}::uuid,
            -- Entering a terminal stage is when the case actually finished,
            -- which is a different fact from its target date.
            actual_completion_at = ${
              target[0].is_terminal ? sql`coalesce(actual_completion_at, now())` : sql`actual_completion_at`
            },
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid
        `;

        // PRD 4.2: "every transition records user, time, reason and
        // before/after state". The audit row is that record.
        await sql`
          select audit.write(
            'case.stage_changed', 'casework.cases', ${input.id}, ${input.id}::uuid,
            ${sql.json({ stage: before[0].stage_key, stageName: before[0].stage_name })},
            ${sql.json({ stage: target[0].key, stageName: target[0].name })},
            ${input.reason}, ${before[0].classification}
          )
        `;

        return reload(sql, input.id);
      });
    },

    async recordObjectiveOverride(id: string, reason: string): Promise<Case> {
      return tx(async (sql) => {
        const rows = await sql`
          update casework.cases set
            objective_override_reason = ${reason},
            objective_override_by = ${actor.userId}::uuid,
            objective_override_at = now(),
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
          returning id
        `;
        if (rows.count === 0) {
          throw new CaseworkError("not_found", "That case no longer exists.");
        }

        await sql`
          select audit.write(
            'case.objective_overridden', 'casework.cases', ${id}, ${id}::uuid,
            null, ${sql.json({ overrideReason: reason })}, ${reason}
          )
        `;

        return reload(sql, id);
      });
    },

    async softDelete(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        // No RETURNING. A soft delete hides the row, and most of these
        // tables have a SELECT policy that excludes hidden rows, so asking
        // the database to hand the row back is asking it to show something
        // it has just been told to conceal: Postgres refuses with "new row
        // violates row-level security policy", which reads like a permission
        // fault on the write. The row count says everything the caller needs.
        const rows = await sql`
          update casework.cases
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (rows.count === 0) {
          throw new CaseworkError("not_found", "That case no longer exists.");
        }
        await sql`
          select audit.write('case.removed', 'casework.cases', ${id}, ${id}::uuid,
                             null, null, ${reason})
        `;
      });
    },

    async restore(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        const rows = await sql`
          update casework.cases
          set deleted_at = null, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is not null
          returning id
        `;
        if (rows.count === 0) {
          throw new CaseworkError("not_found", "That case is not in the recycle bin.");
        }
        await sql`
          select audit.write('case.restored', 'casework.cases', ${id}, ${id}::uuid,
                             null, null, ${reason})
        `;
      });
    },

    /* ---------------------------------------------------------- assignment */

    async assignments(caseId: string, includeHistoric = false): Promise<CaseAssignment[]> {
      return tx(async (sql) => {
        const rows = await sql<AssignmentRow[]>`
          with directory as (${DIRECTORY(sql)})
          select a.*, dir.full_name as user_name, dir.email as user_email,
                 dir_by.full_name as assigned_by_name
          from casework.case_assignments a
          left join directory dir    on dir.user_id = a.user_id
          left join directory dir_by on dir_by.user_id = a.assigned_by
          where a.case_id = ${caseId}::uuid
            and (${includeHistoric} or a.unassigned_at is null)
          order by
            -- The people who carry the case first, then the rest by name.
            case a.role
              when 'lead_investigator' then 1
              when 'supervisor' then 2
              when 'analyst' then 3
              when 'specialist' then 4
              when 'supporting_investigator' then 5
              when 'operations_manager' then 6
              else 7
            end,
            dir.full_name
        `;
        return rows.map(toAssignment);
      });
    },

    async assign(input): Promise<CaseAssignment> {
      return tx(async (sql) => {
        const target = await sql<{ status: string }[]>`
          select status from iam.users
          where id = ${input.userId}::uuid and deleted_at is null
        `;
        if (target.length === 0) {
          throw new CaseworkError(
            "not_found",
            "That person does not have access to the platform, so they cannot be assigned to a case.",
          );
        }
        if (target[0].status !== "active") {
          throw new CaseworkError(
            "conflict",
            `That account is ${target[0].status}, so it cannot be assigned to a case.`,
          );
        }

        const rows = await sql<AssignmentRow[]>`
          insert into casework.case_assignments
            (case_id, user_id, role, assigned_by, reason)
          values (${input.caseId}::uuid, ${input.userId}::uuid, ${input.role},
                  ${actor.userId}::uuid, ${input.reason ?? null})
          returning *, null::text as user_name, null::text as user_email,
                    null::text as assigned_by_name
        `;

        // Assignment is what grants access to a case, so it is audited as an
        // access change rather than as an ordinary edit.
        await sql`
          select audit.write(
            'case.assigned', 'casework.case_assignments', ${rows[0].id},
            ${input.caseId}::uuid, null,
            ${sql.json({ userId: input.userId, role: input.role })},
            ${input.reason ?? null}
          )
        `;

        return toAssignment(rows[0]);
      });
    },

    async unassign(assignmentId: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        // Recorded, not deleted: "who was on this case in March" has to stay
        // answerable.
        const rows = await sql<{ case_id: string; user_id: string; role: string }[]>`
          update casework.case_assignments set
            unassigned_at = now(),
            unassigned_by = ${actor.userId}::uuid,
            unassign_reason = ${reason}
          where id = ${assignmentId}::uuid and unassigned_at is null
          returning case_id, user_id, role
        `;
        if (rows.length === 0) {
          throw new CaseworkError(
            "not_found",
            "That assignment has already been removed.",
          );
        }

        await sql`
          select audit.write(
            'case.unassigned', 'casework.case_assignments', ${assignmentId},
            ${rows[0].case_id}::uuid,
            ${sql.json({ userId: rows[0].user_id, role: rows[0].role })},
            null, ${reason}
          )
        `;
      });
    },

    /* ---------------------------------------------------------- objectives */

    async objective(caseId: string): Promise<CaseObjective | null> {
      return tx(async (sql) => {
        const rows = await sql<ObjectiveRow[]>`
          select * from casework.case_objectives where case_id = ${caseId}::uuid
        `;
        return rows.length > 0 ? toObjective(rows[0]) : null;
      });
    },

    async setObjective(input): Promise<CaseObjective> {
      return tx(async (sql) => {
        const before = await sql<ObjectiveRow[]>`
          select * from casework.case_objectives where case_id = ${input.caseId}::uuid
        `;

        if (before.length > 0) {
          if (
            input.expectedVersion !== undefined &&
            before[0].version !== input.expectedVersion
          ) {
            throw new CaseworkError(
              "stale_version",
              "The objective changed since you opened it. Reload and try again.",
            );
          }

          const updated = await sql<ObjectiveRow[]>`
            update casework.case_objectives set
              client_instruction = ${input.clientInstruction ?? null},
              objective = ${input.objective},
              questions = ${input.questions}::text[],
              deliverables = ${input.deliverables}::text[],
              deadline = ${input.deadline ?? null}::timestamptz,
              updated_by = ${actor.userId}::uuid
            where case_id = ${input.caseId}::uuid
            returning *
          `;

          await sql`
            select audit.write(
              'case_objective.updated', 'casework.case_objectives',
              ${updated[0].id}, ${input.caseId}::uuid,
              ${sql.json(objectiveShape(before[0]))},
              ${sql.json(objectiveShape(updated[0]))},
              null
            )
          `;

          return toObjective(updated[0]);
        }

        const rows = await sql<ObjectiveRow[]>`
          insert into casework.case_objectives (
            case_id, client_instruction, objective, questions, deliverables,
            deadline, created_by
          ) values (
            ${input.caseId}::uuid, ${input.clientInstruction ?? null},
            ${input.objective}, ${input.questions}::text[],
            ${input.deliverables}::text[], ${input.deadline ?? null}::timestamptz,
            ${actor.userId}::uuid
          )
          returning *
        `;

        await sql`
          select audit.write(
            'case_objective.set', 'casework.case_objectives', ${rows[0].id},
            ${input.caseId}::uuid, null,
            ${sql.json(objectiveShape(rows[0]))}, null
          )
        `;

        return toObjective(rows[0]);
      });
    },

    /* ---------------------------------------------------------------- risk */

    async riskAssessments(caseId: string): Promise<RiskAssessment[]> {
      return tx(async (sql) => {
        const rows = await sql<RiskRow[]>`
          with directory as (${DIRECTORY(sql)})
          select r.*, dir.full_name as assessed_by_name,
                 dir_ap.full_name as approved_by_name
          from casework.risk_assessments r
          left join directory dir    on dir.user_id = r.assessed_by
          left join directory dir_ap on dir_ap.user_id = r.approved_by
          where r.case_id = ${caseId}::uuid
          order by r.seq desc
        `;
        return rows.map(toRisk);
      });
    },

    async addRiskAssessment(input): Promise<RiskAssessment> {
      return tx(async (sql) => {
        const rows = await sql<RiskRow[]>`
          insert into casework.risk_assessments (
            case_id, operational_risk, legal_risk, reputational_risk,
            safety_risk, sensitivity_risk, overall_risk, rationale, assessed_by
          ) values (
            ${input.caseId}::uuid, ${input.operationalRisk}, ${input.legalRisk},
            ${input.reputationalRisk}, ${input.safetyRisk},
            ${input.sensitivityRisk}, ${input.overallRisk}, ${input.rationale},
            ${actor.userId}::uuid
          )
          returning *, null::text as assessed_by_name, null::text as approved_by_name
        `;

        // The case's cached rating follows the newest assessment, so lists and
        // filters agree with the record without joining to it.
        await sql`
          update casework.cases
          set risk_level = ${input.overallRisk}, updated_by = ${actor.userId}::uuid
          where id = ${input.caseId}::uuid
        `;

        await sql`
          select audit.write(
            'case_risk.assessed', 'casework.risk_assessments', ${rows[0].id},
            ${input.caseId}::uuid, null,
            ${sql.json({
              overall: input.overallRisk,
              operational: input.operationalRisk,
              legal: input.legalRisk,
              reputational: input.reputationalRisk,
              safety: input.safetyRisk,
              sensitivity: input.sensitivityRisk,
            })},
            ${input.rationale}
          )
        `;

        return toRisk(rows[0]);
      });
    },

    async approveRiskAssessment(id: string): Promise<RiskAssessment> {
      return tx(async (sql) => {
        const before = await sql<{ case_id: string; approved_at: string | null }[]>`
          select case_id, approved_at from casework.risk_assessments
          where id = ${id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That risk assessment no longer exists.");
        }
        if (before[0].approved_at !== null) {
          throw new CaseworkError(
            "conflict",
            "That risk assessment has already been approved.",
          );
        }

        const rows = await sql<RiskRow[]>`
          update casework.risk_assessments set
            approved_by = ${actor.userId}::uuid, approved_at = now()
          where id = ${id}::uuid
          returning *, null::text as assessed_by_name, null::text as approved_by_name
        `;

        await sql`
          select audit.write(
            'case_risk.approved', 'casework.risk_assessments', ${id},
            ${before[0].case_id}::uuid, null,
            ${sql.json({ approvedBy: actor.userId })},
            'risk assessment approved, which is what unblocks assignment on a critical case'
          )
        `;

        return toRisk(rows[0]);
      });
    },

    /* --------------------------------------------------------------- scope */

    async scopeVersions(caseId: string): Promise<ScopeVersion[]> {
      return tx(async (sql) => {
        const rows = await sql<ScopeRow[]>`
          with directory as (${DIRECTORY(sql)})
          select v.*, dir.full_name as created_by_name,
                 scr.change_id as change_request_reference
          from casework.scope_versions v
          left join directory dir on dir.user_id = v.created_by
          left join casework.scope_change_requests scr on scr.id = v.change_request_id
          where v.case_id = ${caseId}::uuid
          order by v.version_no desc
        `;
        return rows.map(toScope);
      });
    },

    async setOriginalScope(input): Promise<ScopeVersion> {
      return tx(async (sql) => {
        const existingVersions = await sql<{ n: string }[]>`
          select count(*) as n from casework.scope_versions
          where case_id = ${input.caseId}::uuid
        `;
        if (Number(existingVersions[0].n) > 0) {
          // The original is immutable (PRD 5.4), so there is exactly one way
          // to get a second version and this is not it.
          throw new CaseworkError(
            "scope_immutable",
            "This case already has a scope. The original is immutable: raise a scope change request, which produces the next version.",
          );
        }

        const rows = await sql<ScopeRow[]>`
          insert into casework.scope_versions
            (case_id, version_no, scope, out_of_scope, created_by)
          values (${input.caseId}::uuid, 1, ${input.scope},
                  ${input.outOfScope ?? null}, ${actor.userId}::uuid)
          returning *, null::text as created_by_name,
                    null::text as change_request_reference
        `;

        await sql`
          select audit.write(
            'case_scope.set', 'casework.scope_versions', ${rows[0].id},
            ${input.caseId}::uuid, null,
            ${sql.json({ versionNo: 1, scope: input.scope })},
            'original scope recorded, and it is immutable from here'
          )
        `;

        return toScope(rows[0]);
      });
    },

    async scopeChangeRequests(caseId: string): Promise<ScopeChangeRequest[]> {
      return tx(async (sql) => {
        const rows = await sql<ScopeChangeRow[]>`
          with directory as (${DIRECTORY(sql)})
          select scr.*, dir.full_name as requested_by_name,
                 dir_ap.full_name as approving_officer_name,
                 v.version_no as resulting_version_no
          from casework.scope_change_requests scr
          left join directory dir    on dir.user_id = scr.requested_by
          left join directory dir_ap on dir_ap.user_id = scr.approving_officer
          left join casework.scope_versions v on v.id = scr.resulting_version_id
          where scr.case_id = ${caseId}::uuid
          order by scr.requested_at desc
        `;
        return rows.map(toScopeChange);
      });
    },

    async requestScopeChange(input): Promise<ScopeChangeRequest> {
      return tx(async (sql) => {
        const pending = await sql<{ change_id: string }[]>`
          select change_id from casework.scope_change_requests
          where case_id = ${input.caseId}::uuid and status = 'pending'
          limit 1
        `;
        if (pending.length > 0) {
          // Two open requests would race to produce version N+1, and the
          // second would be approving a scope that no longer exists.
          throw new CaseworkError(
            "conflict",
            `${pending[0].change_id} is still awaiting a decision. Decide or withdraw it before raising another.`,
          );
        }

        const rows = await sql<ScopeChangeRow[]>`
          insert into casework.scope_change_requests (
            case_id, reason, proposed_scope, proposed_out_of_scope,
            additional_cost, additional_cost_currency, additional_days,
            client_approval_reference, requested_by
          ) values (
            ${input.caseId}::uuid, ${input.reason}, ${input.proposedScope},
            ${input.proposedOutOfScope ?? null}, ${input.additionalCost ?? null},
            ${input.additionalCostCurrency ?? null}, ${input.additionalDays ?? null},
            ${input.clientApprovalReference ?? null}, ${actor.userId}::uuid
          )
          returning *, null::text as requested_by_name,
                    null::text as approving_officer_name,
                    null::int as resulting_version_no
        `;

        await sql`
          select audit.write(
            'scope_change.requested', 'casework.scope_change_requests',
            ${rows[0].id}, ${input.caseId}::uuid, null,
            ${sql.json({
              changeId: rows[0].change_id,
              additionalCost: input.additionalCost ?? null,
              additionalDays: input.additionalDays ?? null,
            })},
            ${input.reason}
          )
        `;

        return toScopeChange(rows[0]);
      });
    },

    async decideScopeChange(input): Promise<ScopeChangeRequest> {
      return tx(async (sql) => {
        const before = await sql<ScopeChangeRow[]>`
          select *, null::text as requested_by_name,
                 null::text as approving_officer_name,
                 null::int as resulting_version_no
          from casework.scope_change_requests
          where id = ${input.id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That change request no longer exists.");
        }
        if (before[0].status !== "pending") {
          throw new CaseworkError(
            "conflict",
            `That change request is already ${before[0].status}.`,
          );
        }

        let versionId: string | null = null;

        if (input.approve) {
          // The revised scope and the decision that produced it are written in
          // the same transaction, so they can never be out of step.
          const next = await sql<{ next_no: number }[]>`
            select coalesce(max(version_no), 0) + 1 as next_no
            from casework.scope_versions
            where case_id = ${before[0].case_id}::uuid
          `;

          const version = await sql<{ id: string }[]>`
            insert into casework.scope_versions (
              case_id, version_no, scope, out_of_scope, change_request_id, created_by
            ) values (
              ${before[0].case_id}::uuid, ${next[0].next_no},
              ${before[0].proposed_scope}, ${before[0].proposed_out_of_scope},
              ${input.id}::uuid, ${actor.userId}::uuid
            )
            returning id
          `;
          versionId = version[0].id;
        }

        const rows = await sql<ScopeChangeRow[]>`
          update casework.scope_change_requests set
            status = ${input.approve ? "approved" : "rejected"},
            approving_officer = ${actor.userId}::uuid,
            approved_at = now(),
            decision_reason = ${input.decisionReason},
            resulting_version_id = ${versionId}::uuid,
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid
          returning *, null::text as requested_by_name,
                    null::text as approving_officer_name,
                    null::int as resulting_version_no
        `;

        await sql`
          select audit.write(
            ${input.approve ? "scope_change.approved" : "scope_change.rejected"},
            'casework.scope_change_requests', ${input.id},
            ${before[0].case_id}::uuid,
            ${sql.json({ status: "pending" })},
            ${sql.json({
              status: input.approve ? "approved" : "rejected",
              resultingVersionId: versionId,
            })},
            ${input.decisionReason}
          )
        `;

        return toScopeChange(rows[0]);
      });
    },

    async withdrawScopeChange(id: string, reason: string): Promise<ScopeChangeRequest> {
      return tx(async (sql) => {
        const rows = await sql<ScopeChangeRow[]>`
          update casework.scope_change_requests set
            status = 'withdrawn', decision_reason = ${reason},
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and status = 'pending'
          returning *, null::text as requested_by_name,
                    null::text as approving_officer_name,
                    null::int as resulting_version_no
        `;
        if (rows.length === 0) {
          throw new CaseworkError(
            "conflict",
            "That change request is no longer pending, so it cannot be withdrawn.",
          );
        }

        await sql`
          select audit.write(
            'scope_change.withdrawn', 'casework.scope_change_requests', ${id},
            ${rows[0].case_id}::uuid, ${sql.json({ status: "pending" })},
            ${sql.json({ status: "withdrawn" })}, ${reason}
          )
        `;

        return toScopeChange(rows[0]);
      });
    },

    /* ------------------------------------------------------ communications */

    async communications(caseId: string): Promise<CaseCommunication[]> {
      return tx(async (sql) => {
        const rows = await sql<CommunicationRow[]>`
          with directory as (${DIRECTORY(sql)})
          select cc.*, dir.full_name as created_by_name
          from casework.case_communications cc
          left join directory dir on dir.user_id = cc.created_by
          where cc.case_id = ${caseId}::uuid and cc.deleted_at is null
          order by cc.occurred_at desc
        `;
        return rows.map(toCommunication);
      });
    },

    async logCommunication(input): Promise<CaseCommunication> {
      return tx(async (sql) => {
        const rows = await sql<CommunicationRow[]>`
          insert into casework.case_communications (
            case_id, occurred_at, direction, kind, channel, sender, recipient,
            subject, body, attachment_reference, classification, created_by
          ) values (
            ${input.caseId}::uuid,
            coalesce(${input.occurredAt ?? null}::timestamptz, now()),
            ${input.direction}, ${input.kind}, ${input.channel}, ${input.sender},
            ${input.recipient}, ${input.subject}, ${input.body ?? null},
            ${input.attachmentReference ?? null}, ${input.classification},
            ${actor.userId}::uuid
          )
          returning *, null::text as created_by_name
        `;

        await sql`
          select audit.write(
            'case_communication.logged', 'casework.case_communications',
            ${rows[0].id}, ${input.caseId}::uuid, null,
            ${sql.json({
              kind: input.kind,
              direction: input.direction,
              subject: input.subject,
            })},
            null, ${input.classification}
          )
        `;

        return toCommunication(rows[0]);
      });
    },

    async updateCommunication(id, input): Promise<CaseCommunication> {
      return tx(async (sql) => {
        const before = await sql<CommunicationRow[]>`
          select *, null::text as created_by_name
          from casework.case_communications
          where id = ${id}::uuid and deleted_at is null
        `;
        if (before.length === 0) {
          throw new CaseworkError(
            "not_found",
            "That communication no longer exists.",
          );
        }
        if (before[0].version !== input.expectedVersion) {
          throw new CaseworkError(
            "stale_version",
            "This entry changed since you opened it. Reload and try again.",
          );
        }

        const rows = await sql<CommunicationRow[]>`
          update casework.case_communications set
            subject = coalesce(${input.subject ?? null}, subject),
            body = ${input.body === undefined ? sql`body` : input.body},
            attachment_reference = ${input.attachmentReference === undefined ? sql`attachment_reference` : input.attachmentReference},
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${input.expectedVersion}
          returning *, null::text as created_by_name
        `;
        if (rows.length === 0) {
          throw new CaseworkError(
            "stale_version",
            "This entry changed while saving. Reload and try again.",
          );
        }

        await sql`
          select audit.write(
            'case_communication.updated', 'casework.case_communications', ${id},
            ${before[0].case_id}::uuid,
            ${sql.json({ subject: before[0].subject, body: before[0].body })},
            ${sql.json({ subject: rows[0].subject, body: rows[0].body })},
            null
          )
        `;

        return toCommunication(rows[0]);
      });
    },

    async removeCommunication(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        // Read first, write second: the case id is needed for the audit
        // entry, and a soft delete cannot return it (see softDelete above).
        const existing = await sql<{ case_id: string }[]>`
          select case_id from casework.case_communications
          where id = ${id}::uuid and deleted_at is null
        `;
        const rows = await sql`
          update casework.case_communications
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (existing.length === 0 || rows.count === 0) {
          throw new CaseworkError("not_found", "That communication no longer exists.");
        }
        await sql`
          select audit.write(
            'case_communication.removed', 'casework.case_communications', ${id},
            ${existing[0].case_id}::uuid, null, null, ${reason}
          )
        `;
      });
    },

    /* ------------------------------------------------------------- summary */

    /**
     * The tab bar's casework figures, in one statement.
     *
     * Four numbers from three tables. It used to be three separate
     * repository calls, which meant three transactions and three pooler
     * connections for a row of badges.
     */
    async tabCounts(caseId) {
      return tx(async (sql) => {
        const [row] = await sql<
          {
            open_tasks: string;
            overdue_tasks: string;
            activities: string;
            plan_awaiting_review: boolean;
          }[]
        >`
          select
            (
              select count(*) from casework.tasks t
              where t.case_id = ${caseId}::uuid and t.deleted_at is null
                and t.status not in ('completed', 'cancelled')
            ) as open_tasks,
            (
              select count(*) from casework.tasks t
              where t.case_id = ${caseId}::uuid and t.deleted_at is null
                and t.status not in ('completed', 'cancelled')
                and t.due_date < current_date
            ) as overdue_tasks,
            (
              select count(*) from casework.activities a
              where a.case_id = ${caseId}::uuid
            ) as activities,
            exists (
              select 1
              from casework.plan_versions v
              join casework.investigation_plans p on p.id = v.plan_id
              where p.case_id = ${caseId}::uuid and v.status = 'submitted'
            ) as plan_awaiting_review
        `;

        return {
          openTasks: Number(row.open_tasks),
          overdueTasks: Number(row.overdue_tasks),
          activities: Number(row.activities),
          planAwaitingReview: row.plan_awaiting_review,
        };
      });
    },

    async summary(forUserId?: string) {
      return tx(async (sql) => {
        const rows = await sql<
          {
            total: string;
            open: string;
            mine: string;
            overdue: string;
            critical_risk: string;
            awaiting_approval: string;
          }[]
        >`
          select
            count(*) as total,
            count(*) filter (where not s.is_terminal) as open,
            count(*) filter (
              where ${forUserId ?? null}::uuid is not null
                and exists (
                  select 1 from casework.case_assignments a
                  where a.case_id = c.id
                    and a.user_id = ${forUserId ?? null}::uuid
                    and a.unassigned_at is null
                )
            ) as mine,
            count(*) filter (
              where c.target_completion_at < now() and not s.is_terminal
            ) as overdue,
            count(*) filter (where c.risk_level = 'critical' and not s.is_terminal)
              as critical_risk,
            count(*) filter (where s.requires_approval and not s.is_terminal)
              as awaiting_approval
          from casework.cases c
          join config.workflow_stages s on s.id = c.stage_id
          where c.deleted_at is null
        `;
        const row = rows[0];
        return {
          total: Number(row?.total ?? 0),
          open: Number(row?.open ?? 0),
          mine: Number(row?.mine ?? 0),
          overdue: Number(row?.overdue ?? 0),
          criticalRisk: Number(row?.critical_risk ?? 0),
          awaitingApproval: Number(row?.awaiting_approval ?? 0),
        };
      });
    },
  };
}

/* ------------------------------------------------------------- row mapping */

interface AssignmentRow {
  id: string;
  case_id: string;
  user_id: string;
  user_name: string | null;
  user_email: string | null;
  role: CaseAssignment["role"];
  assigned_at: string;
  assigned_by: string | null;
  assigned_by_name: string | null;
  reason: string | null;
  unassigned_at: string | null;
  unassigned_by: string | null;
  unassign_reason: string | null;
}

function toAssignment(row: AssignmentRow): CaseAssignment {
  return {
    id: row.id,
    caseId: row.case_id,
    userId: row.user_id,
    userName: row.user_name ?? "Name not set",
    userEmail: row.user_email ?? "",
    role: row.role,
    assignedAt: row.assigned_at,
    assignedBy: row.assigned_by,
    assignedByName: row.assigned_by_name,
    reason: row.reason,
    unassignedAt: row.unassigned_at,
    unassignedBy: row.unassigned_by,
    unassignReason: row.unassign_reason,
  };
}

interface ObjectiveRow {
  id: string;
  case_id: string;
  client_instruction: string | null;
  objective: string;
  questions: string[];
  deliverables: string[];
  deadline: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  version: number;
}

function toObjective(row: ObjectiveRow): CaseObjective {
  return {
    id: row.id,
    caseId: row.case_id,
    clientInstruction: row.client_instruction,
    objective: row.objective,
    questions: row.questions ?? [],
    deliverables: row.deliverables ?? [],
    deadline: row.deadline,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function objectiveShape(row: ObjectiveRow) {
  return {
    objective: row.objective,
    clientInstruction: row.client_instruction,
    questions: row.questions,
    deliverables: row.deliverables,
    deadline: row.deadline,
  };
}

interface RiskRow {
  id: string;
  case_id: string;
  operational_risk: RiskAssessment["operationalRisk"];
  legal_risk: RiskAssessment["legalRisk"];
  reputational_risk: RiskAssessment["reputationalRisk"];
  safety_risk: RiskAssessment["safetyRisk"];
  sensitivity_risk: RiskAssessment["sensitivityRisk"];
  overall_risk: RiskAssessment["overallRisk"];
  rationale: string;
  assessed_by: string | null;
  assessed_by_name: string | null;
  assessed_at: string;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  created_at: string;
}

function toRisk(row: RiskRow): RiskAssessment {
  return {
    id: row.id,
    caseId: row.case_id,
    operationalRisk: row.operational_risk,
    legalRisk: row.legal_risk,
    reputationalRisk: row.reputational_risk,
    safetyRisk: row.safety_risk,
    sensitivityRisk: row.sensitivity_risk,
    overallRisk: row.overall_risk,
    rationale: row.rationale,
    assessedBy: row.assessed_by,
    assessedByName: row.assessed_by_name,
    assessedAt: row.assessed_at,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}

interface ScopeRow {
  id: string;
  case_id: string;
  version_no: number;
  scope: string;
  out_of_scope: string | null;
  change_request_id: string | null;
  change_request_reference: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
}

function toScope(row: ScopeRow): ScopeVersion {
  return {
    id: row.id,
    caseId: row.case_id,
    versionNo: row.version_no,
    scope: row.scope,
    outOfScope: row.out_of_scope,
    changeRequestId: row.change_request_id,
    changeRequestReference: row.change_request_reference,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
  };
}

interface ScopeChangeRow {
  id: string;
  change_id: string;
  case_id: string;
  reason: string;
  proposed_scope: string;
  proposed_out_of_scope: string | null;
  additional_cost: string | null;
  additional_cost_currency: string | null;
  additional_days: number | null;
  client_approval_reference: string | null;
  status: ScopeChangeRequest["status"];
  requested_by: string | null;
  requested_by_name: string | null;
  requested_at: string;
  approving_officer: string | null;
  approving_officer_name: string | null;
  approved_at: string | null;
  decision_reason: string | null;
  resulting_version_id: string | null;
  resulting_version_no: number | null;
  created_at: string;
  version: number;
}

function toScopeChange(row: ScopeChangeRow): ScopeChangeRequest {
  return {
    id: row.id,
    changeId: row.change_id,
    caseId: row.case_id,
    reason: row.reason,
    proposedScope: row.proposed_scope,
    proposedOutOfScope: row.proposed_out_of_scope,
    additionalCost:
      row.additional_cost === null ? null : Number(row.additional_cost),
    additionalCostCurrency: row.additional_cost_currency,
    additionalDays: row.additional_days,
    clientApprovalReference: row.client_approval_reference,
    status: row.status,
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name,
    requestedAt: row.requested_at,
    approvingOfficer: row.approving_officer,
    approvingOfficerName: row.approving_officer_name,
    approvedAt: row.approved_at,
    decisionReason: row.decision_reason,
    resultingVersionId: row.resulting_version_id,
    resultingVersionNo: row.resulting_version_no,
    createdAt: row.created_at,
    version: row.version,
  };
}

interface CommunicationRow {
  id: string;
  case_id: string;
  occurred_at: string;
  direction: CaseCommunication["direction"];
  kind: CaseCommunication["kind"];
  channel: CaseCommunication["channel"];
  sender: string;
  recipient: string;
  subject: string;
  body: string | null;
  attachment_reference: string | null;
  classification: CaseCommunication["classification"];
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: string;
  version: number;
  deleted_at: string | null;
}

function toCommunication(row: CommunicationRow): CaseCommunication {
  return {
    id: row.id,
    caseId: row.case_id,
    occurredAt: row.occurred_at,
    direction: row.direction,
    kind: row.kind,
    channel: row.channel,
    sender: row.sender,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    attachmentReference: row.attachment_reference,
    classification: row.classification,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
  };
}

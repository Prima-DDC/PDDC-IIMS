import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { ReportingError } from "../domain/errors";
import type { CaseClosure, ManagementReport, RetentionClass } from "../domain/types";
import type {
  ClosureRepository,
  ManagementRepository,
} from "../application/ports";

/**
 * Case closure and the management reports (PRD 5.9, 10.4).
 *
 * `gateState` is the method that matters. PRD 5.9's nine requirements include
 * three the platform can answer for itself: whether every task is finished,
 * whether a report has been approved, and whether a delivery was recorded. It
 * reads those from the records rather than offering a box to tick, because a
 * checklist that lets somebody attest to "report approved" when no report
 * exists looks like assurance and is none.
 *
 * `decide` closes the case in the same transaction as approving the closure.
 * Two statements would leave a window in which the closure says approved and
 * the case says open, and whichever a screen read would be wrong.
 */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

function transactor(actor: ActorContext, existing?: postgres.TransactionSql) {
  return async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };
}

interface ClosureRow {
  id: string;
  case_id: string;
  case_reference: string;
  objectives_outcome: string;
  evidence_disposition: string;
  outstanding_issues: string | null;
  financial_status: string;
  retention_class: string;
  retention_class_name: string | null;
  what_worked: string | null;
  what_did_not_work: string | null;
  challenges: string | null;
  new_sources: string | null;
  new_typologies: string | null;
  methodological_lessons: string | null;
  recommendations: string | null;
  contribute_to_knowledge_base: boolean;
  status: CaseClosure["status"];
  proposed_by: string;
  proposed_by_name: string | null;
  proposed_at: string;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  review_notes: string | null;
  version: number;
}

function toClosure(row: ClosureRow): CaseClosure {
  return {
    id: row.id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    objectivesOutcome: row.objectives_outcome,
    evidenceDisposition: row.evidence_disposition,
    outstandingIssues: row.outstanding_issues,
    financialStatus: row.financial_status,
    retentionClass: row.retention_class,
    retentionClassName: row.retention_class_name,
    whatWorked: row.what_worked,
    whatDidNotWork: row.what_did_not_work,
    challenges: row.challenges,
    newSources: row.new_sources,
    newTypologies: row.new_typologies,
    methodologicalLessons: row.methodological_lessons,
    recommendations: row.recommendations,
    contributeToKnowledgeBase: row.contribute_to_knowledge_base,
    status: row.status,
    proposedBy: row.proposed_by,
    proposedByName: row.proposed_by_name,
    proposedAt: row.proposed_at,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at,
    reviewNotes: row.review_notes,
    version: row.version,
  };
}

const CLOSURE_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    cl.id, cl.case_id, c.case_id as case_reference,
    cl.objectives_outcome, cl.evidence_disposition, cl.outstanding_issues,
    cl.financial_status, cl.retention_class, rc.name as retention_class_name,
    cl.what_worked, cl.what_did_not_work, cl.challenges, cl.new_sources,
    cl.new_typologies, cl.methodological_lessons, cl.recommendations,
    cl.contribute_to_knowledge_base,
    cl.status,
    cl.proposed_by, pb.full_name as proposed_by_name, cl.proposed_at,
    cl.approved_by, ab.full_name as approved_by_name, cl.approved_at,
    cl.review_notes, cl.version
  from casework.case_closures cl
  join casework.cases c on c.id = cl.case_id
  left join config.retention_classes rc on rc.code = cl.retention_class
  left join directory pb on pb.user_id = cl.proposed_by
  left join directory ab on ab.user_id = cl.approved_by
`;

export function createClosureRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): ClosureRepository {
  const tx = transactor(actor, existing);

  const load = async (
    sql: postgres.TransactionSql,
    caseId: string,
  ): Promise<CaseClosure | null> => {
    const rows = await sql<ClosureRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${CLOSURE_SELECT(sql)}
      where cl.case_id = ${caseId}::uuid
    `;
    return rows.length > 0 ? toClosure(rows[0]) : null;
  };

  return {
    async retentionClasses() {
      return tx(async (sql) => {
        const rows = await sql<RetentionClass[]>`
          select code, name, years, description
          from config.retention_classes
          where is_active
          order by position
        `;
        return rows;
      });
    },

    async forCase(caseId) {
      return tx((sql) => load(sql, caseId));
    },

    /**
     * The three computed requirements, plus whether an objective exists.
     *
     * One query, because the closure screen reads them together and each one
     * on its own connection would be four round trips for one gate.
     */
    async gateState(caseId) {
      return tx(async (sql) => {
        const [row] = await sql<
          {
            open_tasks: string;
            report_approved: boolean;
            delivery_recorded: boolean;
            evidence_on_release: string;
            objectives_recorded: boolean;
          }[]
        >`
          select
            (
              select count(*) from casework.tasks t
              where t.case_id = ${caseId}::uuid
                and t.deleted_at is null
                and t.status not in ('completed', 'cancelled')
            ) as open_tasks,
            exists (
              select 1 from reporting.reports r
              where r.case_id = ${caseId}::uuid
                and r.deleted_at is null
                and r.approved_version_id is not null
            ) as report_approved,
            exists (
              select 1 from reporting.deliveries d
              join reporting.reports r on r.id = d.report_id
              where r.case_id = ${caseId}::uuid and r.deleted_at is null
            ) as delivery_recorded,
            (
              select count(*) from evidence.evidence_items e
              where e.case_id = ${caseId}::uuid
                and e.deleted_at is null
                and e.status = 'released'
            ) as evidence_on_release,
            exists (
              select 1 from casework.case_objectives o
              where o.case_id = ${caseId}::uuid
            ) as objectives_recorded
        `;

        return {
          openTaskCount: Number(row.open_tasks),
          reportApproved: row.report_approved,
          deliveryRecorded: row.delivery_recorded,
          evidenceOnRelease: Number(row.evidence_on_release),
          objectivesRecorded: row.objectives_recorded,
        };
      });
    },

    async propose(input) {
      return tx(async (sql) => {
        const [created] = await sql<{ id: string }[]>`
          insert into casework.case_closures (
            case_id, objectives_outcome, evidence_disposition,
            outstanding_issues, financial_status, retention_class,
            what_worked, what_did_not_work, challenges, new_sources,
            new_typologies, methodological_lessons, recommendations,
            contribute_to_knowledge_base, proposed_by, created_by, updated_by
          ) values (
            ${input.caseId}::uuid, ${input.objectivesOutcome},
            ${input.evidenceDisposition}, ${input.outstandingIssues ?? null},
            ${input.financialStatus}, ${input.retentionClass},
            ${input.whatWorked ?? null}, ${input.whatDidNotWork ?? null},
            ${input.challenges ?? null}, ${input.newSources ?? null},
            ${input.newTypologies ?? null}, ${input.methodologicalLessons ?? null},
            ${input.recommendations ?? null},
            ${input.contributeToKnowledgeBase ?? false},
            ${actor.userId}::uuid, ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          on conflict (case_id) do update set
            objectives_outcome = excluded.objectives_outcome,
            evidence_disposition = excluded.evidence_disposition,
            outstanding_issues = excluded.outstanding_issues,
            financial_status = excluded.financial_status,
            retention_class = excluded.retention_class,
            what_worked = excluded.what_worked,
            what_did_not_work = excluded.what_did_not_work,
            challenges = excluded.challenges,
            new_sources = excluded.new_sources,
            new_typologies = excluded.new_typologies,
            methodological_lessons = excluded.methodological_lessons,
            recommendations = excluded.recommendations,
            contribute_to_knowledge_base = excluded.contribute_to_knowledge_base,
            -- A returned closure put forward again goes back to proposed,
            -- with the new proposer, so the supervisor sees it as a fresh
            -- decision rather than the one they already returned.
            status = 'proposed',
            proposed_by = ${actor.userId}::uuid,
            proposed_at = now(),
            approved_by = null,
            approved_at = null,
            updated_by = ${actor.userId}::uuid
          returning id
        `;

        await sql`
          select audit.write(
            'case.closure_proposed', 'casework.case_closures', ${created.id},
            ${input.caseId}::uuid, null,
            ${sql.json({ retentionClass: input.retentionClass })},
            null, null
          )
        `;

        const closure = await load(sql, input.caseId);
        if (!closure) {
          throw new ReportingError(
            "not_found",
            "That closure was written but cannot be read back.",
          );
        }
        return closure;
      });
    },

    async update(caseId, input, expectedVersion) {
      return tx(async (sql) => {
        const result = await sql`
          update casework.case_closures set
            objectives_outcome = coalesce(${input.objectivesOutcome ?? null}, objectives_outcome),
            evidence_disposition = coalesce(${input.evidenceDisposition ?? null}, evidence_disposition),
            outstanding_issues = ${input.outstandingIssues ?? null},
            financial_status = coalesce(${input.financialStatus ?? null}, financial_status),
            retention_class = coalesce(${input.retentionClass ?? null}, retention_class),
            what_worked = ${input.whatWorked ?? null},
            what_did_not_work = ${input.whatDidNotWork ?? null},
            challenges = ${input.challenges ?? null},
            new_sources = ${input.newSources ?? null},
            new_typologies = ${input.newTypologies ?? null},
            methodological_lessons = ${input.methodologicalLessons ?? null},
            recommendations = ${input.recommendations ?? null},
            contribute_to_knowledge_base = coalesce(
              ${input.contributeToKnowledgeBase ?? null}, contribute_to_knowledge_base
            ),
            updated_by = ${actor.userId}::uuid
          where case_id = ${caseId}::uuid and version = ${expectedVersion}
        `;
        if (result.count === 0) {
          throw new ReportingError(
            "stale_version",
            "Somebody else changed this closure while you were editing it.",
          );
        }
        const closure = await load(sql, caseId);
        if (!closure) {
          throw new ReportingError("not_found", "That closure no longer exists.");
        }
        return closure;
      });
    },

    /**
     * The supervisor's decision, and the case closing with it.
     *
     * One transaction. The case moves to its terminal stage only when the
     * closure is approved, which is what makes "archived" readable as a
     * closed case whose closure was approved rather than a separate store.
     */
    async decide(input) {
      return tx(async (sql) => {
        const before = await load(sql, input.caseId);
        if (!before) {
          throw new ReportingError(
            "not_found",
            "No closure has been proposed for this case.",
          );
        }
        if (before.status !== "proposed") {
          throw new ReportingError(
            "conflict",
            `This closure has already been ${before.status}.`,
          );
        }

        await sql`
          update casework.case_closures set
            status = ${input.status},
            approved_by = ${actor.userId}::uuid,
            approved_at = now(),
            review_notes = ${input.reviewNotes ?? null},
            updated_by = ${actor.userId}::uuid
          where case_id = ${input.caseId}::uuid and status = 'proposed'
        `;

        if (input.status === "approved") {
          // The terminal stage of the configured lifecycle, read rather than
          // named, so an administrator who renames it does not break closure.
          // The terminal stage of the case's OWN lifecycle definition, not
          // of whichever definition happens to be active: a case opened under
          // an earlier workflow closes under that workflow.
          const [terminal] = await sql<{ id: string; name: string }[]>`
            select s.id, s.name
            from config.workflow_stages s
            join casework.cases c on c.definition_id = s.definition_id
            where c.id = ${input.caseId}::uuid and s.is_terminal
            order by s.position desc
            limit 1
          `;

          if (!terminal) {
            throw new ReportingError(
              "conflict",
              "The configured lifecycle has no terminal stage, so a case cannot be closed. An administrator has to add one.",
            );
          }

          // The case carries its own retention class and closure summary,
          // which is what the archive screen reads, so the two are written
          // together rather than left to disagree.
          await sql`
            update casework.cases set
              stage_id = ${terminal.id}::uuid,
              closed_at = now(),
              closed_by = ${actor.userId}::uuid,
              actual_completion_at = coalesce(actual_completion_at, now()),
              retention_class = ${before.retentionClass},
              closure_summary = ${before.objectivesOutcome},
              updated_by = ${actor.userId}::uuid
            where id = ${input.caseId}::uuid
          `;
        }

        await sql`
          select audit.write(
            'case.closure_decided', 'casework.case_closures', ${before.id},
            ${input.caseId}::uuid,
            ${sql.json({ status: before.status })},
            ${sql.json({ status: input.status })},
            ${input.reviewNotes ?? null}, null
          )
        `;

        const closure = await load(sql, input.caseId);
        if (!closure) {
          throw new ReportingError("not_found", "That closure no longer exists.");
        }
        return closure;
      });
    },

    async knowledgeBase(filter) {
      return tx(async (sql) => {
        const rows = await sql<ClosureRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${CLOSURE_SELECT(sql)}
          where cl.contribute_to_knowledge_base
            and cl.status = 'approved'
          order by cl.approved_at desc
          limit ${Math.min(filter.limit ?? 50, 200)}
        `;
        return rows.map(toClosure);
      });
    },
  };
}

/* --------------------------------------------- management reports (10.4) */

export function createManagementRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): ManagementRepository {
  const tx = transactor(actor, existing);

  return {
    /**
     * PRD 10.4's six figures.
     *
     * Read in parallel, each one its own query, because they are six
     * different questions and a single query answering all of them would be
     * unreadable and no faster. Every one of them goes through row-level
     * security, so two managers legitimately see different numbers.
     */
    async report(filter) {
      return tx(async (sql) => {
        const since = filter.since ?? null;

        const [
          register,
          turnaround,
          workload,
          overdue,
          qa,
          commercials,
        ] = await Promise.all([
          sql<
            {
              case_id: string;
              case_reference: string;
              title: string;
              client_name: string | null;
              stage_name: string;
              risk_level: string;
              opened_at: string;
              closed_at: string | null;
              lead_investigator_name: string | null;
              days_open: string;
            }[]
          >`
            with directory as (${DIRECTORY(sql)})
            select
              c.id as case_id, c.case_id as case_reference, c.title,
              cl.organisation_name as client_name,
              s.name as stage_name, c.risk_level,
              c.opened_at, c.closed_at,
              li.full_name as lead_investigator_name,
              extract(day from coalesce(c.closed_at, now()) - c.opened_at)::int
                as days_open
            from casework.cases c
            left join crm.clients cl on cl.id = c.client_id
            left join config.workflow_stages s on s.id = c.stage_id
            left join casework.case_assignments a
              on a.case_id = c.id
             and a.role = 'lead_investigator'
             and a.unassigned_at is null
            left join directory li on li.user_id = a.user_id
            where c.deleted_at is null
              and (${since}::timestamptz is null or c.opened_at >= ${since}::timestamptz)
              and (${filter.office ?? null}::uuid is null
                   or c.office_id = ${filter.office ?? null}::uuid)
            order by c.opened_at desc
            limit 500
          `,
          sql<{ closed: string; median_days: string | null; longest_days: string | null }[]>`
            select
              count(*) as closed,
              percentile_cont(0.5) within group (
                order by extract(day from c.closed_at - c.opened_at)
              )::numeric(10,1) as median_days,
              max(extract(day from c.closed_at - c.opened_at))::int as longest_days
            from casework.cases c
            where c.deleted_at is null and c.closed_at is not null
              and (${since}::timestamptz is null or c.closed_at >= ${since}::timestamptz)
          `,
          sql<
            {
              user_id: string;
              name: string | null;
              open_cases: string;
              open_tasks: string;
              overdue_tasks: string;
            }[]
          >`
            with directory as (${DIRECTORY(sql)})
            select
              u.id as user_id, d.full_name as name,
              (
                select count(distinct a.case_id)
                from casework.case_assignments a
                join casework.cases c on c.id = a.case_id
                where a.user_id = u.id and a.unassigned_at is null
                  and c.deleted_at is null and c.closed_at is null
              ) as open_cases,
              (
                select count(*) from casework.tasks t
                where t.assigned_to = u.id and t.deleted_at is null
                  and t.status not in ('completed', 'cancelled')
              ) as open_tasks,
              (
                select count(*) from casework.tasks t
                where t.assigned_to = u.id and t.deleted_at is null
                  and t.status not in ('completed', 'cancelled')
                  and t.due_date < current_date
              ) as overdue_tasks
            from iam.users u
            join directory d on d.user_id = u.id
            where u.status = 'active' and u.deleted_at is null
            order by d.full_name
          `,
          sql<
            {
              task_id: string;
              task_reference: string;
              title: string;
              case_reference: string;
              assignee_name: string | null;
              due_at: string;
              days_overdue: string;
            }[]
          >`
            with directory as (${DIRECTORY(sql)})
            select
              t.id as task_id, t.task_id as task_reference, t.title,
              c.case_id as case_reference,
              d.full_name as assignee_name,
              t.due_date as due_at,
              (current_date - t.due_date)::int as days_overdue
            from casework.tasks t
            join casework.cases c on c.id = t.case_id
            left join directory d on d.user_id = t.assigned_to
            where t.deleted_at is null
              and t.status not in ('completed', 'cancelled')
              and t.due_date < current_date
            order by t.due_date
            limit 200
          `,
          sql<{ completed: string; returned: string }[]>`
            select
              count(*) as completed,
              count(*) filter (where result = 'returned') as returned
            from reporting.qa_reviews
            where completed_at is not null
              and (${since}::timestamptz is null
                   or completed_at >= ${since}::timestamptz)
          `,
          sql<
            {
              case_id: string;
              case_reference: string;
              title: string;
              currency: string | null;
              billed: string | null;
              cost: string | null;
            }[]
          >`
            -- Billed is what was invoiced, not what was quoted: a quote is
            -- an intention and PRD 10.4 asks for revenue. A written-off case
            -- counts as nothing billed, which is the honest reading.
            select
              c.id as case_id, c.case_id as case_reference, c.title,
              coalesce(f.currency, 'GHS') as currency,
              case
                when f.payment_status = 'written_off' then 0
                else coalesce(f.amount_invoiced, 0)
              end as billed,
              (
                select coalesce(sum(e.amount), 0) from casework.expenses e
                where e.case_id = c.id and e.status = 'approved'
              ) as cost
            from casework.cases c
            left join casework.case_financials f on f.case_id = c.id
            where c.deleted_at is null
              and (${since}::timestamptz is null or c.opened_at >= ${since}::timestamptz)
            order by c.opened_at desc
            limit 500
          `,
        ]);

        const completed = Number(qa[0].completed);

        return {
          caseRegister: register.map((row) => ({
            caseId: row.case_id,
            caseReference: row.case_reference,
            title: row.title,
            clientName: row.client_name ?? "unknown client",
            stageName: row.stage_name,
            riskLevel: row.risk_level,
            openedAt: row.opened_at,
            closedAt: row.closed_at,
            leadInvestigatorName: row.lead_investigator_name,
            daysOpen: Number(row.days_open),
          })),
          turnaround: {
            closedCases: Number(turnaround[0].closed),
            medianDays:
              turnaround[0].median_days === null
                ? null
                : Number(turnaround[0].median_days),
            longestDays:
              turnaround[0].longest_days === null
                ? null
                : Number(turnaround[0].longest_days),
          },
          workload: workload.map((row) => ({
            userId: row.user_id,
            name: row.name ?? "unknown",
            openCases: Number(row.open_cases),
            openTasks: Number(row.open_tasks),
            overdueTasks: Number(row.overdue_tasks),
          })),
          overdueTasks: overdue.map((row) => ({
            taskId: row.task_id,
            taskReference: row.task_reference,
            title: row.title,
            caseReference: row.case_reference,
            assigneeName: row.assignee_name,
            dueAt: row.due_at,
            daysOverdue: Number(row.days_overdue),
          })),
          qaReturnRate: {
            reviewsCompleted: completed,
            returned: Number(qa[0].returned),
            rate: completed === 0 ? null : Number(qa[0].returned) / completed,
          },
          revenueVersusCost: commercials.map((row) => {
            const billed = Number(row.billed ?? 0);
            const cost = Number(row.cost ?? 0);
            return {
              caseId: row.case_id,
              caseReference: row.case_reference,
              title: row.title,
              currency: row.currency ?? "GHS",
              billed,
              cost,
              margin: billed - cost,
            };
          }),
        } satisfies ManagementReport;
      });
    },
  };
}

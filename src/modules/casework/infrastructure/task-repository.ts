import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { CaseworkError } from "../domain/errors";
import { CLOSED_TASK_STATUSES, type Task, type TaskComment } from "../domain/types";
import type {
  CreateTaskInput,
  ListTasksFilter,
  TaskRepository,
  UpdateTaskInput,
} from "../application/task-ports";
import type { Page } from "../application/ports";

/**
 * Tasks and their comments (PRD 9.1, 9.2).
 *
 * Two things here are worth the explanation they get below: `completedAt` is
 * managed entirely by this file so it cannot disagree with the status, and
 * "overdue" is computed from the due date on every read rather than stored.
 * PRD 9.2 asks for a scheduled job to identify overdue tasks and flag them,
 * and that job will send the notifications; the flag itself has to be derived
 * or it goes stale the moment the clock passes midnight.
 */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

const TASK_COLUMNS = (sql: postgres.TransactionSql) => sql`
  t.*,
  c.case_id as case_reference,
  c.title   as case_title,
  dir.full_name as assigned_to_name,
  dir_by.full_name as created_by_name,
  parent.title as parent_task_title,
  (
    select count(*) from casework.task_comments tc
    where tc.task_id = t.id and tc.deleted_at is null
  ) as comment_count,
  (
    select count(*) from casework.tasks sub
    where sub.parent_task_id = t.id and sub.deleted_at is null
  ) as sub_task_count,
  -- Two dates subtract to an integer. An interval does not survive the driver
  -- predictably, which on the case record showed up as nothing ever being
  -- reported late.
  case when t.due_date is null then null else (t.due_date - now()::date) end
    as days_to_due
`;

const TASK_JOINS = (sql: postgres.TransactionSql) => sql`
  from casework.tasks t
  join casework.cases c on c.id = t.case_id
  left join directory dir    on dir.user_id = t.assigned_to
  left join directory dir_by on dir_by.user_id = t.created_by
  left join casework.tasks parent on parent.id = t.parent_task_id
`;

interface TaskRow {
  id: string;
  task_id: string;
  case_id: string;
  case_reference: string;
  case_title: string;
  title: string;
  description: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  priority: Task["priority"];
  start_date: string | null;
  due_date: string | null;
  status: Task["status"];
  status_reason: string | null;
  completed_at: string | null;
  methodology_stage: string | null;
  parent_task_id: string | null;
  parent_task_title: string | null;
  plan_version_id: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: string;
  version: number;
  deleted_at: string | null;
  days_to_due: number | null;
  comment_count: string;
  sub_task_count: string;
}

function toTask(row: TaskRow): Task {
  const days = row.days_to_due === null ? null : Number(row.days_to_due);
  const closed = CLOSED_TASK_STATUSES.includes(row.status);

  return {
    id: row.id,
    taskId: row.task_id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    caseTitle: row.case_title,
    title: row.title,
    description: row.description,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    priority: row.priority,
    startDate: row.start_date,
    dueDate: row.due_date,
    status: row.status,
    statusReason: row.status_reason,
    completedAt: row.completed_at,
    methodologyStage: row.methodology_stage,
    parentTaskId: row.parent_task_id,
    parentTaskTitle: row.parent_task_title,
    planVersionId: row.plan_version_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
    daysToDue: days,
    // A completed or cancelled task is never overdue, however late it was:
    // the work is no longer waiting on anybody.
    isOverdue: days !== null && days < 0 && !closed,
    commentCount: Number(row.comment_count ?? 0),
    subTaskCount: Number(row.sub_task_count ?? 0),
  };
}

function auditShape(row: TaskRow) {
  return {
    title: row.title,
    description: row.description,
    assignedTo: row.assigned_to,
    priority: row.priority,
    startDate: row.start_date,
    dueDate: row.due_date,
    status: row.status,
    methodologyStage: row.methodology_stage,
    parentTaskId: row.parent_task_id,
  };
}

async function loadTask(
  sql: postgres.TransactionSql,
  id: string,
): Promise<Task | null> {
  const rows = await sql<TaskRow[]>`
    with directory as (${DIRECTORY(sql)})
    select ${TASK_COLUMNS(sql)}
    ${TASK_JOINS(sql)}
    where t.id = ${id}::uuid
  `;
  return rows.length > 0 ? toTask(rows[0]) : null;
}

export function createTaskRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): TaskRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  const reload = async (sql: postgres.TransactionSql, id: string): Promise<Task> => {
    const found = await loadTask(sql, id);
    if (!found) {
      throw new CaseworkError(
        "not_found",
        "The task could not be read back after saving.",
      );
    }
    return found;
  };

  return {
    async list(filter: ListTasksFilter): Promise<Page<Task>> {
      const limit = Math.min(filter.limit ?? 50, 200);
      const offset = Math.max(filter.offset ?? 0, 0);
      const sort = filter.sort ?? "due";

      return tx(async (sql) => {
        const rows = await sql<(TaskRow & { total_count: string })[]>`
          with directory as (${DIRECTORY(sql)}),
          filtered as (
            select ${TASK_COLUMNS(sql)}
            ${TASK_JOINS(sql)}
            where (
                    ${filter.onlyDeleted ?? false} and t.deleted_at is not null
                    or ${filter.includeDeleted ?? false}
                    or (not ${filter.onlyDeleted ?? false} and t.deleted_at is null)
                  )
              and (${filter.caseId ?? null}::uuid is null or t.case_id = ${filter.caseId ?? null}::uuid)
              and (${filter.status ?? "all"} = 'all' or t.status = ${filter.status ?? "all"})
              and (
                not ${filter.openOnly ?? false}
                or t.status not in ('completed', 'cancelled')
              )
              and (${filter.priority ?? null}::text is null or t.priority = ${filter.priority ?? null})
              and (${filter.assignedTo ?? null}::uuid is null or t.assigned_to = ${filter.assignedTo ?? null}::uuid)
              and (not ${filter.unassignedOnly ?? false} or t.assigned_to is null)
              and (
                not ${filter.overdueOnly ?? false}
                or (t.due_date < now()::date and t.status not in ('completed','cancelled'))
              )
              and (${filter.methodologyStage ?? null}::text is null or t.methodology_stage = ${filter.methodologyStage ?? null})
              and (not ${filter.topLevelOnly ?? false} or t.parent_task_id is null)
              and (${filter.parentTaskId ?? null}::uuid is null or t.parent_task_id = ${filter.parentTaskId ?? null}::uuid)
              and (
                ${filter.search ?? null}::text is null
                or t.title ilike '%' || ${filter.search ?? ""} || '%'
                or t.task_id ilike '%' || ${filter.search ?? ""} || '%'
                or coalesce(t.description, '') ilike '%' || ${filter.search ?? ""} || '%'
              )
          )
          select f.*, count(*) over () as total_count
          from filtered f
          order by
            case when ${sort} = 'title' then f.title end,
            case when ${sort} = 'created' then f.created_at end desc,
            case when ${sort} = 'status' then
              case f.status when 'blocked' then 1 when 'in_progress' then 2
                            when 'not_started' then 3 when 'completed' then 4
                            else 5 end
            end,
            case when ${sort} = 'priority' then
              case f.priority when 'urgent' then 1 when 'high' then 2
                              when 'medium' then 3 else 4 end
            end,
            -- Soonest first, and tasks with no date last rather than first.
            case when ${sort} = 'due' then f.due_date end asc nulls last,
            f.created_at desc
          limit ${limit} offset ${offset}
        `;

        return {
          rows: rows.map(toTask),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async findById(id: string): Promise<Task | null> {
      return tx((sql) => loadTask(sql, id));
    },

    async create(input: CreateTaskInput): Promise<Task> {
      return tx(async (sql) => {
        if (input.assignedTo) {
          const target = await sql<{ status: string }[]>`
            select status from iam.users
            where id = ${input.assignedTo}::uuid and deleted_at is null
          `;
          if (target.length === 0) {
            throw new CaseworkError(
              "not_found",
              "That person does not have access to the platform, so a task cannot be assigned to them.",
            );
          }
          if (target[0].status !== "active") {
            throw new CaseworkError(
              "conflict",
              `That account is ${target[0].status}, so it cannot be given a task.`,
            );
          }
        }

        // A sub-task belongs to the same case as its parent, or the tree spans
        // cases and the case page stops being a complete picture of its work.
        if (input.parentTaskId) {
          const parent = await sql<{ case_id: string }[]>`
            select case_id from casework.tasks
            where id = ${input.parentTaskId}::uuid and deleted_at is null
          `;
          if (parent.length === 0) {
            throw new CaseworkError("not_found", "That parent task no longer exists.");
          }
          if (parent[0].case_id !== input.caseId) {
            throw new CaseworkError(
              "validation_failed",
              "A sub-task has to belong to the same case as its parent.",
            );
          }
        }

        const inserted = await sql<{ id: string }[]>`
          insert into casework.tasks (
            case_id, title, description, assigned_to, priority, start_date,
            due_date, methodology_stage, parent_task_id, plan_version_id, created_by
          ) values (
            ${input.caseId}::uuid, ${input.title}, ${input.description ?? null},
            ${input.assignedTo ?? null}::uuid, ${input.priority},
            ${input.startDate ?? null}::date, ${input.dueDate ?? null}::date,
            ${input.methodologyStage ?? null}, ${input.parentTaskId ?? null}::uuid,
            ${input.planVersionId ?? null}::uuid, ${actor.userId}::uuid
          )
          returning id
        `;

        const id = inserted[0].id;
        const created = await reload(sql, id);

        // PRD 9.2: "every task change is audited and appears in the case
        // activity log". The audit row carries the case id so it does.
        await sql`
          select audit.write(
            'task.created', 'casework.tasks', ${id}, ${input.caseId}::uuid, null,
            ${sql.json({
              taskId: created.taskId,
              title: input.title,
              assignedTo: input.assignedTo ?? null,
              priority: input.priority,
              dueDate: input.dueDate ?? null,
            })},
            ${input.planVersionId ? "from the approved investigation plan" : "added ad hoc"}
          )
        `;

        return created;
      });
    },

    async update(id: string, input: UpdateTaskInput): Promise<Task> {
      return tx(async (sql) => {
        const before = await sql<TaskRow[]>`
          with directory as (${DIRECTORY(sql)})
          select ${TASK_COLUMNS(sql)}
          ${TASK_JOINS(sql)}
          where t.id = ${id}::uuid and t.deleted_at is null
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That task no longer exists.");
        }
        if (before[0].version !== input.expectedVersion) {
          throw new CaseworkError(
            "stale_version",
            "This task changed since you opened it. Reload and try again.",
            { expected: input.expectedVersion, actual: before[0].version },
          );
        }

        const updated = await sql<{ id: string }[]>`
          update casework.tasks set
            title       = coalesce(${input.title ?? null}, title),
            description = ${input.description === undefined ? sql`description` : input.description},
            assigned_to = ${input.assignedTo === undefined ? sql`assigned_to` : sql`${input.assignedTo}::uuid`},
            priority    = coalesce(${input.priority ?? null}, priority),
            start_date  = ${input.startDate === undefined ? sql`start_date` : sql`${input.startDate}::date`},
            due_date    = ${input.dueDate === undefined ? sql`due_date` : sql`${input.dueDate}::date`},
            methodology_stage = ${input.methodologyStage === undefined ? sql`methodology_stage` : input.methodologyStage},
            parent_task_id = ${input.parentTaskId === undefined ? sql`parent_task_id` : sql`${input.parentTaskId}::uuid`},
            updated_by  = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${input.expectedVersion}
          returning id
        `;
        if (updated.length === 0) {
          throw new CaseworkError(
            "stale_version",
            "This task changed while saving. Reload and try again.",
          );
        }

        const after = await sql<TaskRow[]>`
          with directory as (${DIRECTORY(sql)})
          select ${TASK_COLUMNS(sql)}
          ${TASK_JOINS(sql)}
          where t.id = ${id}::uuid
        `;

        await sql`
          select audit.write(
            'task.updated', 'casework.tasks', ${id}, ${before[0].case_id}::uuid,
            ${sql.json(auditShape(before[0]))},
            ${sql.json(auditShape(after[0]))},
            null
          )
        `;

        return toTask(after[0]);
      });
    },

    async setStatus(input): Promise<Task> {
      return tx(async (sql) => {
        const before = await sql<{ status: Task["status"]; case_id: string }[]>`
          select status, case_id from casework.tasks
          where id = ${input.id}::uuid and deleted_at is null
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That task no longer exists.");
        }

        // completed_at is set and cleared here rather than by the caller, so
        // it cannot disagree with the status. The CHECK constraint
        // task_completed_together enforces the pairing; this is what keeps it
        // satisfiable.
        await sql`
          update casework.tasks set
            status = ${input.status},
            status_reason = ${input.reason ?? null},
            completed_at = ${
              input.status === "completed" ? sql`coalesce(completed_at, now())` : null
            },
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid
        `;

        await sql`
          select audit.write(
            'task.status_changed', 'casework.tasks', ${input.id},
            ${before[0].case_id}::uuid,
            ${sql.json({ status: before[0].status })},
            ${sql.json({ status: input.status })},
            ${input.reason ?? null}
          )
        `;

        return reload(sql, input.id);
      });
    },

    async reassign(id: string, userId: string | null, reason: string): Promise<Task> {
      return tx(async (sql) => {
        const before = await sql<{ assigned_to: string | null; case_id: string }[]>`
          select assigned_to, case_id from casework.tasks
          where id = ${id}::uuid and deleted_at is null
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That task no longer exists.");
        }

        if (userId) {
          const target = await sql<{ status: string }[]>`
            select status from iam.users
            where id = ${userId}::uuid and deleted_at is null and status = 'active'
          `;
          if (target.length === 0) {
            throw new CaseworkError(
              "conflict",
              "That person cannot be given a task: they have no active platform access.",
            );
          }
        }

        await sql`
          update casework.tasks
          set assigned_to = ${userId}::uuid, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid
        `;

        await sql`
          select audit.write(
            'task.reassigned', 'casework.tasks', ${id}, ${before[0].case_id}::uuid,
            ${sql.json({ assignedTo: before[0].assigned_to })},
            ${sql.json({ assignedTo: userId })},
            ${reason}
          )
        `;

        return reload(sql, id);
      });
    },

    async softDelete(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        // Read first, write second: the case id is needed for the audit
        // entry, and a soft delete cannot return it. The SELECT policy on a
        // hidden row excludes it, so a RETURNING clause here fails with
        // "new row violates row-level security policy", which reads like a
        // permission fault on the write and is not one.
        const existing = await sql<{ case_id: string }[]>`
          select case_id from casework.tasks
          where id = ${id}::uuid and deleted_at is null
        `;
        const rows = await sql`
          update casework.tasks
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (existing.length === 0 || rows.count === 0) {
          throw new CaseworkError("not_found", "That task no longer exists.");
        }
        await sql`
          select audit.write('task.removed', 'casework.tasks', ${id},
                             ${existing[0].case_id}::uuid, null, null, ${reason})
        `;
      });
    },

    async restore(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        const rows = await sql<{ case_id: string }[]>`
          update casework.tasks
          set deleted_at = null, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is not null
          returning case_id
        `;
        if (rows.length === 0) {
          throw new CaseworkError("not_found", "That task is not in the recycle bin.");
        }
        await sql`
          select audit.write('task.restored', 'casework.tasks', ${id},
                             ${rows[0].case_id}::uuid, null, null, ${reason})
        `;
      });
    },

    async ancestorIds(taskId: string): Promise<string[]> {
      return tx(async (sql) => {
        // A recursive walk upward, bounded by the cycle guard: `where not
        // t.id = any(a.path)` stops dead if a cycle already exists in the
        // data rather than looping forever.
        const rows = await sql<{ id: string }[]>`
          with recursive ancestry as (
            select t.id, t.parent_task_id, array[t.id] as path
            from casework.tasks t
            where t.id = ${taskId}::uuid

            union all

            select p.id, p.parent_task_id, a.path || p.id
            from casework.tasks p
            join ancestry a on a.parent_task_id = p.id
            where not p.id = any(a.path)
          )
          select id from ancestry where id <> ${taskId}::uuid
        `;
        return rows.map((r) => r.id);
      });
    },

    async openSubTaskCount(taskId: string): Promise<number> {
      return tx(async (sql) => {
        const rows = await sql<{ n: string }[]>`
          select count(*) as n from casework.tasks
          where parent_task_id = ${taskId}::uuid
            and deleted_at is null
            and status not in ('completed', 'cancelled')
        `;
        return Number(rows[0]?.n ?? 0);
      });
    },

    /* -------------------------------------------------------- comments */

    async comments(taskId: string): Promise<TaskComment[]> {
      return tx(async (sql) => {
        const rows = await sql<CommentRow[]>`
          with directory as (${DIRECTORY(sql)})
          select tc.*, dir.full_name as created_by_name
          from casework.task_comments tc
          left join directory dir on dir.user_id = tc.created_by
          where tc.task_id = ${taskId}::uuid and tc.deleted_at is null
          -- By insertion order, not created_at: now() is transaction-stable,
          -- so two comments written together share a timestamp and a
          -- conversation would not read forwards.
          order by tc.seq
        `;
        return rows.map(toComment);
      });
    },

    async addComment(taskId: string, body: string): Promise<TaskComment> {
      return tx(async (sql) => {
        const task = await sql<{ case_id: string }[]>`
          select case_id from casework.tasks
          where id = ${taskId}::uuid and deleted_at is null
        `;
        if (task.length === 0) {
          throw new CaseworkError("not_found", "That task no longer exists.");
        }

        const rows = await sql<CommentRow[]>`
          insert into casework.task_comments (task_id, body, created_by)
          values (${taskId}::uuid, ${body}, ${actor.userId}::uuid)
          returning *, null::text as created_by_name
        `;

        await sql`
          select audit.write(
            'task_comment.added', 'casework.task_comments', ${rows[0].id},
            ${task[0].case_id}::uuid, null,
            ${sql.json({ taskId })}, null
          )
        `;

        return toComment(rows[0]);
      });
    },

    async updateComment(id, input): Promise<TaskComment> {
      return tx(async (sql) => {
        const before = await sql<CommentRow[]>`
          select *, null::text as created_by_name from casework.task_comments
          where id = ${id}::uuid and deleted_at is null
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That comment no longer exists.");
        }
        if (before[0].version !== input.expectedVersion) {
          throw new CaseworkError(
            "stale_version",
            "This comment changed since you opened it. Reload and try again.",
          );
        }

        const rows = await sql<CommentRow[]>`
          update casework.task_comments
          set body = ${input.body}, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${input.expectedVersion}
          returning *, null::text as created_by_name
        `;
        if (rows.length === 0) {
          throw new CaseworkError(
            "stale_version",
            "This comment changed while saving. Reload and try again.",
          );
        }

        await sql`
          select audit.write(
            'task_comment.updated', 'casework.task_comments', ${id}, null,
            ${sql.json({ body: before[0].body })},
            ${sql.json({ body: rows[0].body })}, null
          )
        `;

        return toComment(rows[0]);
      });
    },

    async removeComment(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        // No RETURNING. A soft delete hides the row, and most of these
        // tables have a SELECT policy that excludes hidden rows, so asking
        // the database to hand the row back is asking it to show something
        // it has just been told to conceal: Postgres refuses with "new row
        // violates row-level security policy", which reads like a permission
        // fault on the write. The row count says everything the caller needs.
        const rows = await sql`
          update casework.task_comments
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (rows.count === 0) {
          throw new CaseworkError("not_found", "That comment no longer exists.");
        }
        await sql`
          select audit.write(
            'task_comment.removed', 'casework.task_comments', ${id}, null,
            null, null, ${reason}
          )
        `;
      });
    },

    /* --------------------------------------------------------- summary */

    async summary(filter) {
      return tx(async (sql) => {
        const rows = await sql<
          {
            total: string;
            open: string;
            overdue: string;
            blocked: string;
            unassigned: string;
            due_this_week: string;
          }[]
        >`
          select
            count(*) as total,
            count(*) filter (where status not in ('completed','cancelled')) as open,
            count(*) filter (
              where due_date < now()::date and status not in ('completed','cancelled')
            ) as overdue,
            count(*) filter (where status = 'blocked') as blocked,
            count(*) filter (
              where assigned_to is null and status not in ('completed','cancelled')
            ) as unassigned,
            count(*) filter (
              where due_date between now()::date and (now()::date + 7)
                and status not in ('completed','cancelled')
            ) as due_this_week
          from casework.tasks
          where deleted_at is null
            and (${filter.caseId ?? null}::uuid is null or case_id = ${filter.caseId ?? null}::uuid)
            and (${filter.assignedTo ?? null}::uuid is null or assigned_to = ${filter.assignedTo ?? null}::uuid)
        `;
        const row = rows[0];
        return {
          total: Number(row?.total ?? 0),
          open: Number(row?.open ?? 0),
          overdue: Number(row?.overdue ?? 0),
          blocked: Number(row?.blocked ?? 0),
          unassigned: Number(row?.unassigned ?? 0),
          dueThisWeek: Number(row?.due_this_week ?? 0),
        };
      });
    },
  };
}

interface CommentRow {
  id: string;
  task_id: string;
  body: string;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: string;
  version: number;
  deleted_at: string | null;
}

function toComment(row: CommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
  };
}

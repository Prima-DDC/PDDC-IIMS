import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { CaseworkError } from "../domain/errors";
import type {
  CaseCostSummary,
  CaseFinancials,
  Expense,
  TimeEntry,
} from "../domain/types";
import type {
  FinanceRepository,
  FinancialsInput,
  ListExpensesFilter,
  ListTimeEntriesFilter,
} from "../application/finance-ports";
import type { Page } from "../application/ports";

/**
 * Case financials, time and expenses (PRD 5.6, 5.7).
 *
 * Money arrives from Postgres `numeric` as a string, because a numeric does
 * not fit a double without losing the last pennies of a large figure. It is
 * converted to a number once, here, where the width is known to be small
 * enough: PRD 5.6 holds a case fee, not a balance sheet. Anything that
 * accumulates across cases is summed in SQL, so the arithmetic happens in
 * exact numeric rather than in floating point.
 */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

/** Postgres numeric comes back as a string. Null stays null. */
function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function num0(value: string | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/* ------------------------------------------------------------ financials */

interface FinancialsRow {
  id: string;
  case_id: string;
  currency: string;
  quoted_fee: string | null;
  approved_fee: string | null;
  additional_fees: string;
  invoice_number: string | null;
  amount_invoiced: string;
  amount_paid: string;
  outstanding: string;
  payment_status: CaseFinancials["paymentStatus"];
  notes: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  version: number;
}

function toFinancials(row: FinancialsRow): CaseFinancials {
  return {
    id: row.id,
    caseId: row.case_id,
    currency: row.currency.trim(),
    quotedFee: num(row.quoted_fee),
    approvedFee: num(row.approved_fee),
    additionalFees: num0(row.additional_fees),
    invoiceNumber: row.invoice_number,
    amountInvoiced: num0(row.amount_invoiced),
    amountPaid: num0(row.amount_paid),
    outstanding: num0(row.outstanding),
    paymentStatus: row.payment_status,
    notes: row.notes,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function financialsAuditShape(row: FinancialsRow) {
  return {
    currency: row.currency,
    quotedFee: row.quoted_fee,
    approvedFee: row.approved_fee,
    invoiceNumber: row.invoice_number,
    amountInvoiced: row.amount_invoiced,
    amountPaid: row.amount_paid,
    paymentStatus: row.payment_status,
  };
}

/* ------------------------------------------------------------------ time */

interface TimeRow {
  id: string;
  case_id: string;
  case_reference: string;
  user_id: string;
  user_name: string | null;
  task_id: string | null;
  task_title: string | null;
  worked_on: string;
  quantity: string;
  unit: TimeEntry["unit"];
  work_kind: TimeEntry["workKind"];
  description: string | null;
  is_billable: boolean;
  approved_at: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

function toTimeEntry(row: TimeRow): TimeEntry {
  return {
    id: row.id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    userId: row.user_id,
    userName: row.user_name,
    taskId: row.task_id,
    taskTitle: row.task_title,
    workedOn: row.worked_on,
    quantity: num0(row.quantity),
    unit: row.unit,
    workKind: row.work_kind,
    description: row.description,
    isBillable: row.is_billable,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

const TIME_SELECT = (sql: postgres.TransactionSql) => sql`
  select te.*,
         c.case_id as case_reference,
         t.title as task_title,
         dir.full_name as user_name,
         app.full_name as approved_by_name
  from casework.time_entries te
  join casework.cases c on c.id = te.case_id
  left join casework.tasks t on t.id = te.task_id
  left join directory dir on dir.user_id = te.user_id
  left join directory app on app.user_id = te.approved_by
`;

/* -------------------------------------------------------------- expenses */

interface ExpenseRow {
  id: string;
  expense_id: string;
  case_id: string;
  case_reference: string;
  incurred_on: string;
  category: Expense["category"];
  description: string;
  amount: string;
  currency: string;
  is_billable: boolean;
  receipt_reference: string | null;
  incurred_by: string | null;
  incurred_by_name: string | null;
  status: Expense["status"];
  decided_at: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decision_reason: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

function toExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    expenseId: row.expense_id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    incurredOn: row.incurred_on,
    category: row.category,
    description: row.description,
    amount: num0(row.amount),
    currency: row.currency.trim(),
    isBillable: row.is_billable,
    receiptReference: row.receipt_reference,
    incurredBy: row.incurred_by,
    incurredByName: row.incurred_by_name,
    status: row.status,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name,
    decisionReason: row.decision_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

const EXPENSE_SELECT = (sql: postgres.TransactionSql) => sql`
  select e.*,
         c.case_id as case_reference,
         inc.full_name as incurred_by_name,
         dec.full_name as decided_by_name
  from casework.expenses e
  join casework.cases c on c.id = e.case_id
  left join directory inc on inc.user_id = e.incurred_by
  left join directory dec on dec.user_id = e.decided_by
`;

export function createFinanceRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): FinanceRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  const loadFinancials = async (
    sql: postgres.TransactionSql,
    caseId: string,
  ): Promise<CaseFinancials | null> => {
    const rows = await sql<FinancialsRow[]>`
      select * from casework.case_financials where case_id = ${caseId}::uuid
    `;
    return rows.length > 0 ? toFinancials(rows[0]) : null;
  };

  const loadTimeEntry = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<TimeEntry | null> => {
    const rows = await sql<TimeRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${TIME_SELECT(sql)}
      where te.id = ${id}::uuid
    `;
    return rows.length > 0 ? toTimeEntry(rows[0]) : null;
  };

  const loadExpense = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Expense | null> => {
    const rows = await sql<ExpenseRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${EXPENSE_SELECT(sql)}
      where e.id = ${id}::uuid
    `;
    return rows.length > 0 ? toExpense(rows[0]) : null;
  };

  return {
    /* ----------------------------------------------------- financials */

    async forCase(caseId) {
      return tx((sql) => loadFinancials(sql, caseId));
    },

    async saveFinancials(caseId, input: FinancialsInput) {
      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          insert into casework.case_financials (
            case_id, currency, quoted_fee, approved_fee, additional_fees,
            invoice_number, amount_invoiced, amount_paid, payment_status,
            notes, created_by
          ) values (
            ${caseId}::uuid, ${input.currency ?? "GHS"},
            ${input.quotedFee ?? null}, ${input.approvedFee ?? null},
            ${input.additionalFees ?? 0},
            ${input.invoiceNumber ?? null}, ${input.amountInvoiced ?? 0},
            ${input.amountPaid ?? 0}, ${input.paymentStatus ?? "not_invoiced"},
            ${input.notes ?? null}, ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'financials.created', 'casework.case_financials', ${rows[0].id},
            ${caseId}::uuid, null,
            ${sql.json({
              currency: input.currency ?? "GHS",
              quotedFee: input.quotedFee ?? null,
              approvedFee: input.approvedFee ?? null,
            })},
            null
          )
        `;

        const created = await loadFinancials(sql, caseId);
        if (!created) {
          throw new CaseworkError(
            "not_found",
            "The financial record could not be read back after saving.",
          );
        }
        return created;
      });
    },

    async updateFinancials(id, input, expectedVersion) {
      return tx(async (sql) => {
        const before = await sql<FinancialsRow[]>`
          select * from casework.case_financials where id = ${id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError(
            "not_found",
            "That financial record no longer exists.",
          );
        }
        if (before[0].version !== expectedVersion) {
          throw new CaseworkError(
            "stale_version",
            "The financial record changed since you opened it. Reload and try again.",
            { expected: expectedVersion, actual: before[0].version },
          );
        }

        const updated = await sql<{ id: string }[]>`
          update casework.case_financials set
            currency = coalesce(${input.currency ?? null}, currency),
            quoted_fee = ${input.quotedFee === undefined ? sql`quoted_fee` : input.quotedFee},
            approved_fee = ${input.approvedFee === undefined ? sql`approved_fee` : input.approvedFee},
            additional_fees = coalesce(${input.additionalFees ?? null}, additional_fees),
            invoice_number = ${input.invoiceNumber === undefined ? sql`invoice_number` : input.invoiceNumber},
            amount_invoiced = coalesce(${input.amountInvoiced ?? null}, amount_invoiced),
            amount_paid = coalesce(${input.amountPaid ?? null}, amount_paid),
            payment_status = coalesce(${input.paymentStatus ?? null}, payment_status),
            notes = ${input.notes === undefined ? sql`notes` : input.notes},
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${expectedVersion}
          returning id
        `;
        if (updated.length === 0) {
          throw new CaseworkError(
            "stale_version",
            "The financial record changed while saving. Reload and try again.",
          );
        }

        const after = await sql<FinancialsRow[]>`
          select * from casework.case_financials where id = ${id}::uuid
        `;

        await sql`
          select audit.write(
            'financials.updated', 'casework.case_financials', ${id},
            ${before[0].case_id}::uuid,
            ${sql.json(financialsAuditShape(before[0]))},
            ${sql.json(financialsAuditShape(after[0]))},
            null
          )
        `;

        return toFinancials(after[0]);
      });
    },

    /* ----------------------------------------------------------- time */

    async listTime(filter: ListTimeEntriesFilter): Promise<Page<TimeEntry>> {
      const limit = Math.min(filter.limit ?? 50, 500);
      const offset = Math.max(filter.offset ?? 0, 0);

      return tx(async (sql) => {
        const rows = await sql<(TimeRow & { total_count: string })[]>`
          with directory as (${DIRECTORY(sql)}),
          filtered as (
            ${TIME_SELECT(sql)}
            where (${filter.caseId ?? null}::uuid is null or te.case_id = ${filter.caseId ?? null}::uuid)
              and (${filter.userId ?? null}::uuid is null or te.user_id = ${filter.userId ?? null}::uuid)
              and (${filter.taskId ?? null}::uuid is null or te.task_id = ${filter.taskId ?? null}::uuid)
              and (${filter.from ?? null}::date is null or te.worked_on >= ${filter.from ?? null}::date)
              and (${filter.to ?? null}::date is null or te.worked_on <= ${filter.to ?? null}::date)
              and (${filter.workKind ?? null}::text is null or te.work_kind = ${filter.workKind ?? null})
              and (not ${filter.billableOnly ?? false} or te.is_billable)
              and (not ${filter.unapprovedOnly ?? false} or te.approved_at is null)
          )
          select f.*, count(*) over () as total_count
          from filtered f
          order by f.worked_on desc, f.created_at desc
          limit ${limit} offset ${offset}
        `;

        return {
          rows: rows.map(toTimeEntry),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async findTimeEntryById(id) {
      return tx((sql) => loadTimeEntry(sql, id));
    },

    async logTime(input) {
      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          insert into casework.time_entries (
            case_id, user_id, task_id, worked_on, quantity, unit, work_kind,
            description, is_billable, created_by
          ) values (
            ${input.caseId}::uuid, ${input.userId}::uuid,
            ${input.taskId ?? null}::uuid, ${input.workedOn}::date,
            ${input.quantity}, ${input.unit}, ${input.workKind},
            ${input.description ?? null}, ${input.isBillable ?? true},
            ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'time.logged', 'casework.time_entries', ${rows[0].id},
            ${input.caseId}::uuid, null,
            ${sql.json({
              workedOn: input.workedOn,
              quantity: input.quantity,
              unit: input.unit,
              workKind: input.workKind,
            })},
            null
          )
        `;

        const created = await loadTimeEntry(sql, rows[0].id);
        if (!created) {
          throw new CaseworkError(
            "not_found",
            "The time entry could not be read back after saving.",
          );
        }
        return created;
      });
    },

    async updateTimeEntry(id, input, expectedVersion) {
      return tx(async (sql) => {
        const before = await sql<
          { version: number; case_id: string; approved_at: string | null }[]
        >`
          select version, case_id, approved_at from casework.time_entries
          where id = ${id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That time entry no longer exists.");
        }
        if (before[0].version !== expectedVersion) {
          throw new CaseworkError(
            "stale_version",
            "This entry changed since you opened it. Reload and try again.",
            { expected: expectedVersion, actual: before[0].version },
          );
        }
        // Also refused by the domain rule. Here as well because this check
        // reads the row in the same transaction as the update, so it holds
        // against an approval that landed a moment ago.
        if (before[0].approved_at !== null) {
          throw new CaseworkError(
            "conflict",
            "This entry has been approved and cannot be changed. Record a correcting entry instead.",
          );
        }

        const updated = await sql<{ id: string }[]>`
          update casework.time_entries set
            task_id = ${input.taskId === undefined ? sql`task_id` : sql`${input.taskId}::uuid`},
            worked_on = coalesce(${input.workedOn ?? null}::date, worked_on),
            quantity = coalesce(${input.quantity ?? null}, quantity),
            unit = coalesce(${input.unit ?? null}, unit),
            work_kind = coalesce(${input.workKind ?? null}, work_kind),
            description = ${input.description === undefined ? sql`description` : input.description},
            is_billable = coalesce(${input.isBillable ?? null}, is_billable),
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${expectedVersion}
            and approved_at is null
          returning id
        `;
        if (updated.length === 0) {
          throw new CaseworkError(
            "stale_version",
            "This entry changed while saving. Reload and try again.",
          );
        }

        await sql`
          select audit.write(
            'time.updated', 'casework.time_entries', ${id},
            ${before[0].case_id}::uuid, null,
            ${sql.json({
              workedOn: input.workedOn ?? null,
              quantity: input.quantity ?? null,
              unit: input.unit ?? null,
            })},
            null
          )
        `;

        const after = await loadTimeEntry(sql, id);
        if (!after) {
          throw new CaseworkError(
            "not_found",
            "The time entry could not be read back after saving.",
          );
        }
        return after;
      });
    },

    async approveTimeEntry(id) {
      return tx(async (sql) => {
        const before = await sql<
          { case_id: string; approved_at: string | null; user_id: string }[]
        >`
          select case_id, approved_at, user_id from casework.time_entries
          where id = ${id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That time entry no longer exists.");
        }
        if (before[0].approved_at !== null) {
          throw new CaseworkError("conflict", "That entry is already approved.");
        }

        await sql`
          update casework.time_entries set
            approved_at = now(),
            approved_by = ${actor.userId}::uuid,
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid
        `;

        await sql`
          select audit.write(
            'time.approved', 'casework.time_entries', ${id},
            ${before[0].case_id}::uuid, null,
            ${sql.json({ approvedBy: actor.userId })}, null
          )
        `;

        const after = await loadTimeEntry(sql, id);
        if (!after) {
          throw new CaseworkError(
            "not_found",
            "The time entry could not be read back after approval.",
          );
        }
        return after;
      });
    },

    /* ------------------------------------------------------- expenses */

    async listExpenses(filter: ListExpensesFilter): Promise<Page<Expense>> {
      const limit = Math.min(filter.limit ?? 50, 200);
      const offset = Math.max(filter.offset ?? 0, 0);

      return tx(async (sql) => {
        const rows = await sql<(ExpenseRow & { total_count: string })[]>`
          with directory as (${DIRECTORY(sql)}),
          filtered as (
            ${EXPENSE_SELECT(sql)}
            where (${filter.caseId ?? null}::uuid is null or e.case_id = ${filter.caseId ?? null}::uuid)
              and (${filter.incurredBy ?? null}::uuid is null or e.incurred_by = ${filter.incurredBy ?? null}::uuid)
              and (${filter.status ?? "all"} = 'all' or e.status = ${filter.status ?? "all"})
              and (${filter.category ?? null}::text is null or e.category = ${filter.category ?? null})
          )
          select f.*, count(*) over () as total_count
          from filtered f
          -- Claims waiting on somebody first, then most recent.
          order by
            case f.status when 'claimed' then 0 when 'approved' then 1 else 2 end,
            f.incurred_on desc
          limit ${limit} offset ${offset}
        `;

        return {
          rows: rows.map(toExpense),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async findExpenseById(id) {
      return tx((sql) => loadExpense(sql, id));
    },

    async claimExpense(input) {
      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          insert into casework.expenses (
            case_id, incurred_on, category, description, amount, currency,
            is_billable, receipt_reference, incurred_by, created_by
          ) values (
            ${input.caseId}::uuid, ${input.incurredOn}::date, ${input.category},
            ${input.description}, ${input.amount}, ${input.currency ?? "GHS"},
            ${input.isBillable ?? true}, ${input.receiptReference ?? null},
            ${input.incurredBy}::uuid, ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'expense.claimed', 'casework.expenses', ${rows[0].id},
            ${input.caseId}::uuid, null,
            ${sql.json({
              category: input.category,
              amount: input.amount,
              currency: input.currency ?? "GHS",
            })},
            null
          )
        `;

        const created = await loadExpense(sql, rows[0].id);
        if (!created) {
          throw new CaseworkError(
            "not_found",
            "The claim could not be read back after saving.",
          );
        }
        return created;
      });
    },

    async updateExpense(id, input, expectedVersion) {
      return tx(async (sql) => {
        const before = await sql<
          { version: number; case_id: string; status: Expense["status"] }[]
        >`
          select version, case_id, status from casework.expenses
          where id = ${id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That claim no longer exists.");
        }
        if (before[0].version !== expectedVersion) {
          throw new CaseworkError(
            "stale_version",
            "This claim changed since you opened it. Reload and try again.",
            { expected: expectedVersion, actual: before[0].version },
          );
        }
        if (before[0].status !== "claimed") {
          throw new CaseworkError(
            "conflict",
            "This claim has been decided and cannot be changed. Submit a corrected claim instead.",
          );
        }

        const updated = await sql<{ id: string }[]>`
          update casework.expenses set
            incurred_on = coalesce(${input.incurredOn ?? null}::date, incurred_on),
            category = coalesce(${input.category ?? null}, category),
            description = coalesce(${input.description ?? null}, description),
            amount = coalesce(${input.amount ?? null}, amount),
            currency = coalesce(${input.currency ?? null}, currency),
            is_billable = coalesce(${input.isBillable ?? null}, is_billable),
            receipt_reference = ${input.receiptReference === undefined ? sql`receipt_reference` : input.receiptReference},
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${expectedVersion}
            and status = 'claimed'
          returning id
        `;
        if (updated.length === 0) {
          throw new CaseworkError(
            "stale_version",
            "This claim changed while saving. Reload and try again.",
          );
        }

        await sql`
          select audit.write(
            'expense.updated', 'casework.expenses', ${id},
            ${before[0].case_id}::uuid, null,
            ${sql.json({ amount: input.amount ?? null })}, null
          )
        `;

        const after = await loadExpense(sql, id);
        if (!after) {
          throw new CaseworkError(
            "not_found",
            "The claim could not be read back after saving.",
          );
        }
        return after;
      });
    },

    async decideExpense(input) {
      return tx(async (sql) => {
        const before = await sql<
          { case_id: string; status: Expense["status"]; expense_id: string }[]
        >`
          select case_id, status, expense_id from casework.expenses
          where id = ${input.id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That claim no longer exists.");
        }

        await sql`
          update casework.expenses set
            status = ${input.status},
            decided_at = now(),
            decided_by = ${actor.userId}::uuid,
            decision_reason = ${input.reason ?? null},
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid
        `;

        await sql`
          select audit.write(
            ${`expense.${input.status}`}, 'casework.expenses', ${input.id},
            ${before[0].case_id}::uuid,
            ${sql.json({ status: before[0].status })},
            ${sql.json({ status: input.status })},
            ${input.reason ?? null}
          )
        `;

        const after = await loadExpense(sql, input.id);
        if (!after) {
          throw new CaseworkError(
            "not_found",
            "The claim could not be read back after the decision.",
          );
        }
        return after;
      });
    },

    async costSummary(caseId): Promise<CaseCostSummary> {
      return tx(async (sql) => {
        const rows = await sql<
          {
            hours: string;
            days: string;
            billable_hours: string;
            expense_total: string;
            billable_expense_total: string;
            approved_expense_total: string;
            claimed_expense_count: string;
            currency: string | null;
          }[]
        >`
          select
            coalesce(sum(te.quantity) filter (where te.unit = 'hours'), 0) as hours,
            coalesce(sum(te.quantity) filter (where te.unit = 'days'), 0) as days,
            coalesce(
              sum(te.quantity) filter (where te.unit = 'hours' and te.is_billable), 0
            ) as billable_hours,
            (select coalesce(sum(amount), 0) from casework.expenses
              where case_id = ${caseId}::uuid and status <> 'rejected')
              as expense_total,
            (select coalesce(sum(amount), 0) from casework.expenses
              where case_id = ${caseId}::uuid and status <> 'rejected' and is_billable)
              as billable_expense_total,
            (select coalesce(sum(amount), 0) from casework.expenses
              where case_id = ${caseId}::uuid and status in ('approved', 'reimbursed'))
              as approved_expense_total,
            (select count(*) from casework.expenses
              where case_id = ${caseId}::uuid and status = 'claimed')
              as claimed_expense_count,
            (select currency from casework.case_financials
              where case_id = ${caseId}::uuid)
              as currency
          from casework.time_entries te
          where te.case_id = ${caseId}::uuid
        `;

        const row = rows[0];
        return {
          hours: num0(row?.hours),
          days: num0(row?.days),
          billableHours: num0(row?.billable_hours),
          expenseTotal: num0(row?.expense_total),
          billableExpenseTotal: num0(row?.billable_expense_total),
          approvedExpenseTotal: num0(row?.approved_expense_total),
          claimedExpenseCount: num0(row?.claimed_expense_count),
          currency: (row?.currency ?? "GHS").trim(),
        };
      });
    },
  };
}

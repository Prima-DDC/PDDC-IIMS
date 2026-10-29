import type {
  CaseCostSummary,
  CaseFinancials,
  Expense,
  ExpenseCategory,
  ExpenseStatus,
  PaymentStatus,
  TimeEntry,
  TimeUnit,
  WorkKind,
} from "../domain/types";
import type { Page } from "./ports";

/** Ports for case financials, time and expenses (PRD 5.6, 5.7). */

export interface FinancialsInput {
  currency?: string;
  quotedFee?: number | null;
  approvedFee?: number | null;
  additionalFees?: number;
  invoiceNumber?: string | null;
  amountInvoiced?: number;
  amountPaid?: number;
  paymentStatus?: PaymentStatus;
  notes?: string | null;
}

export interface ListTimeEntriesFilter {
  caseId?: string;
  userId?: string;
  taskId?: string;
  from?: string;
  to?: string;
  workKind?: WorkKind;
  billableOnly?: boolean;
  unapprovedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListExpensesFilter {
  caseId?: string;
  incurredBy?: string;
  status?: ExpenseStatus | "all";
  category?: ExpenseCategory;
  limit?: number;
  offset?: number;
}

export interface FinanceRepository {
  /* ------------------------------------------------------- financials */

  forCase(caseId: string): Promise<CaseFinancials | null>;
  saveFinancials(caseId: string, input: FinancialsInput): Promise<CaseFinancials>;
  updateFinancials(
    id: string,
    input: FinancialsInput,
    expectedVersion: number,
  ): Promise<CaseFinancials>;

  /* ------------------------------------------------------------- time */

  listTime(filter: ListTimeEntriesFilter): Promise<Page<TimeEntry>>;
  findTimeEntryById(id: string): Promise<TimeEntry | null>;

  logTime(input: {
    caseId: string;
    userId: string;
    taskId?: string | null;
    workedOn: string;
    quantity: number;
    unit: TimeUnit;
    workKind: WorkKind;
    description?: string | null;
    isBillable?: boolean;
  }): Promise<TimeEntry>;

  updateTimeEntry(
    id: string,
    input: {
      taskId?: string | null;
      workedOn?: string;
      quantity?: number;
      unit?: TimeUnit;
      workKind?: WorkKind;
      description?: string | null;
      isBillable?: boolean;
    },
    expectedVersion: number,
  ): Promise<TimeEntry>;

  /**
   * Approving freezes the entry, which is what a cost report rests on.
   *
   * There is deliberately no removal. A timesheet that can lose a line no
   * longer adds up to the hours somebody was paid for, so a mistake is
   * corrected by editing the entry while it is unapproved, and an approved
   * one is corrected by a further entry.
   */
  approveTimeEntry(id: string): Promise<TimeEntry>;

  /* --------------------------------------------------------- expenses */

  listExpenses(filter: ListExpensesFilter): Promise<Page<Expense>>;
  findExpenseById(id: string): Promise<Expense | null>;

  claimExpense(input: {
    caseId: string;
    incurredOn: string;
    category: ExpenseCategory;
    description: string;
    amount: number;
    currency?: string;
    isBillable?: boolean;
    receiptReference?: string | null;
    incurredBy: string;
  }): Promise<Expense>;

  updateExpense(
    id: string,
    input: {
      incurredOn?: string;
      category?: ExpenseCategory;
      description?: string;
      amount?: number;
      currency?: string;
      isBillable?: boolean;
      receiptReference?: string | null;
    },
    expectedVersion: number,
  ): Promise<Expense>;

  decideExpense(input: {
    id: string;
    status: ExpenseStatus;
    reason?: string | null;
  }): Promise<Expense>;

  /** What the case has cost, for the finance panel and cost reporting. */
  costSummary(caseId: string): Promise<CaseCostSummary>;
}

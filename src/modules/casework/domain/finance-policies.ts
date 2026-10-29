import { CaseworkError } from "./errors";
import type {
  CaseFinancials,
  Expense,
  ExpenseStatus,
  PaymentStatus,
  TimeEntry,
  TimeUnit,
} from "./types";

/**
 * Case financials, time and expense rules (PRD 5.6, 5.7).
 *
 * PRD 5.6 begins "not an accounting system", and these rules keep it that
 * way: they stop the few numbers held here from contradicting each other, and
 * they stop somebody approving their own claim. There is no ledger, no tax
 * and no revenue recognition, because the PRD asks for none.
 */

/* ---------------------------------------------------------- financials */

/** Money paid that was never invoiced is a typing mistake, not a state. */
export function assertPaidWithinInvoiced(
  amountInvoiced: number,
  amountPaid: number,
): void {
  if (amountPaid <= amountInvoiced) return;

  throw new CaseworkError(
    "validation_failed",
    "More has been paid than was invoiced. Correct the invoiced amount first.",
  );
}

/** An invoiced amount with no invoice number cannot be chased. */
export function assertInvoiceNumber(
  amountInvoiced: number,
  invoiceNumber: string | null | undefined,
): void {
  if (amountInvoiced === 0) return;
  if ((invoiceNumber ?? "").trim().length > 0) return;

  throw new CaseworkError(
    "validation_failed",
    "Record the invoice number alongside the amount invoiced.",
  );
}

/**
 * What the numbers say the payment status is.
 *
 * Returned rather than assigned, so the screen can offer it and somebody can
 * still choose "written off" or "overdue", neither of which the numbers can
 * know. Everything else follows from the amounts.
 */
export function suggestPaymentStatus(
  amountInvoiced: number,
  amountPaid: number,
): PaymentStatus {
  if (amountInvoiced === 0) return "not_invoiced";
  if (amountPaid === 0) return "invoiced";
  if (amountPaid < amountInvoiced) return "part_paid";
  return "paid";
}

/**
 * Refuses a payment status the amounts contradict.
 *
 * "Paid" with money outstanding is the one that matters: it is the status
 * somebody looks at instead of the numbers, so it has to be true. "Overdue"
 * and "written off" are judgements the amounts cannot make, so they are left
 * alone apart from needing an invoice and a note respectively.
 */
export function assertPaymentStatusIsTrue(
  status: PaymentStatus,
  amountInvoiced: number,
  amountPaid: number,
  notes: string | null | undefined,
): void {
  const outstanding = amountInvoiced - amountPaid;

  if (status === "paid" && outstanding > 0) {
    throw new CaseworkError(
      "validation_failed",
      `This cannot be marked paid: ${outstanding.toFixed(2)} is still outstanding.`,
    );
  }
  if (status === "not_invoiced" && amountInvoiced > 0) {
    throw new CaseworkError(
      "validation_failed",
      "An amount has been invoiced, so the status cannot be 'not invoiced'.",
    );
  }
  if ((status === "invoiced" || status === "overdue") && amountInvoiced === 0) {
    throw new CaseworkError(
      "validation_failed",
      "Nothing has been invoiced yet, so this status does not apply.",
    );
  }
  if (status === "part_paid" && (amountPaid === 0 || outstanding <= 0)) {
    throw new CaseworkError(
      "validation_failed",
      "'Part paid' means some but not all of the invoice is paid.",
    );
  }
  if (status === "written_off" && (notes ?? "").trim().length < 10) {
    throw new CaseworkError(
      "validation_failed",
      "Writing off a fee needs a note saying why, in at least 10 characters.",
    );
  }
}

/** Everything above, in the order a form wants it. */
export function assertFinancialsConsistent(input: {
  amountInvoiced: number;
  amountPaid: number;
  invoiceNumber: string | null | undefined;
  paymentStatus: PaymentStatus;
  notes: string | null | undefined;
}): void {
  assertPaidWithinInvoiced(input.amountInvoiced, input.amountPaid);
  assertInvoiceNumber(input.amountInvoiced, input.invoiceNumber);
  assertPaymentStatusIsTrue(
    input.paymentStatus,
    input.amountInvoiced,
    input.amountPaid,
    input.notes,
  );
}

/**
 * Whether the financial position has been recorded, for PRD 5.9's closure
 * checklist.
 *
 * A row of zeroes is not a recorded position: it is a row somebody created
 * and never filled in. Either a fee was agreed or somebody said in the notes
 * why there is none.
 */
export function financialStatusRecorded(
  financials: Pick<
    CaseFinancials,
    "approvedFee" | "amountInvoiced" | "paymentStatus" | "notes"
  > | null,
): boolean {
  if (!financials) return false;
  if (financials.paymentStatus === "written_off") return true;
  if ((financials.approvedFee ?? 0) > 0) return true;
  if (financials.amountInvoiced > 0) return true;
  return (financials.notes ?? "").trim().length >= 10;
}

/* --------------------------------------------------------------- time */

/** A day is a day and an hour is an hour (PRD 5.7 keeps both units). */
export function assertTimeQuantity(unit: TimeUnit, quantity: number): void {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new CaseworkError("validation_failed", "Record how long the work took.");
  }
  if (unit === "hours" && quantity > 24) {
    throw new CaseworkError(
      "validation_failed",
      "A day holds 24 hours. Split this across the days it actually covers.",
    );
  }
  if (unit === "days" && quantity > 7) {
    throw new CaseworkError(
      "validation_failed",
      "Record more than a week as separate entries, so the dates stay true.",
    );
  }
}

/** Time cannot be logged against a date that has not happened. */
export function assertTimeNotInFuture(workedOn: string, today: string): void {
  if (workedOn <= today) return;

  throw new CaseworkError(
    "validation_failed",
    "That date is in the future. Log the work once it has been done.",
  );
}

/**
 * An approved time entry is frozen.
 *
 * Approval is what a cost report is built on, so letting the entry change
 * underneath it would make yesterday's report unreproducible.
 */
export function assertTimeEntryEditable(
  entry: Pick<TimeEntry, "approvedAt">,
): void {
  if (entry.approvedAt === null) return;

  throw new CaseworkError(
    "conflict",
    "This entry has been approved and cannot be changed. Record a correcting entry instead.",
  );
}

/** PRD 16: nobody approves their own work. */
export function assertNotApprovingOwnTime(
  entry: Pick<TimeEntry, "userId">,
  actorId: string,
): void {
  if (entry.userId !== actorId) return;

  throw new CaseworkError(
    "self_approval_forbidden",
    "You cannot approve your own time. A supervisor other than you has to.",
  );
}

/* ----------------------------------------------------------- expenses */

const EXPENSE_TRANSITIONS: Record<ExpenseStatus, readonly ExpenseStatus[]> = {
  claimed: ["approved", "rejected"],
  approved: ["reimbursed", "rejected"],
  // A rejected claim is not revived: the claimant submits a corrected one, so
  // the rejection and its reason stay readable.
  rejected: [],
  reimbursed: [],
};

export function allowedExpenseTransitions(
  from: ExpenseStatus,
): readonly ExpenseStatus[] {
  return EXPENSE_TRANSITIONS[from];
}

export function assertExpenseTransition(
  from: ExpenseStatus,
  to: ExpenseStatus,
): void {
  if (from === to) {
    throw new CaseworkError(
      "illegal_transition",
      "The claim is already at that status.",
    );
  }
  if (!EXPENSE_TRANSITIONS[from].includes(to)) {
    throw new CaseworkError(
      "illegal_transition",
      EXPENSE_TRANSITIONS[from].length === 0
        ? `A ${from} claim is final. A corrected claim is a new one, which keeps this decision readable.`
        : `A ${from} claim can only move to: ${EXPENSE_TRANSITIONS[from].join(", ")}.`,
      { from, to },
    );
  }
}

/** A rejection with no reason is indistinguishable from an oversight. */
export function assertExpenseDecisionReason(
  to: ExpenseStatus,
  reason: string | null | undefined,
): void {
  if (to !== "rejected") return;
  if ((reason ?? "").trim().length >= 5) return;

  throw new CaseworkError(
    "validation_failed",
    "Say why the claim is rejected, so it can be corrected and resubmitted.",
  );
}

/** PRD 16 again: the claimant is not the approver. */
export function assertNotDecidingOwnExpense(
  expense: Pick<Expense, "incurredBy" | "expenseId">,
  actorId: string,
): void {
  if (expense.incurredBy !== actorId) return;

  throw new CaseworkError(
    "self_approval_forbidden",
    `${expense.expenseId} is your own claim, so somebody else has to decide it.`,
  );
}

/** A claimant may correct their own claim only while it is still open. */
export function assertExpenseEditable(
  expense: Pick<Expense, "status">,
): void {
  if (expense.status === "claimed") return;

  throw new CaseworkError(
    "conflict",
    "This claim has been decided and cannot be changed. Submit a corrected claim instead.",
  );
}

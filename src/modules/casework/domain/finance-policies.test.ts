import { describe, expect, it } from "vitest";
import { isCaseworkError } from "./errors";
import {
  allowedExpenseTransitions,
  assertExpenseDecisionReason,
  assertExpenseEditable,
  assertExpenseTransition,
  assertFinancialsConsistent,
  assertNotApprovingOwnTime,
  assertNotDecidingOwnExpense,
  assertTimeEntryEditable,
  assertTimeNotInFuture,
  assertTimeQuantity,
  financialStatusRecorded,
  suggestPaymentStatus,
} from "./finance-policies";

/** PRD 5.6 and 5.7: the few numbers the platform holds, kept honest. */

function codeOf(work: () => void): string {
  try {
    work();
  } catch (error) {
    if (isCaseworkError(error)) return error.code;
    throw error;
  }
  return "no error";
}

describe("the payment position", () => {
  it("follows from the amounts", () => {
    expect(suggestPaymentStatus(0, 0)).toBe("not_invoiced");
    expect(suggestPaymentStatus(1000, 0)).toBe("invoiced");
    expect(suggestPaymentStatus(1000, 400)).toBe("part_paid");
    expect(suggestPaymentStatus(1000, 1000)).toBe("paid");
  });

  it("cannot be marked paid while money is outstanding", () => {
    expect(
      codeOf(() =>
        assertFinancialsConsistent({
          amountInvoiced: 1000,
          amountPaid: 400,
          invoiceNumber: "INV-1",
          paymentStatus: "paid",
          notes: null,
        }),
      ),
    ).toBe("validation_failed");
  });

  it("refuses more paid than was invoiced", () => {
    expect(
      codeOf(() =>
        assertFinancialsConsistent({
          amountInvoiced: 100,
          amountPaid: 400,
          invoiceNumber: "INV-1",
          paymentStatus: "paid",
          notes: null,
        }),
      ),
    ).toBe("validation_failed");
  });

  it("refuses an invoiced amount with no invoice number", () => {
    expect(
      codeOf(() =>
        assertFinancialsConsistent({
          amountInvoiced: 1000,
          amountPaid: 0,
          invoiceNumber: "  ",
          paymentStatus: "invoiced",
          notes: null,
        }),
      ),
    ).toBe("validation_failed");
  });

  it("refuses 'not invoiced' once something has been invoiced", () => {
    expect(
      codeOf(() =>
        assertFinancialsConsistent({
          amountInvoiced: 500,
          amountPaid: 0,
          invoiceNumber: "INV-2",
          paymentStatus: "not_invoiced",
          notes: null,
        }),
      ),
    ).toBe("validation_failed");
  });

  it("refuses 'part paid' when nothing or everything is paid", () => {
    const base = { amountInvoiced: 1000, invoiceNumber: "INV-3", notes: null } as const;
    expect(
      codeOf(() =>
        assertFinancialsConsistent({
          ...base,
          amountPaid: 0,
          paymentStatus: "part_paid",
        }),
      ),
    ).toBe("validation_failed");
    expect(
      codeOf(() =>
        assertFinancialsConsistent({
          ...base,
          amountPaid: 1000,
          paymentStatus: "part_paid",
        }),
      ),
    ).toBe("validation_failed");
  });

  it("needs a note to write a fee off", () => {
    expect(
      codeOf(() =>
        assertFinancialsConsistent({
          amountInvoiced: 1000,
          amountPaid: 0,
          invoiceNumber: "INV-4",
          paymentStatus: "written_off",
          notes: "no",
        }),
      ),
    ).toBe("validation_failed");

    expect(() =>
      assertFinancialsConsistent({
        amountInvoiced: 1000,
        amountPaid: 0,
        invoiceNumber: "INV-4",
        paymentStatus: "written_off",
        notes: "Client entered liquidation in October; the receiver confirmed no funds.",
      }),
    ).not.toThrow();
  });

  it("accepts a consistent position", () => {
    expect(() =>
      assertFinancialsConsistent({
        amountInvoiced: 1000,
        amountPaid: 1000,
        invoiceNumber: "INV-5",
        paymentStatus: "paid",
        notes: null,
      }),
    ).not.toThrow();
  });
});

describe("whether the financial position counts as recorded", () => {
  it("is not, for a row of zeroes nobody filled in", () => {
    expect(
      financialStatusRecorded({
        approvedFee: null,
        amountInvoiced: 0,
        paymentStatus: "not_invoiced",
        notes: null,
      }),
    ).toBe(false);
  });

  it("is not, when there is no row at all", () => {
    expect(financialStatusRecorded(null)).toBe(false);
  });

  it("is, once a fee was approved", () => {
    expect(
      financialStatusRecorded({
        approvedFee: 5000,
        amountInvoiced: 0,
        paymentStatus: "not_invoiced",
        notes: null,
      }),
    ).toBe(true);
  });

  it("is, when somebody wrote down why there is no fee", () => {
    expect(
      financialStatusRecorded({
        approvedFee: null,
        amountInvoiced: 0,
        paymentStatus: "not_invoiced",
        notes: "Carried out pro bono at the request of the managing partner.",
      }),
    ).toBe(true);
  });
});

describe("logging time", () => {
  it("keeps hours inside a day", () => {
    expect(codeOf(() => assertTimeQuantity("hours", 25))).toBe("validation_failed");
    expect(() => assertTimeQuantity("hours", 7.5)).not.toThrow();
  });

  it("keeps days inside a week", () => {
    expect(codeOf(() => assertTimeQuantity("days", 9))).toBe("validation_failed");
    expect(() => assertTimeQuantity("days", 2)).not.toThrow();
  });

  it("refuses nothing and negatives", () => {
    expect(codeOf(() => assertTimeQuantity("hours", 0))).toBe("validation_failed");
    expect(codeOf(() => assertTimeQuantity("hours", -3))).toBe("validation_failed");
  });

  it("refuses a date that has not happened", () => {
    expect(codeOf(() => assertTimeNotInFuture("2026-11-01", "2026-10-22"))).toBe(
      "validation_failed",
    );
    expect(() => assertTimeNotInFuture("2026-10-22", "2026-10-22")).not.toThrow();
  });

  it("freezes an approved entry", () => {
    expect(
      codeOf(() => assertTimeEntryEditable({ approvedAt: "2026-10-20T10:00:00.000Z" })),
    ).toBe("conflict");
    expect(() => assertTimeEntryEditable({ approvedAt: null })).not.toThrow();
  });

  it("refuses approving your own", () => {
    const mine = { userId: "11111111-1111-1111-1111-111111111111" };
    expect(codeOf(() => assertNotApprovingOwnTime(mine, mine.userId))).toBe(
      "self_approval_forbidden",
    );
    expect(() =>
      assertNotApprovingOwnTime(mine, "22222222-2222-2222-2222-222222222222"),
    ).not.toThrow();
  });
});

describe("an expense claim", () => {
  it("moves from claimed to a decision", () => {
    expect(allowedExpenseTransitions("claimed")).toEqual(["approved", "rejected"]);
    expect(allowedExpenseTransitions("approved")).toEqual(["reimbursed", "rejected"]);
  });

  it("is final once rejected or reimbursed", () => {
    expect(allowedExpenseTransitions("rejected")).toEqual([]);
    expect(allowedExpenseTransitions("reimbursed")).toEqual([]);
    expect(codeOf(() => assertExpenseTransition("rejected", "claimed"))).toBe(
      "illegal_transition",
    );
  });

  it("cannot be reimbursed before it is approved", () => {
    expect(codeOf(() => assertExpenseTransition("claimed", "reimbursed"))).toBe(
      "illegal_transition",
    );
  });

  it("needs a reason to be rejected", () => {
    expect(codeOf(() => assertExpenseDecisionReason("rejected", "no"))).toBe(
      "validation_failed",
    );
    expect(() =>
      assertExpenseDecisionReason("rejected", "No receipt and outside the agreed scope."),
    ).not.toThrow();
    expect(() => assertExpenseDecisionReason("approved", null)).not.toThrow();
  });

  it("is not decided by whoever claimed it", () => {
    const claim = {
      expenseId: "EXP-2026-000001",
      incurredBy: "11111111-1111-1111-1111-111111111111",
    };
    expect(codeOf(() => assertNotDecidingOwnExpense(claim, claim.incurredBy))).toBe(
      "self_approval_forbidden",
    );
    expect(() =>
      assertNotDecidingOwnExpense(claim, "22222222-2222-2222-2222-222222222222"),
    ).not.toThrow();
  });

  it("can be corrected by its claimant only while open", () => {
    expect(() => assertExpenseEditable({ status: "claimed" })).not.toThrow();
    expect(codeOf(() => assertExpenseEditable({ status: "approved" }))).toBe("conflict");
  });
});

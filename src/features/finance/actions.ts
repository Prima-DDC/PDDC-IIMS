"use server";

import { refreshPath } from "@/lib/revalidate";
import { EMPTY_FORM_STATE, invalidForm, type FormState } from "@/lib/forms";
import {
  hasScope,
  requireActorOrThrow,
  requirePermission,
} from "@/lib/auth/session";
import {
  assertExpenseDecisionReason,
  assertExpenseEditable,
  assertExpenseTransition,
  assertFinancialsConsistent,
  assertNotApprovingOwnTime,
  assertNotDecidingOwnExpense,
  assertTimeEntryEditable,
  assertTimeNotInFuture,
  assertTimeQuantity,
  casework,
  isCaseworkError,
} from "@/modules/casework";
import { isIamError } from "@/modules/iam";
import {
  approveTimeSchema,
  claimExpenseSchema,
  createFinancialsSchema,
  decideExpenseSchema,
  logTimeSchema,
  updateExpenseSchema,
  updateFinancialsSchema,
  updateTimeSchema,
} from "./schema";

/**
 * Case financials, time and expense actions (PRD 5.6, 5.7).
 *
 * Three different permissions, because three different people do these
 * things: `financials` for the money, `time` for a timesheet, and the
 * claimant's own identity for an expense. The separation-of-duties rules are
 * applied here, where the actor and the record are both in hand and the
 * refusal can say why.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isCaseworkError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("finance action failed", error);
    return {
      ...EMPTY_FORM_STATE,
      error: "Something went wrong saving that. Nothing was changed.",
    };
  }
}

function revalidateFinance(caseRecordId: string) {
  refreshPath(`/cases/${caseRecordId}`);
  refreshPath("/cases");
}

/** Today, as a date input posts it, for the "not in the future" rule. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------ financials */

export async function createFinancials(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "financials", "create");

    const parsed = createFinancialsSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, ...input } = parsed.data;
    assertFinancialsConsistent(input);

    await casework(actor).finance.saveFinancials(caseRecordId, input);

    revalidateFinance(caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Commercials recorded." };
  });
}

export async function updateFinancials(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "financials", "edit");

    const parsed = updateFinancialsSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { financialsId, caseRecordId, expectedVersion, ...input } = parsed.data;
    assertFinancialsConsistent(input);

    await casework(actor).finance.updateFinancials(
      financialsId,
      input,
      expectedVersion,
    );

    revalidateFinance(caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Commercials saved." };
  });
}

/* ------------------------------------------------------------------ time */

export async function logTime(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "time", "create");

    const parsed = logTimeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, userId, ...input } = parsed.data;
    assertTimeQuantity(input.unit, input.quantity);
    assertTimeNotInFuture(input.workedOn, today());

    // Logging somebody else's time is a supervisory act. Every employee holds
    // time:create at `own` scope, so the permission alone does not say no:
    // the scope does, and the row-level policy keys on the same function.
    const subject = userId ?? actor.userId;
    if (subject !== actor.userId && !(await hasScope(actor, "time", "create", "team"))) {
      return {
        ...EMPTY_FORM_STATE,
        error: "You can only log your own time.",
      };
    }

    const entry = await casework(actor).finance.logTime({
      caseId: caseRecordId,
      userId: subject,
      ...input,
    });

    revalidateFinance(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${entry.quantity} ${entry.unit} logged against ${entry.caseReference}.`,
    };
  });
}

export async function updateTimeEntry(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "time", "edit");

    const parsed = updateTimeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { timeEntryId, caseRecordId, expectedVersion, ...input } = parsed.data;
    assertTimeQuantity(input.unit, input.quantity);
    assertTimeNotInFuture(input.workedOn, today());

    const api = casework(actor);
    const existing = await api.finance.findTimeEntryById(timeEntryId);
    if (!existing) {
      return { ...EMPTY_FORM_STATE, error: "That entry no longer exists." };
    }
    if (
      existing.userId !== actor.userId &&
      !(await hasScope(actor, "time", "edit", "team"))
    ) {
      return {
        ...EMPTY_FORM_STATE,
        error: "You can only change your own time entries.",
      };
    }
    assertTimeEntryEditable(existing);

    await api.finance.updateTimeEntry(timeEntryId, input, expectedVersion);

    revalidateFinance(caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Entry saved." };
  });
}

export async function approveTimeEntry(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    // Approving somebody's time is a supervisory act, so it needs a scope
    // wider than the `own` every employee holds.
    await requirePermission(actor, "time", "edit");
    if (!(await hasScope(actor, "time", "edit", "team"))) {
      return {
        ...EMPTY_FORM_STATE,
        error:
          "Approving time needs a supervisory grant. You can edit your own entries, not approve them.",
      };
    }

    const parsed = approveTimeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = casework(actor);
    const entry = await api.finance.findTimeEntryById(parsed.data.timeEntryId);
    if (!entry) {
      return { ...EMPTY_FORM_STATE, error: "That entry no longer exists." };
    }

    // PRD 16: nobody approves their own work.
    assertNotApprovingOwnTime(entry, actor.userId);

    await api.finance.approveTimeEntry(parsed.data.timeEntryId);

    revalidateFinance(parsed.data.caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: "Approved. The entry is now fixed, so cost reporting stays reproducible.",
    };
  });
}

/* -------------------------------------------------------------- expenses */

export async function claimExpense(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    // Claiming is not a finance permission: anybody who can see the case can
    // be out of pocket on it. Deciding the claim is the part that is gated.
    await requirePermission(actor, "cases", "view");

    const parsed = claimExpenseSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, ...input } = parsed.data;
    assertTimeNotInFuture(input.incurredOn, today());

    const expense = await casework(actor).finance.claimExpense({
      caseId: caseRecordId,
      incurredBy: actor.userId,
      ...input,
    });

    revalidateFinance(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${expense.expenseId} claimed. Somebody other than you has to decide it.`,
    };
  });
}

export async function updateExpense(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "cases", "view");

    const parsed = updateExpenseSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { expenseRecordId, caseRecordId, expectedVersion, ...input } = parsed.data;
    assertTimeNotInFuture(input.incurredOn, today());

    const api = casework(actor);
    const existing = await api.finance.findExpenseById(expenseRecordId);
    if (!existing) {
      return { ...EMPTY_FORM_STATE, error: "That claim no longer exists." };
    }
    assertExpenseEditable(existing);

    await api.finance.updateExpense(expenseRecordId, input, expectedVersion);

    revalidateFinance(caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Claim saved." };
  });
}

export async function decideExpense(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "financials", "edit");

    const parsed = decideExpenseSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { expenseRecordId, caseRecordId, status, reason } = parsed.data;
    const api = casework(actor);

    const expense = await api.finance.findExpenseById(expenseRecordId);
    if (!expense) {
      return { ...EMPTY_FORM_STATE, error: "That claim no longer exists." };
    }

    assertExpenseTransition(expense.status, status);
    assertExpenseDecisionReason(status, reason);
    // PRD 16: the claimant is not the approver.
    assertNotDecidingOwnExpense(expense, actor.userId);

    const decided = await api.finance.decideExpense({
      id: expenseRecordId,
      status,
      reason,
    });

    revalidateFinance(caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${decided.expenseId} is now ${status}.`,
    };
  });
}

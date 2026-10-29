"use client";

import { useState } from "react";
import { BadgeCheck, Check, Clock, Receipt, X } from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import {
  Badge,
  Button,
  Card,
  DescriptionList,
  EmptyState,
  Field,
  Id,
  Input,
  Muted,
  Select,
  StatTile,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_STATUS_LABELS,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_LABELS,
  TIME_UNITS,
  WORK_KINDS,
  WORK_KIND_LABELS,
  allowedExpenseTransitions,
  suggestPaymentStatus,
  type CaseCostSummary,
  type CaseFinancials,
  type Expense,
  type ExpenseStatus,
  type TimeEntry,
} from "@/modules/casework/shared";
import {
  approveTimeEntry,
  claimExpense,
  createFinancials,
  decideExpense,
  logTime,
  updateExpense,
  updateFinancials,
  updateTimeEntry,
} from "./actions";

/** The finance, time and expense panels on a case page (PRD 5.6, 5.7). */

function date(value: string) {
  return new Date(value).toLocaleDateString("en-GB");
}

/**
 * Money, formatted for reading rather than for arithmetic.
 *
 * Intl with the currency code gives the right symbol and separators for the
 * currency the case is actually in, which matters because PDDC bills in more
 * than one.
 */
function amount(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      currencyDisplay: "code",
    }).format(value);
  } catch {
    // An unknown code should not take the panel down with it.
    return `${currency} ${value.toFixed(2)}`;
  }
}

const STATUS_TONES: Record<ExpenseStatus, "neutral" | "info" | "ok" | "danger"> = {
  claimed: "info",
  approved: "ok",
  rejected: "danger",
  reimbursed: "neutral",
};

/* ------------------------------------------------------------ the money */

export function FinancialsPanel({
  caseRecordId,
  financials,
  costs,
  canCreate,
  canEdit,
}: {
  caseRecordId: string;
  financials: CaseFinancials | null;
  costs: CaseCostSummary;
  canCreate: boolean;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const currency = financials?.currency ?? costs.currency;

  return (
    <Card
      title="Commercials"
      description="What was quoted, approved, invoiced and paid. Not an accounting system: the ledger stays where it is."
      actions={
        canEdit && financials && !editing ? (
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {!financials ? (
          canCreate ? (
            <>
              <p className="text-xs text-muted">
                Nothing recorded yet. The fee and the invoice position live here, so
                Operations can answer whether the case is paid for without leaving
                the platform.
              </p>
              <FinancialsForm caseRecordId={caseRecordId} />
            </>
          ) : (
            <EmptyState
              title="No commercials recorded"
              description="Finance and the Operations Manager record the fee and the invoice position."
            />
          )
        ) : editing ? (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Edit the commercials</p>
              <Button size="sm" tone="ghost" onClick={() => setEditing(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <FinancialsForm caseRecordId={caseRecordId} financials={financials} />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile
                label="Approved fee"
                value={
                  financials.approvedFee === null
                    ? "not agreed"
                    : amount(financials.approvedFee, currency)
                }
              />
              <StatTile
                label="Invoiced"
                value={amount(financials.amountInvoiced, currency)}
              />
              <StatTile label="Paid" value={amount(financials.amountPaid, currency)} />
              <StatTile
                label="Outstanding"
                value={amount(financials.outstanding, currency)}
                tone={financials.outstanding > 0 ? "warn" : "ok"}
              />
            </div>

            <DescriptionList
              items={[
                {
                  label: "Payment status",
                  value: (
                    <Badge
                      tone={
                        financials.paymentStatus === "paid"
                          ? "ok"
                          : financials.paymentStatus === "overdue"
                            ? "danger"
                            : financials.paymentStatus === "written_off"
                              ? "warn"
                              : "neutral"
                      }
                    >
                      {PAYMENT_STATUS_LABELS[financials.paymentStatus]}
                    </Badge>
                  ),
                },
                {
                  label: "Quoted fee",
                  value:
                    financials.quotedFee === null ? (
                      <Muted>not quoted</Muted>
                    ) : (
                      amount(financials.quotedFee, currency)
                    ),
                },
                {
                  label: "Additional fees",
                  value: amount(financials.additionalFees, currency),
                },
                {
                  label: "Invoice number",
                  value: financials.invoiceNumber ? (
                    <Id>{financials.invoiceNumber}</Id>
                  ) : (
                    <Muted>not invoiced</Muted>
                  ),
                },
                {
                  label: "Costs so far",
                  value: `${costs.hours} hours, ${costs.days} field days, ${amount(
                    costs.expenseTotal,
                    currency,
                  )} in expenses`,
                },
                {
                  label: "Notes",
                  value: financials.notes ?? <Muted>none</Muted>,
                },
              ]}
            />
          </>
        )}
      </div>
    </Card>
  );
}

function FinancialsForm({
  caseRecordId,
  financials,
}: {
  caseRecordId: string;
  financials?: CaseFinancials;
}) {
  const [invoiced, setInvoiced] = useState(
    financials ? String(financials.amountInvoiced) : "0",
  );
  const [paid, setPaid] = useState(financials ? String(financials.amountPaid) : "0");

  // Offered rather than imposed: the numbers decide everything except
  // "overdue" and "written off", which are judgements they cannot make.
  const suggested = suggestPaymentStatus(Number(invoiced) || 0, Number(paid) || 0);

  return (
    <ActionForm
      action={financials ? updateFinancials : createFinancials}
      submitLabel={financials ? "Save the commercials" : "Record the commercials"}
      submitSize="sm"
      hidden={
        financials
          ? {
              caseRecordId,
              financialsId: financials.id,
              expectedVersion: financials.version,
            }
          : { caseRecordId }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Currency"
            htmlFor="fin-currency"
            required
            error={state.fieldErrors?.currency}
          >
            <Input
              id="fin-currency"
              name="currency"
              maxLength={3}
              defaultValue={financials?.currency ?? "GHS"}
            />
          </Field>

          <Field
            label="Quoted fee"
            htmlFor="fin-quoted"
            error={state.fieldErrors?.quotedFee}
          >
            <Input
              id="fin-quoted"
              name="quotedFee"
              inputMode="decimal"
              defaultValue={financials?.quotedFee?.toString() ?? ""}
            />
          </Field>

          <Field
            label="Approved fee"
            htmlFor="fin-approved"
            error={state.fieldErrors?.approvedFee}
          >
            <Input
              id="fin-approved"
              name="approvedFee"
              inputMode="decimal"
              defaultValue={financials?.approvedFee?.toString() ?? ""}
            />
          </Field>

          <Field
            label="Additional fees"
            htmlFor="fin-additional"
            error={state.fieldErrors?.additionalFees}
          >
            <Input
              id="fin-additional"
              name="additionalFees"
              inputMode="decimal"
              defaultValue={financials?.additionalFees.toString() ?? "0"}
            />
          </Field>

          <Field
            label="Invoice number"
            htmlFor="fin-invoice"
            hint="Required once anything is invoiced."
            error={state.fieldErrors?.invoiceNumber}
          >
            <Input
              id="fin-invoice"
              name="invoiceNumber"
              defaultValue={financials?.invoiceNumber ?? ""}
            />
          </Field>

          <Field
            label="Amount invoiced"
            htmlFor="fin-invoiced"
            error={state.fieldErrors?.amountInvoiced}
          >
            {/* Uncontrolled, as elsewhere: React resets a controlled field
                on hydration, discarding a figure typed before the JavaScript
                arrived. The state only drives the suggested status. */}
            <Input
              id="fin-invoiced"
              name="amountInvoiced"
              inputMode="decimal"
              defaultValue={invoiced}
              onChange={(e) => setInvoiced(e.target.value)}
            />
          </Field>

          <Field
            label="Amount paid"
            htmlFor="fin-paid"
            error={state.fieldErrors?.amountPaid}
          >
            <Input
              id="fin-paid"
              name="amountPaid"
              inputMode="decimal"
              defaultValue={paid}
              onChange={(e) => setPaid(e.target.value)}
            />
          </Field>

          <Field
            label="Payment status"
            htmlFor="fin-status"
            required
            hint={`The amounts say "${PAYMENT_STATUS_LABELS[suggested]}".`}
            error={state.fieldErrors?.paymentStatus}
          >
            <Select
              id="fin-status"
              name="paymentStatus"
              defaultValue={financials?.paymentStatus ?? suggested}
            >
              {PAYMENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {PAYMENT_STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-3">
            <Field
              label="Notes"
              htmlFor="fin-notes"
              hint="Required to write a fee off, and the place to say why there is no fee."
              error={state.fieldErrors?.notes}
            >
              <Textarea
                id="fin-notes"
                name="notes"
                rows={2}
                defaultValue={financials?.notes ?? ""}
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/* -------------------------------------------------------------- the time */

export function TimePanel({
  caseRecordId,
  entries,
  costs,
  tasks,
  people,
  actorId,
  canLog,
  canManage,
  ownOnly,
}: {
  caseRecordId: string;
  entries: TimeEntry[];
  costs: CaseCostSummary;
  tasks: Array<{ id: string; label: string }>;
  people: Array<{ id: string; name: string }>;
  actorId: string;
  canLog: boolean;
  canManage: boolean;
  /** True when row-level security narrows these figures to the viewer's own. */
  ownOnly: boolean;
}) {
  const [logging, setLogging] = useState(false);
  const [editing, setEditing] = useState<TimeEntry | null>(null);

  return (
    <Card
      title="Time"
      description="Hours and field days against this case. Hours and days are kept in their own units, never converted."
      actions={
        canLog && !logging ? (
          <Button size="sm" onClick={() => setLogging(true)}>
            <Clock className="size-4" aria-hidden="true" />
            Log time
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Hours" value={costs.hours} />
          <StatTile label="Billable hours" value={costs.billableHours} />
          <StatTile label="Field days" value={costs.days} />
          <StatTile label="Entries" value={entries.length} />
        </div>

        {/* Said rather than implied: these come through row-level security, so
            somebody holding time at `own` scope is looking at their own hours
            and would otherwise read them as the case total. */}
        {ownOnly && (
          <Muted>
            These are your own hours on this case. A supervisor sees everybody&apos;s.
          </Muted>
        )}

        {logging && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Log time</p>
              <Button size="sm" tone="ghost" onClick={() => setLogging(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <TimeForm
              caseRecordId={caseRecordId}
              tasks={tasks}
              people={canManage ? people : undefined}
            />
          </div>
        )}

        {editing && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Edit the entry</p>
              <Button size="sm" tone="ghost" onClick={() => setEditing(null)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <TimeForm caseRecordId={caseRecordId} tasks={tasks} entry={editing} />
          </div>
        )}

        {entries.length === 0 ? (
          <EmptyState
            title="No time logged"
            description="Logging as the work happens is what makes a cost report believable."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Who</Th>
                <Th>Work</Th>
                <Th className="text-right">Amount</Th>
                <Th className="text-right">Status</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <Td className="text-xs whitespace-nowrap text-muted">
                    {date(entry.workedOn)}
                  </Td>
                  <Td className="text-xs">
                    {entry.userName ?? <Muted>unknown</Muted>}
                    {entry.userId === actorId && <Muted> (you)</Muted>}
                  </Td>
                  <Td className="text-xs">
                    {WORK_KIND_LABELS[entry.workKind]}
                    {entry.taskTitle && (
                      <p className="max-w-48 truncate text-[11px] text-faint">
                        {entry.taskTitle}
                      </p>
                    )}
                    {entry.description && (
                      <p className="max-w-64 text-[11px] text-faint">
                        {entry.description}
                      </p>
                    )}
                  </Td>
                  <Td className="text-right text-xs tabular-nums whitespace-nowrap">
                    {entry.quantity} {entry.unit}
                    {!entry.isBillable && <Muted> non-billable</Muted>}
                  </Td>
                  <Td className="text-right">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {entry.approvedAt ? (
                        <Badge tone="ok">
                          <BadgeCheck className="size-3" aria-hidden="true" />
                          Approved
                        </Badge>
                      ) : (
                        <>
                          {(entry.userId === actorId || canManage) && (
                            <Button
                              size="sm"
                              tone="ghost"
                              onClick={() => setEditing(entry)}
                            >
                              Edit
                            </Button>
                          )}
                          {canManage && entry.userId !== actorId && (
                            <ActionForm
                              action={approveTimeEntry}
                              submitLabel={
                                <>
                                  <Check className="size-3.5" aria-hidden="true" />
                                  Approve
                                </>
                              }
                              submitSize="sm"
                              hidden={{ caseRecordId, timeEntryId: entry.id }}
                              compact
                            />
                          )}
                          {entry.userId === actorId && (
                            <Muted>yours, so somebody else approves it</Muted>
                          )}
                        </>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Card>
  );
}

function TimeForm({
  caseRecordId,
  tasks,
  people,
  entry,
}: {
  caseRecordId: string;
  tasks: Array<{ id: string; label: string }>;
  people?: Array<{ id: string; name: string }>;
  entry?: TimeEntry;
}) {
  return (
    <ActionForm
      action={entry ? updateTimeEntry : logTime}
      submitLabel={entry ? "Save the entry" : "Log it"}
      submitSize="sm"
      hidden={
        entry
          ? {
              caseRecordId,
              timeEntryId: entry.id,
              expectedVersion: entry.version,
            }
          : { caseRecordId }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-3">
          {!entry && people && people.length > 0 && (
            <Field
              label="Whose time"
              htmlFor="time-user"
              hint="Leave as yourself unless you are logging for somebody else."
              error={state.fieldErrors?.userId}
            >
              <Select id="time-user" name="userId" defaultValue="">
                <option value="">Mine</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label="Date"
            htmlFor="time-date"
            required
            error={state.fieldErrors?.workedOn}
          >
            <Input
              id="time-date"
              name="workedOn"
              type="date"
              defaultValue={entry?.workedOn.slice(0, 10) ?? ""}
            />
          </Field>

          <Field
            label="How much"
            htmlFor="time-quantity"
            required
            error={state.fieldErrors?.quantity}
          >
            <Input
              id="time-quantity"
              name="quantity"
              inputMode="decimal"
              defaultValue={entry?.quantity.toString() ?? ""}
              placeholder="3.5"
            />
          </Field>

          <Field
            label="Unit"
            htmlFor="time-unit"
            required
            error={state.fieldErrors?.unit}
          >
            <Select id="time-unit" name="unit" defaultValue={entry?.unit ?? "hours"}>
              {TIME_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit === "hours" ? "Hours" : "Field days"}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Kind of work"
            htmlFor="time-kind"
            required
            error={state.fieldErrors?.workKind}
          >
            <Select
              id="time-kind"
              name="workKind"
              defaultValue={entry?.workKind ?? "investigation"}
            >
              {WORK_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {WORK_KIND_LABELS[kind]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Against which task"
            htmlFor="time-task"
            error={state.fieldErrors?.taskId}
          >
            <Select id="time-task" name="taskId" defaultValue={entry?.taskId ?? ""}>
              <option value="">Not a particular task</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.label}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-3">
            <Field
              label="What was done"
              htmlFor="time-description"
              error={state.fieldErrors?.description}
            >
              <Input
                id="time-description"
                name="description"
                defaultValue={entry?.description ?? ""}
              />
            </Field>
          </div>

          <div className="sm:col-span-3">
            <label className="flex items-center gap-2 text-xs text-body">
              <input
                type="checkbox"
                name="isBillable"
                defaultChecked={entry?.isBillable ?? true}
                className="size-4 rounded border-line"
              />
              Billable to the client
            </label>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/* ---------------------------------------------------------- the expenses */

export function ExpensesPanel({
  caseRecordId,
  expenses,
  costs,
  actorId,
  canDecide,
  ownOnly,
}: {
  caseRecordId: string;
  expenses: Expense[];
  costs: CaseCostSummary;
  actorId: string;
  canDecide: boolean;
  /** True when row-level security narrows these figures to the viewer's own. */
  ownOnly: boolean;
}) {
  const [claiming, setClaiming] = useState(false);
  const [deciding, setDeciding] = useState<Expense | null>(null);

  return (
    <Card
      title="Costs"
      description="What the case has cost, claimed by whoever paid it and decided by somebody else."
      actions={
        !claiming ? (
          <Button size="sm" onClick={() => setClaiming(true)}>
            <Receipt className="size-4" aria-hidden="true" />
            Claim a cost
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Total"
            value={amount(costs.expenseTotal, costs.currency)}
          />
          <StatTile
            label="Billable"
            value={amount(costs.billableExpenseTotal, costs.currency)}
          />
          <StatTile
            label="Approved"
            value={amount(costs.approvedExpenseTotal, costs.currency)}
          />
          <StatTile
            label="Awaiting a decision"
            value={costs.claimedExpenseCount}
            tone={costs.claimedExpenseCount > 0 ? "warn" : "ok"}
          />
        </div>

        {ownOnly && (
          <Muted>
            These are your own claims on this case. Finance and the Operations
            Manager see all of them.
          </Muted>
        )}

        {claiming && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Claim a cost</p>
              <Button size="sm" tone="ghost" onClick={() => setClaiming(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ExpenseForm caseRecordId={caseRecordId} currency={costs.currency} />
          </div>
        )}

        {deciding && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">
                Decide {deciding.expenseId}
              </p>
              <Button size="sm" tone="ghost" onClick={() => setDeciding(null)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ExpenseDecisionForm caseRecordId={caseRecordId} expense={deciding} />
          </div>
        )}

        {expenses.length === 0 ? (
          <EmptyState
            title="No costs claimed"
            description="Travel, records, specialists and anything else somebody paid for."
          />
        ) : (
          <ol className="space-y-2">
            {expenses.map((expense) => (
              <li key={expense.id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS_TONES[expense.status]}>
                    {EXPENSE_STATUS_LABELS[expense.status]}
                  </Badge>
                  <Badge tone="neutral">
                    {EXPENSE_CATEGORY_LABELS[expense.category]}
                  </Badge>
                  <Id>{expense.expenseId}</Id>
                  <span className="ml-auto text-xs font-semibold tabular-nums text-body">
                    {amount(expense.amount, expense.currency)}
                  </span>
                </div>

                <p className="mt-1.5 text-xs text-body">{expense.description}</p>

                <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted">
                  <span>Incurred {date(expense.incurredOn)}</span>
                  {expense.incurredByName && (
                    <span>
                      by {expense.incurredByName}
                      {expense.incurredBy === actorId ? " (you)" : ""}
                    </span>
                  )}
                  {expense.receiptReference && (
                    <span>Receipt {expense.receiptReference}</span>
                  )}
                  {!expense.isBillable && <span>Not billable</span>}
                </p>

                {expense.decisionReason && (
                  <p className="mt-1.5 text-[11px] text-muted">
                    {EXPENSE_STATUS_LABELS[expense.status]}: {expense.decisionReason}
                    {expense.decidedByName ? ` (${expense.decidedByName})` : ""}
                  </p>
                )}

                {allowedExpenseTransitions(expense.status).length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                    {expense.incurredBy === actorId ? (
                      <Muted>your own claim, so somebody else decides it</Muted>
                    ) : canDecide ? (
                      <Button
                        size="sm"
                        tone="ghost"
                        onClick={() => setDeciding(expense)}
                      >
                        Decide it
                      </Button>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

function ExpenseForm({
  caseRecordId,
  currency,
  expense,
}: {
  caseRecordId: string;
  currency: string;
  expense?: Expense;
}) {
  return (
    <ActionForm
      action={expense ? updateExpense : claimExpense}
      submitLabel={expense ? "Save the claim" : "Submit the claim"}
      submitSize="sm"
      hidden={
        expense
          ? {
              caseRecordId,
              expenseRecordId: expense.id,
              expectedVersion: expense.version,
            }
          : { caseRecordId }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Date"
            htmlFor="expense-date"
            required
            error={state.fieldErrors?.incurredOn}
          >
            <Input
              id="expense-date"
              name="incurredOn"
              type="date"
              defaultValue={expense?.incurredOn.slice(0, 10) ?? ""}
            />
          </Field>

          <Field
            label="Category"
            htmlFor="expense-category"
            required
            error={state.fieldErrors?.category}
          >
            <Select
              id="expense-category"
              name="category"
              defaultValue={expense?.category ?? "travel"}
            >
              {EXPENSE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {EXPENSE_CATEGORY_LABELS[category]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Amount"
            htmlFor="expense-amount"
            required
            error={state.fieldErrors?.amount}
          >
            <Input
              id="expense-amount"
              name="amount"
              inputMode="decimal"
              defaultValue={expense?.amount.toString() ?? ""}
            />
          </Field>

          <Field
            label="Currency"
            htmlFor="expense-currency"
            required
            error={state.fieldErrors?.currency}
          >
            <Input
              id="expense-currency"
              name="currency"
              maxLength={3}
              defaultValue={expense?.currency ?? currency}
            />
          </Field>

          <Field
            label="Receipt reference"
            htmlFor="expense-receipt"
            hint="Where the receipt is filed."
            error={state.fieldErrors?.receiptReference}
          >
            <Input
              id="expense-receipt"
              name="receiptReference"
              defaultValue={expense?.receiptReference ?? ""}
            />
          </Field>

          <div className="flex items-end">
            <label className="flex items-center gap-2 text-xs text-body">
              <input
                type="checkbox"
                name="isBillable"
                defaultChecked={expense?.isBillable ?? true}
                className="size-4 rounded border-line"
              />
              Billable to the client
            </label>
          </div>

          <div className="sm:col-span-3">
            <Field
              label="What it was for"
              htmlFor="expense-description"
              required
              error={state.fieldErrors?.description}
            >
              <Input
                id="expense-description"
                name="description"
                defaultValue={expense?.description ?? ""}
                placeholder="Return flight to Kumasi for the site visit"
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

function ExpenseDecisionForm({
  caseRecordId,
  expense,
}: {
  caseRecordId: string;
  expense: Expense;
}) {
  const transitions = allowedExpenseTransitions(expense.status);
  const [target, setTarget] = useState<string>(transitions[0] ?? "");

  return (
    <ActionForm
      action={decideExpense}
      submitLabel="Record the decision"
      submitSize="sm"
      hidden={{ caseRecordId, expenseRecordId: expense.id }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Decision"
            htmlFor="expense-status"
            required
            error={state.fieldErrors?.status}
          >
            <Select
              id="expense-status"
              name="status"
              defaultValue={transitions[0] ?? ""}
              onChange={(e) => setTarget(e.target.value)}
            >
              {transitions.map((status) => (
                <option key={status} value={status}>
                  {EXPENSE_STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Reason"
            htmlFor="expense-reason"
            required={target === "rejected"}
            hint={
              target === "rejected"
                ? "Required, so the claim can be corrected and resubmitted."
                : undefined
            }
            error={state.fieldErrors?.reason}
          >
            <Input id="expense-reason" name="reason" />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

import { AppLink } from "@/components/AppLink";
import { AlertTriangle, TrendingDown, TrendingUp } from "lucide-react";
import {
  Badge,
  Card,
  EmptyState,
  Id,
  Muted,
  StatTile,
  Table,
  Td,
  Th,
} from "@/components/ui";
import type { ManagementReport } from "@/modules/reporting/shared";

/**
 * The management reports (PRD 10.4).
 *
 * Six figures a manager reads together: the case register, turnaround time,
 * workload by investigator, overdue tasks, the QA return rate, and revenue
 * against cost. Every one goes through row-level security, so two managers
 * can legitimately see different numbers, and the screen says so rather than
 * presenting them as the firm's totals.
 */

function money(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;
}

export function ManagementSummary({ report }: { report: ManagementReport }) {
  const rate = report.qaReturnRate.rate;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile label="Cases" value={report.caseRegister.length} />
      <StatTile
        label="Median days to close"
        value={report.turnaround.medianDays ?? 0}
        tone="neutral"
      />
      <StatTile
        label="Overdue tasks"
        value={report.overdueTasks.length}
        tone={report.overdueTasks.length > 0 ? "warn" : "ok"}
      />
      <StatTile
        label="QA return rate"
        // Null and zero are different claims: "we never send anything back"
        // is not "we have not reviewed anything".
        value={rate === null ? 0 : Math.round(rate * 100)}
        tone={rate !== null && rate > 0.3 ? "warn" : "ok"}
      />
    </div>
  );
}

export function TurnaroundCard({ report }: { report: ManagementReport }) {
  const { turnaround, qaReturnRate } = report;

  return (
    <Card
      title="Turnaround and quality"
      description="How long a case takes from opening to closure, and how often QA sends a report back."
    >
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
            Cases closed
          </dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-body">
            {turnaround.closedCases}
          </dd>
        </div>
        <div>
          <dt className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
            Median days
          </dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-body">
            {turnaround.medianDays ?? <Muted>no closed cases</Muted>}
          </dd>
        </div>
        <div>
          <dt className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
            Longest
          </dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-body">
            {turnaround.longestDays ?? <Muted>none</Muted>}
          </dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-line pt-4">
        <p className="text-xs text-body">
          {qaReturnRate.reviewsCompleted === 0 ? (
            <Muted>
              No QA review has been completed, so there is no return rate yet.
              That is not a rate of zero.
            </Muted>
          ) : (
            <>
              {qaReturnRate.returned} of {qaReturnRate.reviewsCompleted} QA
              reviews were returned for correction, which is{" "}
              {Math.round((qaReturnRate.rate ?? 0) * 100)}%.
            </>
          )}
        </p>
      </div>
    </Card>
  );
}

export function WorkloadTable({ report }: { report: ManagementReport }) {
  const busy = report.workload.filter(
    (row) => row.openCases > 0 || row.openTasks > 0,
  );

  if (busy.length === 0) {
    return (
      <EmptyState
        title="Nobody is carrying open work"
        description="Workload is counted from live case assignments and open tasks."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Who</Th>
          <Th className="text-right">Open cases</Th>
          <Th className="text-right">Open tasks</Th>
          <Th className="text-right">Overdue</Th>
        </tr>
      </thead>
      <tbody>
        {busy.map((row) => (
          <tr key={row.userId}>
            <Td className="font-medium text-body">{row.name}</Td>
            <Td className="text-right tabular-nums text-muted">{row.openCases}</Td>
            <Td className="text-right tabular-nums text-muted">{row.openTasks}</Td>
            <Td className="text-right">
              {row.overdueTasks > 0 ? (
                <Badge tone="warn">
                  <AlertTriangle className="size-3" aria-hidden="true" />
                  {row.overdueTasks}
                </Badge>
              ) : (
                <Muted>none</Muted>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function OverdueTable({ report }: { report: ManagementReport }) {
  if (report.overdueTasks.length === 0) {
    return (
      <EmptyState
        title="Nothing overdue"
        description="Every open task is within its due date."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Task</Th>
          <Th>Case</Th>
          <Th>Assigned to</Th>
          <Th className="text-right">Days late</Th>
        </tr>
      </thead>
      <tbody>
        {report.overdueTasks.map((row) => (
          <tr key={row.taskId}>
            <Td>
              <AppLink
                href={`/tasks/${row.taskId}`}
                className="font-medium text-body hover:text-signal-dark hover:underline"
              >
                {row.title}
              </AppLink>
              <Id>{row.taskReference}</Id>
            </Td>
            <Td className="text-xs text-muted">{row.caseReference}</Td>
            <Td className="text-xs text-muted">
              {row.assigneeName ?? <Muted>unassigned</Muted>}
            </Td>
            <Td className="text-right">
              <Badge tone={row.daysOverdue > 7 ? "danger" : "warn"}>
                {row.daysOverdue}
              </Badge>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * Revenue against cost, per case (PRD 10.4).
 *
 * Billed is what was invoiced, not what was quoted: a quote is an intention.
 * Cost is approved expenses, because an expense nobody signed off is not a
 * cost PDDC can defend putting in front of a manager.
 */
export function CommercialsTable({ report }: { report: ManagementReport }) {
  const rows = report.revenueVersusCost.filter(
    (row) => row.billed > 0 || row.cost > 0,
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing billed or spent yet"
        description="Revenue is what was invoiced, and cost is approved expenses."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Case</Th>
          <Th className="text-right">Billed</Th>
          <Th className="text-right">Cost</Th>
          <Th className="text-right">Margin</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.caseId}>
            <Td>
              <AppLink
                href={`/cases/${row.caseId}?tab=finance`}
                className="font-medium text-body hover:text-signal-dark hover:underline"
              >
                {row.title}
              </AppLink>
              <Id>{row.caseReference}</Id>
            </Td>
            <Td className="text-right tabular-nums text-muted">
              {money(row.billed, row.currency)}
            </Td>
            <Td className="text-right tabular-nums text-muted">
              {money(row.cost, row.currency)}
            </Td>
            <Td className="text-right">
              <span
                className={`inline-flex items-center gap-1 tabular-nums ${
                  row.margin < 0 ? "text-danger" : "text-ok"
                }`}
              >
                {row.margin < 0 ? (
                  <TrendingDown className="size-3.5" aria-hidden="true" />
                ) : (
                  <TrendingUp className="size-3.5" aria-hidden="true" />
                )}
                {money(row.margin, row.currency)}
              </span>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function CaseRegisterTable({ report }: { report: ManagementReport }) {
  if (report.caseRegister.length === 0) {
    return <EmptyState title="No cases" description="Nothing to report on yet." />;
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Case</Th>
          <Th>Client</Th>
          <Th>Stage</Th>
          <Th>Lead</Th>
          <Th className="text-right">Days open</Th>
        </tr>
      </thead>
      <tbody>
        {report.caseRegister.map((row) => (
          <tr key={row.caseId}>
            <Td>
              <AppLink
                href={`/cases/${row.caseId}`}
                className="font-medium text-body hover:text-signal-dark hover:underline"
              >
                {row.title}
              </AppLink>
              <Id>{row.caseReference}</Id>
            </Td>
            <Td className="text-xs text-muted">{row.clientName}</Td>
            <Td className="text-xs text-muted">{row.stageName}</Td>
            <Td className="text-xs text-muted">
              {row.leadInvestigatorName ?? <Muted>unassigned</Muted>}
            </Td>
            <Td className="text-right tabular-nums text-muted">
              {row.daysOpen}
              {row.closedAt ? "" : " and counting"}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

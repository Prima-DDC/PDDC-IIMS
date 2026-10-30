import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCheck,
  CircleDollarSign,
  ClipboardList,
  FileText,
  Hourglass,
  ShieldAlert,
  UserX,
} from "lucide-react";
import { AppLink } from "@/components/AppLink";
import { Badge, Card, Muted } from "@/components/ui";
import type { ReactNode } from "react";
import {
  getFinanceWidgets,
  getManagementWidgets,
  getOperationsWidgets,
  getPersonalWidgets,
  getQaWidgets,
  getTeamWidgets,
} from "./queries";

/**
 * The dashboard widgets (PRD 11).
 *
 * Each export is an async server component, so each one is its own Suspense
 * boundary on the page and one slow query never blocks the rest: that is
 * PRD 11's "widgets load lazily and independently" taken literally rather
 * than approximated with a spinner over everything.
 *
 * Every widget that shows a number links to the screen that number came from,
 * and the link carries the same filter. A figure nobody can get behind is a
 * figure nobody can check, and the counts here are read through row-level
 * security from the same endpoints those screens use, so the two always
 * agree.
 */

/* ------------------------------------------------------------ primitives */

function Figure({
  label,
  value,
  tone,
  href,
  note,
}: {
  label: string;
  value: number | string;
  tone?: "warn" | "danger" | "ok";
  href?: string;
  note?: string;
}) {
  const colour =
    tone === "danger"
      ? "text-danger"
      : tone === "warn"
        ? "text-warn"
        : tone === "ok"
          ? "text-ok"
          : "text-body";

  const body = (
    <>
      <dt className="text-[10.5px] tracking-wide text-faint uppercase">{label}</dt>
      <dd className={`mt-0.5 text-2xl leading-none font-semibold ${colour}`}>
        {value}
      </dd>
      {note && <p className="mt-1 text-[11px] text-muted">{note}</p>}
    </>
  );

  if (!href) return <div>{body}</div>;

  return (
    <AppLink
      href={href}
      className="-m-2 rounded-lg p-2 transition-colors hover:bg-surface-sunken"
    >
      {body}
    </AppLink>
  );
}

function Queue({
  items,
  empty,
}: {
  items: Array<{ href: string; title: string; meta?: ReactNode }>;
  empty: string;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-muted">{empty}</p>;
  }

  return (
    <ul className="divide-y divide-line">
      {items.map((item) => (
        <li key={item.href + item.title}>
          <AppLink
            href={item.href}
            className="group flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-body">
                {item.title}
              </span>
              {item.meta && (
                <span className="mt-0.5 block text-[11px] text-muted">
                  {item.meta}
                </span>
              )}
            </span>
            <ArrowRight
              className="size-3.5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-signal"
              aria-hidden="true"
            />
          </AppLink>
        </li>
      ))}
    </ul>
  );
}

function Bars({
  rows,
  empty,
}: {
  rows: Array<{ label: string; value: number }>;
  empty: string;
}) {
  if (rows.length === 0) return <p className="text-xs text-muted">{empty}</p>;

  const most = Math.max(...rows.map((row) => row.value), 1);

  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.label} className="text-[11px]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-body">{row.label}</span>
            <span className="shrink-0 font-mono text-muted">{row.value}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
            <div
              className="h-full rounded-full bg-signal/70"
              style={{ width: `${Math.round((row.value / most) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function dueLabel(due: string | null): string {
  if (!due) return "no due date";
  const days = Math.round((new Date(due).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `due in ${days}d`;
}

export function WidgetSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="card space-y-3 rounded-xl p-4">
      <div className="skeleton h-3 w-28" data-loading aria-hidden="true" />
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="skeleton h-3 w-full"
          data-loading
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- personal */

export async function PersonalWidgets() {
  const view = await getPersonalWidgets();

  return (
    <>
      <Card title="Your workload" description="What is open and assigned to you.">
        <dl className="grid grid-cols-3 gap-3">
          <Figure label="Cases" value={view.myCaseCount} href="/cases?mine=1" />
          <Figure label="Open tasks" value={view.myTaskCount} href="/tasks?mine=1" />
          <Figure
            label="Overdue"
            value={view.myOverdueCount}
            tone={view.myOverdueCount > 0 ? "danger" : "ok"}
            href="/tasks?mine=1&overdueOnly=1"
          />
        </dl>
      </Card>

      <Card
        title="Your deadlines"
        description="Due in the next seven days, soonest first."
      >
        <Queue
          items={view.myDeadlines.map((task) => ({
            href: `/tasks/${task.id}`,
            title: `${task.taskId}: ${task.title}`,
            meta: `${task.caseReference} - ${dueLabel(task.dueDate)}`,
          }))}
          empty="Nothing is due this week."
        />
      </Card>

      <Card title="Your cases" description="Open cases you are assigned to.">
        <Queue
          items={view.myCases.map((record) => ({
            href: `/cases/${record.id}`,
            title: `${record.caseId}: ${record.title}`,
            meta: (
              <span className="inline-flex items-center gap-1.5">
                {record.stageName}
                <Badge tone={record.riskLevel === "critical" ? "danger" : "neutral"}>
                  {record.riskLevel}
                </Badge>
              </span>
            ),
          }))}
          empty="You are not on any open case."
        />
      </Card>

      <Card title="Your reports" description="Reports you are the author of.">
        <Queue
          items={view.myReports.map((report) => ({
            href: `/reports/${report.id}`,
            title: `${report.reportId}: ${report.title}`,
            meta: `${report.caseReference} - ${report.status.replace(/_/g, " ")}`,
          }))}
          empty="You have not written a report yet."
        />
      </Card>

      <Card
        title="Your recent activity"
        description="The last five things you recorded."
      >
        <Queue
          items={view.myActivities.map((activity) => ({
            href: `/cases/${activity.caseId}`,
            title: activity.description,
            meta: `${activity.activityType.replace(/_/g, " ")} - ${new Date(
              activity.occurredAt,
            ).toLocaleDateString()}`,
          }))}
          empty="Nothing recorded yet."
        />
      </Card>
    </>
  );
}

/* ------------------------------------------------------------ operations */

export async function OperationsWidgets() {
  const view = await getOperationsWidgets();

  return (
    <>
      <Card
        title="Operations"
        description="The queue: what has arrived, what nobody owns, and what is due."
      >
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure label="Open cases" value={view.openCases} href="/cases" />
          <Figure label="New this week" value={view.newThisWeek} href="/cases" />
          <Figure
            label="Unassigned"
            value={view.unassigned.length}
            tone={view.unassigned.length > 0 ? "warn" : "ok"}
          />
          <Figure
            label="Conflicts to decide"
            value={view.pendingConflictCount}
            tone={view.pendingConflictCount > 0 ? "warn" : "ok"}
            href="/intake/conflicts"
          />
        </dl>
      </Card>

      <Card
        title="Nobody is on these"
        description="An open case with no live assignment is work that is not happening."
        actions={<UserX className="size-4 text-warn" aria-hidden="true" />}
      >
        <Queue
          items={view.unassigned.slice(0, 5).map((record) => ({
            href: `/cases/${record.id}`,
            title: `${record.caseId}: ${record.title}`,
            meta: `${record.clientName} - opened ${new Date(
              record.openedAt,
            ).toLocaleDateString()}`,
          }))}
          empty="Every open case has somebody on it."
        />
      </Card>

      <Card
        title="Conflicts awaiting a decision"
        description="PRD 8.3: an enquiry cannot become a case until a manager decides."
      >
        <Queue
          items={view.pendingConflicts.map((check) => ({
            href: `/intake/conflicts/${check.id}`,
            title: `${check.checkId}: ${check.matchCount} possible ${
              check.matchCount === 1 ? "match" : "matches"
            }`,
            meta:
              check.enquiryReference ??
              check.clientName ??
              check.engagementReference ??
              "no subject recorded",
          }))}
          empty="Nothing is waiting on a conflict decision."
        />
      </Card>

      <Card title="Due this week" description="Across every case you can see.">
        <Queue
          items={view.dueThisWeek.slice(0, 6).map((task) => ({
            href: `/tasks/${task.id}`,
            title: `${task.taskId}: ${task.title}`,
            meta: `${task.assignedToName ?? "unassigned"} - ${dueLabel(task.dueDate)}`,
          }))}
          empty="Nothing falls due in the next seven days."
        />
      </Card>

      <Card
        title="Workload"
        description="Open cases and tasks per person, busiest first."
      >
        <Bars
          rows={view.workload.map((row) => ({
            label: `${row.name} (${row.openCases} cases)`,
            value: row.openTasks,
          }))}
          empty="Nobody has open work."
        />
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ team */

export async function TeamWidgets() {
  const view = await getTeamWidgets();

  return (
    <>
      <Card
        title="Your team"
        description="What is waiting on a supervisor's decision."
      >
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure label="Open cases" value={view.teamCaseCount} href="/cases" />
          <Figure
            label="Plans to approve"
            value={view.plansAwaitingApproval.length}
            tone={view.plansAwaitingApproval.length > 0 ? "warn" : "ok"}
          />
          <Figure
            label="Reports to read"
            value={view.reportsAwaitingReviewCount}
            tone={view.reportsAwaitingReviewCount > 0 ? "warn" : "ok"}
            href="/reports"
          />
          <Figure
            label="Overdue tasks"
            value={view.overdueTaskCount}
            tone={view.overdueTaskCount > 0 ? "danger" : "ok"}
            href="/tasks?overdueOnly=1"
          />
        </dl>
      </Card>

      {view.checkInsDue.length > 0 && (
        <Card
          title="Somebody is late checking in"
          description="PRD 5.8. Telephone them; a notification is not a welfare check."
          actions={<ShieldAlert className="size-4 text-danger" aria-hidden="true" />}
        >
          <Queue
            items={view.checkInsDue.map((checkIn) => ({
              href: `/cases/${checkIn.caseId}`,
              title: `${checkIn.userName ?? "Somebody"} on ${checkIn.caseReference}`,
              meta: `${checkIn.location ?? "location not recorded"} - due ${
                checkIn.nextDueAt
                  ? new Date(checkIn.nextDueAt).toLocaleString()
                  : "unknown"
              }`,
            }))}
            empty="Nobody is late."
          />
        </Card>
      )}

      <Card
        title="Plans awaiting approval"
        description="PRD 9.3: work should not start until the plan is approved."
      >
        <Queue
          items={view.plansAwaitingApproval.map(({ caseRecord }) => ({
            href: `/cases/${caseRecord.id}`,
            title: `${caseRecord.caseId}: ${caseRecord.title}`,
            meta: caseRecord.leadInvestigatorName ?? "no lead investigator",
          }))}
          empty="No plan is waiting on you."
        />
      </Card>

      <Card title="Reports to read" description="Waiting on your decision.">
        <Queue
          items={view.reportsAwaitingReview.map((report) => ({
            href: `/reports/${report.id}`,
            title: `${report.reportId}: ${report.title}`,
            meta: `${report.caseReference} - ${report.status.replace(/_/g, " ")}`,
          }))}
          empty="Nothing is waiting on your review."
        />
      </Card>

      <Card title="Overdue tasks" description="Across your team's cases.">
        <Queue
          items={view.overdueTasks.map((task) => ({
            href: `/tasks/${task.id}`,
            title: `${task.taskId}: ${task.title}`,
            meta: `${task.assignedToName ?? "unassigned"} - ${dueLabel(task.dueDate)}`,
          }))}
          empty="Nothing is overdue."
        />
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------- qa */

export async function QaWidgets() {
  const view = await getQaWidgets();

  return (
    <>
      <Card
        title="Quality assurance"
        description="PRD 10.3's twelve checks, and how the reports are doing against them."
      >
        <dl className="grid grid-cols-2 gap-3">
          <Figure
            label="Awaiting QA"
            value={view.awaitingReviewCount}
            tone={view.awaitingReviewCount > 0 ? "warn" : "ok"}
            href="/reports"
          />
          <Figure
            label="With their authors"
            value={view.withAuthorsCount}
            note="Drafts, including everything returned for correction."
            href="/reports"
          />
        </dl>
      </Card>

      <Card title="Awaiting your review" description="Reports at the QA stage.">
        <Queue
          items={view.awaitingReview.map((report) => ({
            href: `/reports/${report.id}`,
            title: `${report.reportId}: ${report.title}`,
            meta: `${report.caseReference} - ${report.authorName ?? "unknown author"}`,
          }))}
          empty="Nothing is waiting for QA."
        />
      </Card>

      <Card
        title="Checks that fail most often"
        description="Counted over completed reviews. A check that keeps failing is either a habit to train out or a check to reword."
        actions={<CheckCheck className="size-4 text-muted" aria-hidden="true" />}
      >
        <Bars
          rows={view.commonFailures.map((item) => ({
            label:
              item.failureRate === null
                ? item.label
                : `${item.label} (${Math.round(item.failureRate * 100)}%)`,
            value: item.failures,
          }))}
          empty="No check has failed yet."
        />
      </Card>
    </>
  );
}

/* ------------------------------------------------------------ management */

export async function ManagementWidgets() {
  const view = await getManagementWidgets();

  return (
    <>
      <Card
        title="The whole book"
        description="Every case you are authorised to see. The same figures as the management reports, because they are the same query."
        actions={
          <AppLink
            href="/reports/management"
            className="text-xs font-medium text-signal-dark hover:underline"
          >
            Full report
          </AppLink>
        }
      >
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure label="Open" value={view.openCases} href="/cases" />
          <Figure
            label="Closed"
            value={view.closedCases}
            href="/cases?openness=closed"
          />
          <Figure
            label="Overdue"
            value={view.overdueCaseCount}
            tone={view.overdueCaseCount > 0 ? "danger" : "ok"}
          />
          <Figure
            label="High or critical"
            value={view.criticalCount + view.highRiskCount}
            tone={view.criticalCount > 0 ? "danger" : "warn"}
          />
        </dl>
      </Card>

      <Card title="Turnaround" description="How long a closed case took.">
        <dl className="grid grid-cols-3 gap-3">
          <Figure label="Closed" value={view.turnaround.closedCases} />
          <Figure
            label="Median days"
            value={view.turnaround.medianDays ?? "n/a"}
            note={view.turnaround.medianDays === null ? "nothing closed yet" : undefined}
          />
          <Figure label="Longest" value={view.turnaround.longestDays ?? "n/a"} />
        </dl>
      </Card>

      <Card
        title="QA return rate"
        description="Reviews that sent a report back rather than approving it."
      >
        <dl className="grid grid-cols-3 gap-3">
          <Figure label="Reviews" value={view.qaReturnRate.reviewsCompleted} />
          <Figure label="Returned" value={view.qaReturnRate.returned} />
          <Figure
            label="Rate"
            value={
              view.qaReturnRate.rate === null
                ? "n/a"
                : `${Math.round(view.qaReturnRate.rate * 100)}%`
            }
            tone={
              view.qaReturnRate.rate !== null && view.qaReturnRate.rate > 0.3
                ? "warn"
                : undefined
            }
          />
        </dl>
      </Card>

      <Card title="Where the work is" description="Open cases by lifecycle stage.">
        <Bars
          rows={view.byStage.map(([label, value]) => ({ label, value }))}
          empty="No open cases."
        />
      </Card>

      <Card title="By risk" description="Open cases by assessed risk.">
        <Bars
          rows={view.byRisk.map(([label, value]) => ({ label, value }))}
          empty="No open cases."
        />
      </Card>

      <Card title="By client" description="The six biggest, by open caseload.">
        <Bars
          rows={view.byClient.map(([label, value]) => ({ label, value }))}
          empty="No open cases."
        />
      </Card>

      <Card
        title="Awaiting approval"
        description="Reports at the final gate."
        actions={<FileText className="size-4 text-muted" aria-hidden="true" />}
      >
        <Queue
          items={view.reportsAwaitingApproval.map((report) => ({
            href: `/reports/${report.id}`,
            title: `${report.reportId}: ${report.title}`,
            meta: `${report.caseReference} - ${report.authorName ?? "unknown author"}`,
          }))}
          empty="Nothing is waiting for approval."
        />
      </Card>

      <Card
        title="Bottlenecks"
        description="People carrying overdue work, which is where a case stops moving."
        actions={<Hourglass className="size-4 text-warn" aria-hidden="true" />}
      >
        <Bars
          rows={view.workload.map((row) => ({
            label: `${row.name} (${row.openCases} cases)`,
            value: row.overdueTasks,
          }))}
          empty="Nobody is carrying overdue work."
        />
      </Card>

      {view.criticalCases.length > 0 && (
        <Card
          title="Critical cases"
          description="PRD 5.3: a critical case needs its risk approved before anybody is put on it."
          actions={
            <AlertTriangle className="size-4 text-danger" aria-hidden="true" />
          }
        >
          <Queue
            items={view.criticalCases.map((record) => ({
              href: `/cases/${record.id}`,
              title: `${record.caseId}: ${record.title}`,
              meta: `${record.clientName} - ${record.stageName}`,
            }))}
            empty="None."
          />
        </Card>
      )}
    </>
  );
}

/* --------------------------------------------------------------- finance */

export async function FinanceWidgets() {
  const view = await getFinanceWidgets();

  const money = (amount: number) =>
    `${view.currency} ${amount.toLocaleString(undefined, {
      maximumFractionDigits: 0,
    })}`;

  return (
    <>
      <Card
        title="Billing"
        description="What has been billed against what it has cost. No investigative content: PRD 16 keeps Finance out of it."
        actions={
          <CircleDollarSign className="size-4 text-muted" aria-hidden="true" />
        }
      >
        <dl className="grid grid-cols-3 gap-3">
          <Figure label="Billed" value={money(view.totals.billed)} />
          <Figure label="Cost" value={money(view.totals.cost)} />
          <Figure
            label="Margin"
            value={money(view.totals.margin)}
            tone={view.totals.margin < 0 ? "danger" : "ok"}
          />
        </dl>
      </Card>

      <Card
        title="Cases to ask about"
        description="Thinnest margin first. A negative one has cost more than it has billed."
        actions={<ClipboardList className="size-4 text-muted" aria-hidden="true" />}
      >
        {view.underwater > 0 && (
          <p className="mb-3 text-[11px] font-medium text-danger">
            {view.underwater} {view.underwater === 1 ? "case has" : "cases have"}{" "}
            cost more than
            {view.underwater === 1 ? " it has" : " they have"} billed.
          </p>
        )}
        <Queue
          items={view.cases.map((row) => ({
            href: `/cases/${row.caseId}`,
            title: `${row.caseReference}: ${row.title}`,
            meta: `billed ${money(row.billed)} - cost ${money(row.cost)} - margin ${money(row.margin)}`,
          }))}
          empty="No case has a financial record yet."
        />
      </Card>
    </>
  );
}

/* ------------------------------------------------------------- quick links */

export function QuickLinks({
  items,
}: {
  items: Array<{ href: string; label: string; body: string }>;
}) {
  if (items.length === 0) return null;

  return (
    <Card title="Go to" description="The screens you use most.">
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.href}>
            <AppLink
              href={item.href}
              className="group flex items-start gap-3 rounded-lg border border-line p-3 transition-colors hover:border-signal/40 hover:bg-surface-sunken"
            >
              <CalendarClock
                className="mt-0.5 size-4 shrink-0 text-signal"
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-body">
                  {item.label}
                </span>
                <Muted>{item.body}</Muted>
              </span>
            </AppLink>
          </li>
        ))}
      </ul>
    </Card>
  );
}

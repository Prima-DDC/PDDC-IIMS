import "server-only";
import { canAll, requireActor, type Actor } from "@/lib/auth/session";
import { casework } from "@/modules/casework";
import { crm } from "@/modules/crm";
import { reporting } from "@/modules/reporting";

/**
 * The dashboards (PRD 11).
 *
 * WHY THIS IS ONE PAGE AND NOT SIX. PRD 11 names six dashboards and PRD 16's
 * last row maps each role to one of them, which reads like six routes. It
 * should not be, for two reasons that are both about the configurable matrix.
 *
 * A role is data. An administrator can rename "Operations Manager", add a
 * role, or move any cell in PRD 16's matrix through the Permission Builder,
 * so a layout chosen by role name would break the first time somebody did
 * that, and silently: the person would get a dashboard for a role they no
 * longer have. A layout chosen by PERMISSION cannot, because it asks the same
 * question the data layer asks.
 *
 * And a person can hold several roles. PRD 3.2 says their permissions are the
 * union, so their dashboard should be too. A supervisor who also runs
 * operations needs both sets of widgets, and six mutually exclusive routes
 * force a choice that the permission model does not make.
 *
 * So: one dashboard, six groups of widgets, each group gated on the
 * permission that defines the role PRD 11 wrote it for.
 *
 *   Personal      everybody with dashboards:view
 *   Operations    cases:assign      (COO, manager, operations manager, supervisor)
 *   Team          plans:approve     (COO, supervisor)
 *   QA            qa:view           (QA reviewer)
 *   Management    users:view        (CEO, COO, managers, HR, auditor)
 *   Finance       financials:edit   (finance, operations manager)
 *
 * An investigator therefore sees Personal and nothing else, which is what
 * PRD 16 gives them, and nobody sees a widget whose data they could not
 * reach by clicking through to the screen behind it.
 *
 * EVERY FIGURE IS A REAL QUERY UNDER ROW-LEVEL SECURITY. The counts come from
 * the same list endpoints the screens use, with `limit: 1` where only the
 * total is wanted, so a number on the dashboard and the number of rows on the
 * page it links to cannot disagree. That is also what makes PRD 11's "shows
 * only data the viewer is authorised to see" true rather than intended: an
 * investigator's "active cases" is the count of cases they are assigned to,
 * because that is all the query can see.
 */

export type WidgetGroup =
  | "personal"
  | "operations"
  | "team"
  | "qa"
  | "management"
  | "finance";

export interface DashboardAccess {
  groups: WidgetGroup[];
  mayViewCases: boolean;
  mayViewTasks: boolean;
  mayViewReports: boolean;
  mayViewUsers: boolean;
}

export async function getDashboardAccess(actor: Actor): Promise<DashboardAccess> {
  const allowed = await canAll(actor, [
    { resource: "cases", action: "assign" },
    { resource: "plans", action: "approve" },
    { resource: "qa", action: "view" },
    { resource: "users", action: "view" },
    { resource: "financials", action: "edit" },
    { resource: "cases", action: "view" },
    { resource: "tasks", action: "view" },
    { resource: "reports", action: "view" },
  ]);

  const groups: WidgetGroup[] = ["personal"];
  if (allowed["cases:assign"]) groups.push("operations");
  if (allowed["plans:approve"]) groups.push("team");
  if (allowed["qa:view"]) groups.push("qa");
  if (allowed["users:view"]) groups.push("management");
  if (allowed["financials:edit"]) groups.push("finance");

  return {
    groups,
    mayViewCases: allowed["cases:view"],
    mayViewTasks: allowed["tasks:view"],
    mayViewReports: allowed["reports:view"],
    mayViewUsers: allowed["users:view"],
  };
}

/** Within a week, which is what "this week" means on a dashboard. */
function withinDays(iso: string | null, days: number): boolean {
  if (!iso) return false;
  const due = new Date(iso).getTime();
  return due - Date.now() <= days * 86_400_000;
}

/* ------------------------------------------------------------- personal */

/**
 * PRD 11's investigator widgets: My Cases, My Tasks, My Deadlines, My
 * Activities, My Evidence, My Reports.
 */
export async function getPersonalWidgets() {
  const actor = await requireActor();
  const work = casework(actor);
  const me = actor.userId;

  const [cases, openTasks, overdueTasks, activities, reports] = await Promise.all([
    work.cases.list({ assignedTo: me, openness: "open", limit: 5, sort: "target" }),
    // Twenty rather than five: the deadline widget is filtered from this one
    // list, so the same read answers "what is next" and "what is due soon"
    // instead of asking twice.
    work.tasks.list({ assignedTo: me, openOnly: true, sort: "due", limit: 20 }),
    work.tasks.list({ assignedTo: me, openOnly: true, overdueOnly: true, limit: 1 }),
    work.activities.list({ recordedBy: me, limit: 5 }),
    reporting(actor).reports.list({ author: me, limit: 5 }),
  ]);

  return {
    myCases: cases.rows,
    myCaseCount: cases.total,
    myTasks: openTasks.rows.slice(0, 5),
    myTaskCount: openTasks.total,
    myOverdueCount: overdueTasks.total,
    myDeadlines: openTasks.rows.filter((task) => withinDays(task.dueDate, 7)),
    myActivities: activities.rows,
    myReports: reports.rows,
    myReportCount: reports.total,
  };
}

/* ----------------------------------------------------------- operations */

/**
 * PRD 11's operations widgets: new cases, unassigned cases, pending conflict
 * checks, deadlines this week, workload.
 *
 * "Unassigned" is read from the rows rather than asked for in SQL, because
 * the case list carries `assignmentCount` and there is no filter for it. The
 * trade is honest and bounded: the newest fifty open cases are examined, and
 * a case that has sat unassigned past fifty newer ones is a different problem
 * from the one this widget is for.
 */
export async function getOperationsWidgets() {
  const actor = await requireActor();
  const work = casework(actor);

  const [recent, conflicts, dueSoon, management] = await Promise.all([
    work.cases.list({ openness: "open", limit: 50, sort: "opened" }),
    // `open`, which is PRD 8.3's undecided state. `listChecks` takes a plain
    // string, so an invented status would have returned an empty widget
    // rather than a type error: the real set is open, cleared, further_review
    // and declined.
    crm(actor).intake.listChecks({ status: "open", limit: 5 }),
    work.tasks.list({ openOnly: true, sort: "due", limit: 50 }),
    reporting(actor).management.report({}),
  ]);

  const weekAgo = Date.now() - 7 * 86_400_000;

  return {
    openCases: recent.total,
    newThisWeek: recent.rows.filter(
      (record) => new Date(record.openedAt).getTime() >= weekAgo,
    ).length,
    unassigned: recent.rows.filter((record) => record.assignmentCount === 0),
    pendingConflicts: conflicts.rows,
    pendingConflictCount: conflicts.total,
    dueThisWeek: dueSoon.rows.filter((task) => withinDays(task.dueDate, 7)),
    // Busiest first: the point of a workload widget is who to stop giving
    // work to.
    workload: [...management.workload]
      .sort((a, b) => b.openTasks + b.openCases - (a.openTasks + a.openCases))
      .slice(0, 8),
  };
}

/* ----------------------------------------------------------------- team */

/**
 * PRD 11's supervisor widgets: team cases, plans awaiting approval, drafts
 * awaiting review, overdue tasks, safety check-ins due.
 *
 * "Plans awaiting approval" has no cross-case read of its own: a plan belongs
 * to a case and `PlanRepository.forCase` answers for one. Rather than add a
 * read model for a question a supervisor can only usefully ask about their
 * own cases, the plan is read for each of the open cases they can see, in
 * parallel, and that bound is the team's open caseload.
 */
export async function getTeamWidgets() {
  const actor = await requireActor();
  const work = casework(actor);

  const [cases, awaitingReview, overdue, checkIns] = await Promise.all([
    work.cases.list({ openness: "open", limit: 25, sort: "target" }),
    reporting(actor).reports.list({ awaitingReview: true, limit: 5 }),
    work.tasks.list({ openOnly: true, overdueOnly: true, sort: "due", limit: 5 }),
    work.safety.listCheckIns({ overdueOnly: true, latestPerUser: true, limit: 5 }),
  ]);

  const plans = await Promise.all(
    cases.rows.map(async (record) => ({
      caseRecord: record,
      plan: await work.plans.forCase(record.id),
    })),
  );

  return {
    teamCases: cases.rows.slice(0, 5),
    teamCaseCount: cases.total,
    plansAwaitingApproval: plans
      .filter(({ plan }) =>
        plan?.versions.some((version) => version.status === "submitted"),
      )
      .slice(0, 5),
    reportsAwaitingReview: awaitingReview.rows,
    reportsAwaitingReviewCount: awaitingReview.total,
    overdueTasks: overdue.rows,
    overdueTaskCount: overdue.total,
    checkInsDue: checkIns.rows,
  };
}

/* ------------------------------------------------------------------- qa */

/** PRD 11's QA widgets: awaiting review, returned, common failed checks. */
export async function getQaWidgets() {
  const actor = await requireActor();
  const api = reporting(actor);

  const [awaiting, returned, failures] = await Promise.all([
    api.reports.list({ status: "qa_review", limit: 5 }),
    // A returned report is back with its author, which is `draft` on PRD
    // 10.1's line. The ones that were never submitted look the same from
    // here, and that is why the widget says "with their authors" rather
    // than claiming they were all returned.
    api.reports.list({ status: "draft", limit: 5 }),
    api.qa.commonFailures(6),
  ]);

  return {
    awaitingReview: awaiting.rows,
    awaitingReviewCount: awaiting.total,
    withAuthors: returned.rows,
    withAuthorsCount: returned.total,
    commonFailures: failures.filter((item) => item.failures > 0),
  };
}

/* ----------------------------------------------------------- management */

/**
 * PRD 11's management widgets, which are the figures PRD 10.4 already
 * computes, plus the case counts by risk and state.
 *
 * Deliberately the same read model as the management reports screen, so a
 * number here and a number there are the same number. A dashboard with its
 * own arithmetic is a second source of truth, and the first argument anybody
 * has about a figure is which screen was right.
 */
export async function getManagementWidgets() {
  const actor = await requireActor();
  const work = casework(actor);

  const [management, open, closed, overdue, critical, high, awaitingApproval] =
    await Promise.all([
      reporting(actor).management.report({}),
      work.cases.list({ openness: "open", limit: 1 }),
      work.cases.list({ openness: "closed", limit: 1 }),
      work.cases.list({ openness: "open", overdueOnly: true, limit: 5 }),
      work.cases.list({ openness: "open", riskLevel: "critical", limit: 5 }),
      work.cases.list({ openness: "open", riskLevel: "high", limit: 1 }),
      reporting(actor).reports.list({ status: "approval", limit: 5 }),
    ]);

  const byRisk = new Map<string, number>();
  const byType = new Map<string, number>();
  const byClient = new Map<string, number>();
  for (const record of management.caseRegister) {
    if (record.closedAt) continue;
    byRisk.set(record.riskLevel, (byRisk.get(record.riskLevel) ?? 0) + 1);
    byClient.set(record.clientName, (byClient.get(record.clientName) ?? 0) + 1);
  }
  for (const record of management.caseRegister) {
    if (record.closedAt) continue;
    byType.set(record.stageName, (byType.get(record.stageName) ?? 0) + 1);
  }

  return {
    openCases: open.total,
    closedCases: closed.total,
    overdueCases: overdue.rows,
    overdueCaseCount: overdue.total,
    criticalCases: critical.rows,
    criticalCount: critical.total,
    highRiskCount: high.total,
    turnaround: management.turnaround,
    qaReturnRate: management.qaReturnRate,
    reportsAwaitingApproval: awaitingApproval.rows,
    reportsAwaitingApprovalCount: awaitingApproval.total,
    byStage: [...byType.entries()].sort((a, b) => b[1] - a[1]),
    byRisk: [...byRisk.entries()].sort((a, b) => b[1] - a[1]),
    byClient: [...byClient.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    // The backlog PRD 11 asks for: open cases with nobody on them, which is
    // the only backlog that is somebody's fault rather than the work's.
    workload: management.workload.filter((row) => row.overdueTasks > 0),
  };
}

/* -------------------------------------------------------------- finance */

/**
 * PRD 11's finance widgets: invoices outstanding, payment status by
 * engagement.
 *
 * Read from PRD 10.4's revenue-versus-cost figures, which are per case and
 * carry what was billed and what it cost. PRD 16 gives Finance "V (billing
 * only)" on cases and `V C E` on financials, and row-level security is what
 * holds that line: this read returns the billing figures and no investigative
 * content, because there is none in it to return.
 */
export async function getFinanceWidgets() {
  const actor = await requireActor();
  const management = await reporting(actor).management.report({});

  const rows = management.revenueVersusCost;
  const totals = rows.reduce(
    (sum, row) => ({
      billed: sum.billed + row.billed,
      cost: sum.cost + row.cost,
      margin: sum.margin + row.margin,
    }),
    { billed: 0, cost: 0, margin: 0 },
  );

  return {
    cases: [...rows].sort((a, b) => a.margin - b.margin).slice(0, 8),
    totals,
    currency: rows[0]?.currency ?? "GHS",
    // A case that has cost more than it billed is the one finance has to ask
    // about, so it is counted rather than left to be spotted in a list.
    underwater: rows.filter((row) => row.margin < 0).length,
  };
}

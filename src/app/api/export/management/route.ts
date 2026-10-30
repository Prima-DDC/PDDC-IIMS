import { NextResponse } from "next/server";
import { can, requireActor } from "@/lib/auth/session";
import { RATE_LIMITS, takeRateLimit } from "@/lib/rate-limit";
import { getManagementReport } from "@/features/reporting/queries";

/**
 * The management reports as CSV (PRD 10.4: "All exportable to CSV/PDF with
 * permission checks applied").
 *
 * The permission check is the point of that sentence, so it is the first
 * thing here and it is the same check the screen makes. The export is built
 * from the same read model as the screen, which is what stops the two
 * disagreeing: an export that showed more than the screen would be a quiet
 * way around row-level security.
 *
 * One file with six sections rather than six files. A manager opening this in
 * a spreadsheet wants the figures together, and a zip of six CSVs is a worse
 * version of that.
 */

/** A CSV field, quoted when it has to be. */
function field(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rows(lines: Array<Array<unknown>>): string {
  return lines.map((line) => line.map(field).join(",")).join("\r\n");
}

export async function GET() {
  const actor = await requireActor();
  if (!(await can(actor, "reports", "export"))) {
    return NextResponse.json(
      { error: "You do not have permission to export management reports." },
      { status: 403 },
    );
  }

  /*
   * Limited per person, after the permission check (PRD 14).
   *
   * Each call is a full read of the case register, and PRD 14 lists mass
   * downloads among the things to watch for. Twenty an hour is far more than
   * anybody does by hand, so reaching it is either a script or a mistake, and
   * either is worth stopping. Per actor rather than per address: an office
   * shares an address and should not share a limit.
   */
  const limit = await takeRateLimit(
    `export:management:${actor.userId}`,
    RATE_LIMITS.export.limit,
    RATE_LIMITS.export.windowSeconds,
  );

  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `That is ${limit.hits} exports within the hour. Wait ${Math.ceil(
          limit.retryAfterSeconds / 60,
        )} minutes, or read the figures on the screen, which are the same ones.`,
      },
      {
        status: 429,
        headers: { "retry-after": String(limit.retryAfterSeconds) },
      },
    );
  }

  const report = await getManagementReport({});

  const sections: string[] = [
    "# Case register",
    rows([
      ["Case", "Title", "Client", "Stage", "Risk", "Lead", "Opened", "Closed", "Days open"],
      ...report.caseRegister.map((row) => [
        row.caseReference,
        row.title,
        row.clientName,
        row.stageName,
        row.riskLevel,
        row.leadInvestigatorName,
        row.openedAt.slice(0, 10),
        row.closedAt?.slice(0, 10) ?? "",
        row.daysOpen,
      ]),
    ]),
    "",
    "# Turnaround",
    rows([
      ["Cases closed", "Median days", "Longest days"],
      [
        report.turnaround.closedCases,
        report.turnaround.medianDays ?? "",
        report.turnaround.longestDays ?? "",
      ],
    ]),
    "",
    "# Workload",
    rows([
      ["Who", "Open cases", "Open tasks", "Overdue tasks"],
      ...report.workload.map((row) => [
        row.name,
        row.openCases,
        row.openTasks,
        row.overdueTasks,
      ]),
    ]),
    "",
    "# Overdue tasks",
    rows([
      ["Task", "Title", "Case", "Assigned to", "Due", "Days late"],
      ...report.overdueTasks.map((row) => [
        row.taskReference,
        row.title,
        row.caseReference,
        row.assigneeName,
        row.dueAt.slice(0, 10),
        row.daysOverdue,
      ]),
    ]),
    "",
    "# QA return rate",
    rows([
      ["Reviews completed", "Returned", "Rate"],
      [
        report.qaReturnRate.reviewsCompleted,
        report.qaReturnRate.returned,
        // Empty rather than 0 when nothing has been reviewed: a spreadsheet
        // that read 0% would be stating something untrue.
        report.qaReturnRate.rate === null
          ? ""
          : `${Math.round(report.qaReturnRate.rate * 100)}%`,
      ],
    ]),
    "",
    "# Revenue against cost",
    rows([
      ["Case", "Title", "Currency", "Billed", "Cost", "Margin"],
      ...report.revenueVersusCost.map((row) => [
        row.caseReference,
        row.title,
        row.currency,
        row.billed,
        row.cost,
        row.margin,
      ]),
    ]),
  ];

  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(sections.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="pddc-management-${stamp}.csv"`,
      // An export of case data is never cached by anything in between.
      "cache-control": "no-store, no-cache, must-revalidate, private",
    },
  });
}

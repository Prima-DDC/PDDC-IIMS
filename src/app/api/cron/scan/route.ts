import { NextResponse } from "next/server";
import { authoriseCron } from "@/lib/cron";
import { runScheduledScans } from "@/modules/notify";

/**
 * The scheduled scans (PRD 5.8, 12.1).
 *
 * Overdue tasks, approaching deadlines and missed safety check-ins. Runs
 * every fifteen minutes: the first two are about days, so a quarter of an
 * hour is more than precise enough, and the third is the one that decides the
 * interval. PRD 5.8 asks for an immediate alert on a missed check-in, and
 * fifteen minutes is the honest reading of "immediate" for something found by
 * looking rather than by anybody reporting it. A minute-level scan would
 * mostly find nothing, and the thing it is watching for is measured in hours.
 *
 * Each scan is keyed, so running this twice by hand, or a schedule firing
 * twice, tells nobody twice.
 */
export async function POST(request: Request) {
  const refusal = authoriseCron(request);
  if (refusal) return refusal;

  const started = Date.now();

  try {
    const result = await runScheduledScans();
    const told =
      result.overdueTasks + result.approachingDeadlines + result.missedCheckIns;

    // A missed check-in is worth a line whatever else happened, because it is
    // the one thing here that might mean somebody is in trouble.
    if (result.missedCheckIns > 0) {
      console.warn(
        `[notify] ${result.missedCheckIns} people told about a missed safety check-in`,
      );
    } else if (told > 0) {
      console.log(
        `[notify] scans told ${told}: ${result.overdueTasks} overdue, ` +
          `${result.approachingDeadlines} approaching, ${Date.now() - started}ms`,
      );
    }

    return NextResponse.json({ ...result, ms: Date.now() - started });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[notify] the scheduled scans failed to run", error);

    return NextResponse.json({ error: reason }, { status: 500 });
  }
}

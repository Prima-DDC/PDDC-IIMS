import "server-only";
import { canAll, hasScope, requireActor } from "@/lib/auth/session";
import { casework } from "@/modules/casework";
import { staffDirectory } from "@/lib/reference";

/** Read models for the finance and time panels (PRD 5.6, 5.7). */

/**
 * Everything the case page's finance section needs.
 *
 * The money and the timesheet are read separately on purpose. PRD 5.6 limits
 * the fee to Finance, the Operations Manager and the CEO, while PRD 5.7 gives
 * everybody their own time, so an investigator sees their hours on a case
 * whose fee they cannot see. Row-level security enforces that; this returns
 * the permissions so the screen does not render a panel it would then have to
 * leave empty.
 */
export async function getCaseFinance(caseRecordId: string) {
  const actor = await requireActor();

  const api = casework(actor);

  const allowed = await canAll(actor, [
    { resource: "financials", action: "view" },
    { resource: "financials", action: "create" },
    { resource: "financials", action: "edit" },
    { resource: "time", action: "view" },
    { resource: "time", action: "create" },
    { resource: "time", action: "edit" },
    { resource: "cases", action: "view" },
  ]);

  const [financials, time, expenses, costs, tasks, directory, managesTime] =
    await Promise.all([
      allowed["financials:view"]
        ? api.finance.forCase(caseRecordId)
        : Promise.resolve(null),
      api.finance.listTime({ caseId: caseRecordId, limit: 200 }),
      api.finance.listExpenses({
        caseId: caseRecordId,
        status: "all",
        limit: 100,
      }),
      api.finance.costSummary(caseRecordId),
      api.tasks.list({ caseId: caseRecordId, openOnly: true, limit: 200 }),
      staffDirectory(actor),
      // `time:edit` is held by everybody at `own` scope, so the permission
      // alone cannot decide whether somebody supervises a timesheet. The
      // scope can, and the row-level policy keys on the same thing.
      hasScope(actor, "time", "edit", "team"),
    ]);

  return {
    financials,
    timeEntries: time.rows,
    expenses: expenses.rows,
    costs,
    tasks: tasks.rows.map((t) => ({
      id: t.id,
      label: `${t.taskId} ${t.title}`,
    })),
    people: directory,
    actorId: actor.userId,
    can: {
      viewMoney: allowed["financials:view"],
      createMoney: allowed["financials:create"],
      editMoney: allowed["financials:edit"],
      viewTime: allowed["time:view"],
      logTime: allowed["time:create"],
      /**
       * Whether this actor supervises other people's time: the scope, not the
       * permission. Rendering the approve control from the permission alone
       * would offer everybody a button the action refuses, and would make a
       * timesheet of one person's hours read as the case total.
       */
      manageTime: managesTime,
    },
  };
}

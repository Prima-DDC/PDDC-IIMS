import { getCaseActivity, getCasePlan, getCaseTasks } from "./queries";
import {
  ActivityLogPanel,
  CaseTasksPanel,
  InvestigationPlanPanel,
} from "./TaskPanels";

/**
 * The plan, the work and the log, one per tab of the case file.
 *
 * Each is its own server component so the case page can stream it, and each
 * reads only what its own tab shows. PRD 18 gives screen 9 a tab for each,
 * which is also what keeps a case page from running a dozen queries to render
 * the one section somebody is looking at.
 */

export async function CasePlanTab({ caseRecordId }: { caseRecordId: string }) {
  const plan = await getCasePlan(caseRecordId);

  return (
    <InvestigationPlanPanel
      caseRecordId={caseRecordId}
      plan={plan.plan}
      isOwnSubmission={plan.isOwnPlanSubmission}
      canEdit={plan.can.editCase}
      canApprove={plan.can.approve}
    />
  );
}

export async function CaseTasksTab({ caseRecordId }: { caseRecordId: string }) {
  const work = await getCaseTasks(caseRecordId);

  return (
    <CaseTasksPanel
      caseRecordId={caseRecordId}
      tasks={work.tasks}
      summary={work.taskSummary}
      people={work.people}
      canCreate={work.can.createTask}
    />
  );
}

export async function CaseActivityTab({
  caseRecordId,
  caseClassification,
}: {
  caseRecordId: string;
  caseClassification: string;
}) {
  const log = await getCaseActivity(caseRecordId);

  return (
    <ActivityLogPanel
      caseRecordId={caseRecordId}
      caseClassification={caseClassification}
      activities={log.activities}
      tasks={log.tasks}
      levels={log.levels}
      canEdit={log.can.editCase}
    />
  );
}

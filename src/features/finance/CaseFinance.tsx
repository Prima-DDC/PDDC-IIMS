import { getCaseFinance } from "./queries";
import { ExpensesPanel, FinancialsPanel, TimePanel } from "./FinancePanels";

/**
 * The finance section of a case page (PRD 5.6, 5.7).
 *
 * The commercials panel is rendered only for somebody who may see the fee.
 * PRD 5.6 limits that to Finance, the Operations Manager and the CEO, and an
 * investigator on the case sees their own time and costs without it: an empty
 * panel titled "Commercials" would tell them a figure exists and that they
 * are not trusted with it, which is worse than not showing the panel.
 */
export async function CaseFinanceTab({ caseRecordId }: { caseRecordId: string }) {
  const finance = await getCaseFinance(caseRecordId);

  return (
    <>
      {finance.can.viewMoney && (
        <FinancialsPanel
          caseRecordId={caseRecordId}
          financials={finance.financials}
          costs={finance.costs}
          canCreate={finance.can.createMoney}
          canEdit={finance.can.editMoney}
        />
      )}

      {finance.can.viewTime && (
        <TimePanel
          caseRecordId={caseRecordId}
          entries={finance.timeEntries}
          costs={finance.costs}
          tasks={finance.tasks}
          people={finance.people}
          actorId={finance.actorId}
          canLog={finance.can.logTime}
          canManage={finance.can.manageTime}
          ownOnly={!finance.can.manageTime}
        />
      )}

      <ExpensesPanel
        caseRecordId={caseRecordId}
        expenses={finance.expenses}
        costs={finance.costs}
        actorId={finance.actorId}
        canDecide={finance.can.editMoney}
        ownOnly={!finance.can.viewMoney}
      />
    </>
  );
}

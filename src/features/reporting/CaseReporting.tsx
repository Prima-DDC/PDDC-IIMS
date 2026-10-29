import { Alert, Card, Muted, StatTile } from "@/components/ui";
import { getCaseClosure, getCaseReports } from "./queries";
import {
  ClosureDecisionForm,
  ClosureForm,
  ClosureGateNotice,
  Expandable,
  ReportForm,
} from "./ReportForms";
import { ClosureGate, ClosureSummary, ReportTable } from "./ReportViews";

/**
 * The reports and closure tabs of a case file (PRD 5.9, 10, screens 18, 20).
 *
 * Each is its own server component so the case page streams it, and each
 * reads only what it shows.
 */

export async function CaseReportsTab({
  caseRecordId,
  caseClassification,
}: {
  caseRecordId: string;
  caseClassification: string;
}) {
  const data = await getCaseReports(caseRecordId);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Reports" value={data.summary.total} />
        <StatTile
          label="In review"
          value={data.summary.inReview}
          tone={data.summary.inReview > 0 ? "warn" : "neutral"}
        />
        <StatTile label="Final" value={data.summary.final} tone="ok" />
        <StatTile label="Delivered" value={data.summary.delivered} tone="ok" />
      </div>

      <Expandable
        title="Reports"
        description="Each one goes through PRD 10.1's seven stages, and its author can never be the one who passes it on. A final version is locked, and a change from there is the next version."
        openLabel="Start a report"
        canOpen={data.can.create}
        summary={<ReportTable reports={data.reports} showCase={false} />}
      >
        <ReportForm
          caseRecordId={caseRecordId}
          people={data.people}
          levels={data.levels}
          defaultClassification={caseClassification}
          actorId={data.actorId}
        />
      </Expandable>
    </div>
  );
}

/**
 * The closure tab (PRD 5.9, screen 20).
 *
 * The gate comes first, because the only useful thing to know on this screen
 * is what is stopping the case from closing. Three of the nine requirements
 * are read from the records rather than attested to, and the gate says which.
 */
export async function CaseClosureTab({ caseRecordId }: { caseRecordId: string }) {
  const data = await getCaseClosure(caseRecordId);
  const { closure, gate } = data;

  const closed = closure?.status === "approved";

  return (
    <div className="space-y-5">
      {closed && (
        <Alert tone="ok" title="This case is closed and archived">
          Approved by {closure.approvedByName ?? "a supervisor"} and kept under{" "}
          {closure.retentionClassName ?? closure.retentionClass}. It stays
          searchable and readable; nothing more can be changed on it.
        </Alert>
      )}

      <Card
        title="What closure requires"
        description="PRD 5.9's nine requirements. The system blocks closure while any one is incomplete, and the three marked as read from the records cannot be attested to: they are answered from the case itself."
      >
        <ClosureGate items={gate.items} />
      </Card>

      {closure && (
        <Card
          title="The proposed closure"
          description="What was recorded, and what the next case gets from this one."
        >
          <div className="space-y-4">
            <ClosureSummary closure={closure} />
            {closure.status === "proposed" && (
              <div className="border-t border-line pt-4">
                <ClosureDecisionForm
                  caseRecordId={caseRecordId}
                  closure={closure}
                  isOwnProposal={data.isOwnProposal}
                  canClose={data.can.close}
                />
              </div>
            )}
          </div>
        </Card>
      )}

      {!closed && data.can.close && (
        <Expandable
          title={closure ? "Revise the closure" : "Propose closure"}
          description="One form, because closure is one decision: a case half closed across two screens is a case nobody can tell the state of."
          openLabel={closure ? "Revise it" : "Fill it in"}
          summary={<ClosureGateNotice items={gate.items} />}
        >
          <ClosureForm
            caseRecordId={caseRecordId}
            closure={closure}
            retentionClasses={data.retentionClasses}
          />
        </Expandable>
      )}

      {!closed && !data.can.close && !closure && (
        <Card title="Closure">
          <Muted>
            Closing a case is a supervisor&apos;s act, so there is nothing here
            for you to do. The requirements above are what it will be held to.
          </Muted>
        </Card>
      )}
    </div>
  );
}

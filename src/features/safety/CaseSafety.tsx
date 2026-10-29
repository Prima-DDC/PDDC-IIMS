import { getCaseSafety } from "./queries";
import { IncidentsPanel, SafetyPanel } from "./SafetyPanels";

/**
 * The safety section of a case page (PRD 5.8).
 *
 * Its own server component so the case page can stream it, for the reason the
 * work section is: the case header needs none of it, and holding the first
 * paint while check-in history comes back would be a slower page for nothing.
 */
export async function CaseSafetyTab({
  caseRecordId,
  caseClassification,
}: {
  caseRecordId: string;
  caseClassification: string;
}) {
  const safety = await getCaseSafety(caseRecordId);

  return (
    <>
      <SafetyPanel
        caseRecordId={caseRecordId}
        plan={safety.plan}
        whoIsOut={safety.whoIsOut}
        recentCheckIns={safety.recentCheckIns}
        summary={safety.summary}
        people={safety.people}
        actorId={safety.actorId}
        canEdit={safety.can.edit}
      />

      <IncidentsPanel
        caseRecordId={caseRecordId}
        incidents={safety.incidents}
        levels={safety.levels}
        people={safety.people}
        caseClassification={caseClassification}
        actorId={safety.actorId}
        canEdit={safety.can.edit}
      />
    </>
  );
}

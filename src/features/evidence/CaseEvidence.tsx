import { getCaseEvidence } from "./queries";
import { CaseEvidencePanel } from "./EvidenceForms";

/**
 * The evidence tab of a case file (PRD 6, screen 16).
 *
 * Its own server component so the case page can stream it, and it reads only
 * what the tab shows.
 */
export async function CaseEvidenceTab({
  caseRecordId,
  caseClassification,
}: {
  caseRecordId: string;
  caseClassification: string;
}) {
  const evidence = await getCaseEvidence(caseRecordId);

  return (
    <CaseEvidencePanel
      caseRecordId={caseRecordId}
      caseClassification={caseClassification}
      items={evidence.items}
      summary={evidence.summary}
      people={evidence.people}
      levels={evidence.levels}
      actorId={evidence.actorId}
      canCreate={evidence.can.create}
    />
  );
}

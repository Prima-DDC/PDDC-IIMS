import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { Link2 } from "lucide-react";
import {
  Alert,
  Card,
  DescriptionList,
  EmptyState,
  Id,
  Muted,
  NotSet,
  PageHeader,
} from "@/components/ui";
import { ClassificationBanner } from "@/components/ClassificationBanner";
import { can, requireActor } from "@/lib/auth/session";
import { getInformationDetail } from "@/features/intel/queries";
import {
  CorroborationForm,
  Expandable,
  InformationForm,
  LinkEvidenceForm,
  RemoveInformationForm,
} from "@/features/intel/IntelForms";
import {
  CredibilityBadge,
  ConfidenceBadge,
  ReliabilityBadge,
} from "@/features/intel/IntelViews";
import {
  INFORMATION_VERIFICATION_LABELS,
  SOURCE_TYPE_LABELS,
} from "@/modules/intel/shared";

export const metadata: Metadata = { title: "Information" };

export default async function InformationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "information", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const detail = await getInformationDetail(id);
  if (!detail) notFound();

  const { information } = detail;
  const borneOut =
    detail.corroborations.length + detail.linkedEvidence.length > 0;

  return (
    <div className="space-y-5">
      <ClassificationBanner
        level={information.classification}
        caseId={information.caseReference}
      />

      <PageHeader
        title={information.informationId}
        description={information.description}
        breadcrumb={[
          { label: "Information", href: "/information" },
          { label: information.informationId },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CredibilityBadge credibility={information.informationCredibility} />
            <ReliabilityBadge reliability={information.sourceReliability} />
            <ConfidenceBadge confidence={information.confidence} />
          </div>
        }
      />

      {!borneOut && (
        <Alert tone="warn" title="Nothing bears this out yet">
          One source said it and nothing else supports it. That is a perfectly
          ordinary state for new material, and it is why it cannot be recorded as
          confirmed: link a piece of evidence, or another source&apos;s account of
          the same thing.
        </Alert>
      )}

      {information.verificationStatus === "contradicted" && (
        <Alert tone="danger" title="This has been contradicted">
          Something on the case contradicts this statement. It cannot be recorded
          as confirmed, and any finding resting on it needs looking at again.
        </Alert>
      )}

      <Card title="The information">
        <DescriptionList
          items={[
            { label: "Identifier", value: <Id>{information.informationId}</Id> },
            {
              label: "Case",
              value: (
                <AppLink
                  href={`/cases/${information.caseId}?tab=sources`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{information.caseReference}</Id>
                </AppLink>
              ),
            },
            {
              label: "The source",
              value: (
                <AppLink
                  href={`/sources/${information.sourceId}`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{information.sourceReference}</Id>{" "}
                  {SOURCE_TYPE_LABELS[information.sourceType]}
                </AppLink>
              ),
            },
            {
              label: "Obtained",
              value: new Date(information.dateObtained).toLocaleDateString("en-GB"),
            },
            {
              label: "Verification",
              value:
                INFORMATION_VERIFICATION_LABELS[information.verificationStatus],
            },
            { label: "Analyst", value: information.analystName ?? <NotSet /> },
            {
              label: "About",
              value: information.entityId ? (
                <AppLink
                  href={`/entities/${information.entityId}`}
                  className="text-signal-dark hover:underline"
                >
                  {information.entityName}
                </AppLink>
              ) : (
                <Muted>nobody in particular</Muted>
              ),
            },
            {
              label: "Findings resting on it",
              value:
                detail.citedByFindings === 0 ? (
                  <Muted>none</Muted>
                ) : (
                  `${detail.citedByFindings}`
                ),
            },
          ]}
        />
      </Card>

      <Expandable
        title="What bears it out"
        description="Corroboration has to come from a different source: two statements from the same source are one source saying something twice."
        openLabel="Record corroboration"
        canOpen={detail.can.editInformation}
        summary={
          detail.corroborations.length === 0 ? (
            <EmptyState
              title="Nothing from another source yet"
              description='Until something does, this cannot be recorded as "confirmed".'
            />
          ) : (
            <ul className="space-y-2">
              {detail.corroborations.map((link) => (
                <li key={link.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <AppLink
                      href={`/information/${link.corroboratingInformationId}`}
                      className="font-medium text-signal-dark hover:underline"
                    >
                      {link.corroboratingReference}
                    </AppLink>
                    <Id>{link.corroboratingSourceReference}</Id>
                    <ReliabilityBadge
                      reliability={link.corroboratingSourceReliability}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-muted">
                    {link.corroboratingDescription.slice(0, 160)}
                  </p>
                  {link.note && (
                    <p className="mt-1 text-[11px] text-faint">{link.note}</p>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      >
        <CorroborationForm
          caseRecordId={information.caseId}
          information={information}
          candidates={detail.corroborationCandidates.map((candidate) => ({
            id: candidate.id,
            label: `${candidate.informationId} (${candidate.sourceReference}) ${candidate.description.slice(0, 60)}`,
          }))}
        />
      </Expandable>

      <Expandable
        title="The evidence for it"
        description="An exhibit that bears this statement out. It then appears on the traceability of any finding resting on it."
        openLabel="Link evidence"
        canOpen={detail.can.editInformation}
        summary={
          detail.linkedEvidence.length === 0 ? (
            <Muted>No evidence linked.</Muted>
          ) : (
            <ul className="space-y-2">
              {detail.linkedEvidence.map((link) => (
                <li key={link.id} className="rounded-lg border border-line p-3">
                  <AppLink
                    href={`/evidence/${link.evidenceItemId}`}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-signal-dark hover:underline"
                  >
                    <Link2 className="size-3" aria-hidden="true" />
                    <Id>{link.evidenceReference}</Id>
                    {link.evidenceDescription.slice(0, 80)}
                  </AppLink>
                  {link.note && (
                    <p className="mt-1 text-[11px] text-muted">{link.note}</p>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      >
        <LinkEvidenceForm
          caseRecordId={information.caseId}
          information={information}
          candidates={detail.evidenceCandidates.map((item) => ({
            id: item.id,
            label: `${item.evidenceId} ${item.description.slice(0, 70)}`,
          }))}
        />
      </Expandable>

      {detail.can.editInformation && information.deletedAt === null && (
        <Card
          title="Details"
          description='Marking something "confirmed" is a claim about corroboration, so the option appears only once something bears it out.'
        >
          <InformationForm
            caseRecordId={information.caseId}
            information={information}
            sources={[]}
            subjects={
              information.entityId
                ? [
                    {
                      id: information.entityId,
                      label: information.entityName ?? "the subject",
                    },
                  ]
                : []
            }
            levels={detail.levels}
            defaultClassification={information.classification}
          />
        </Card>
      )}

      {detail.can.removeInformation && information.deletedAt === null && (
        <Card
          title="Remove this"
          description="Only possible while no finding rests on it. Removing something a conclusion depends on would leave the conclusion resting on nothing."
        >
          <RemoveInformationForm
            caseRecordId={information.caseId}
            information={information}
          />
        </Card>
      )}
    </div>
  );
}

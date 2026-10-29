import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { Unlink } from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import {
  Card,
  DescriptionList,
  Id,
  Muted,
  PageHeader,
} from "@/components/ui";
import { ClassificationBanner } from "@/components/ClassificationBanner";
import { can, requireActor } from "@/lib/auth/session";
import { getFindingDetail } from "@/features/intel/queries";
import { unlinkFinding } from "@/features/intel/actions";
import {
  Expandable,
  FindingForm,
  FindingStatusForm,
  LinkFindingForm,
  RemoveFindingForm,
} from "@/features/intel/IntelForms";
import {
  ConfidenceBadge,
  FindingStatusBadge,
  TraceabilityStrip,
} from "@/features/intel/IntelViews";
import { FINDING_LINK_TYPE_LABELS } from "@/modules/intel/shared";

export const metadata: Metadata = { title: "Finding" };

export default async function FindingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "findings", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const detail = await getFindingDetail(id);
  if (!detail) notFound();

  const { finding } = detail;

  return (
    <div className="space-y-5">
      <ClassificationBanner
        level={finding.classification}
        caseId={finding.caseReference}
      />

      <PageHeader
        title={finding.findingId}
        description={finding.statement}
        breadcrumb={[
          { label: "Findings", href: "/findings" },
          { label: finding.findingId },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <FindingStatusBadge status={finding.status} />
            <ConfidenceBadge confidence={finding.confidence} />
          </div>
        }
      />

      {/* The strip first, because what a finding rests on is the first thing a
          reader of a conclusion needs (PRD 23). */}
      <Card
        title="What it rests on"
        description="Source, then information, then evidence. Every hop is a link, because a trail you cannot follow is decoration."
      >
        {detail.trace ? (
          <TraceabilityStrip trace={detail.trace} />
        ) : (
          <Muted>Nothing linked yet.</Muted>
        )}
      </Card>

      <Card title="The finding">
        <DescriptionList
          items={[
            { label: "Identifier", value: <Id>{finding.findingId}</Id> },
            {
              label: "Case",
              value: (
                <AppLink
                  href={`/cases/${finding.caseId}?tab=findings`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{finding.caseReference}</Id>
                </AppLink>
              ),
            },
            { label: "Analyst", value: finding.analystName ?? "unknown" },
            {
              label: "Date",
              value: new Date(finding.findingDate).toLocaleDateString("en-GB"),
            },
            {
              label: "Reviewer",
              value: finding.reviewerName ?? <Muted>not yet reviewed</Muted>,
            },
            {
              label: "Confidence it can carry",
              value: `${detail.ceiling} (${detail.support.information.length} statements, ${detail.support.evidenceCount} exhibits)`,
            },
            {
              label: "Citable in a report",
              value:
                finding.status === "accepted" ? (
                  "Yes"
                ) : (
                  <Muted>not until it is accepted</Muted>
                ),
            },
          ]}
        />
        {finding.detail && (
          <p className="mt-4 border-t border-line pt-4 text-xs whitespace-pre-line text-muted">
            {finding.detail}
          </p>
        )}
        {finding.reviewNotes && (
          <p className="mt-3 rounded-lg border border-line bg-surface-sunken p-3 text-xs text-body">
            {finding.reviewerName ?? "The reviewer"}: {finding.reviewNotes}
          </p>
        )}
      </Card>

      <Card
        title="Where it stands"
        description="A finding goes out for review, comes back or is accepted. An accepted one is not edited back into a draft: it is withdrawn and replaced, so a report that cites it still reads true."
      >
        <FindingStatusForm
          caseRecordId={finding.caseId}
          finding={finding}
          isOwnFinding={detail.isOwnFinding}
          canApprove={detail.can.approve}
          canEdit={detail.can.edit}
        />
      </Card>

      <Expandable
        title="Links"
        description="The information and evidence this conclusion is built on. A finding cannot be put forward for review with none."
        openLabel="Link something"
        canOpen={detail.can.edit}
        summary={
          finding.links.length === 0 ? (
            <Muted>
              Nothing linked. Link the information or the evidence it rests on
              before putting it forward.
            </Muted>
          ) : (
            <ul className="space-y-2">
              {finding.links.map((link) => (
                <li key={link.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                      {FINDING_LINK_TYPE_LABELS[link.linkType]}
                    </span>
                    <Id>{link.targetReference}</Id>
                    <span className="min-w-0 flex-1 truncate text-body">
                      {link.targetLabel}
                    </span>
                    {detail.can.edit && (
                      <ActionForm
                        action={unlinkFinding}
                        submitLabel={
                          <>
                            <Unlink className="size-3.5" aria-hidden="true" />
                            Unlink
                          </>
                        }
                        submitTone="ghost"
                        submitSize="sm"
                        hidden={{
                          caseRecordId: finding.caseId,
                          findingRecordId: finding.id,
                          linkId: link.id,
                        }}
                        confirm="Unlink this? The finding then rests on one thing fewer."
                        compact
                      />
                    )}
                  </div>
                  {link.relevance && (
                    <p className="mt-1 text-[11px] text-muted">{link.relevance}</p>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      >
        <LinkFindingForm
            caseRecordId={finding.caseId}
            finding={finding}
            informationCandidates={detail.informationCandidates.map((row) => ({
              id: row.id,
              label: `${row.informationId} (${row.informationCredibility}) ${row.description.slice(0, 60)}`,
            }))}
            evidenceCandidates={detail.evidenceCandidates.map((row) => ({
              id: row.id,
            label: `${row.evidenceId} ${row.description.slice(0, 60)}`,
          }))}
        />
      </Expandable>

      {detail.can.edit && finding.deletedAt === null && (
        <Card
          title="Details"
          description="The confidence offered is capped by what the finding rests on: a conclusion is no better supported than the least of its support."
        >
          <FindingForm
            caseRecordId={finding.caseId}
            finding={finding}
            people={detail.people}
            levels={detail.levels}
            defaultClassification={finding.classification}
            actorId={detail.actorId}
            ceiling={detail.ceiling}
          />
        </Card>
      )}

      {detail.can.remove && finding.deletedAt === null && (
        <Card
          title="Remove this finding"
          description="Withdrawing it is usually the better record: a finding that was reached and then abandoned is part of what the investigation did."
        >
          <RemoveFindingForm caseRecordId={finding.caseId} finding={finding} />
        </Card>
      )}
    </div>
  );
}

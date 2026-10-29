import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import {
  Alert,
  Card,
  DescriptionList,
  Id,
  Muted,
  NotSet,
  PageHeader,
} from "@/components/ui";
import { ClassificationBanner } from "@/components/ClassificationBanner";
import { can, requireActor } from "@/lib/auth/session";
import { getEvidenceDetail } from "@/features/evidence/queries";
import {
  CustodyPanel,
  EvidenceDetailPanels,
} from "@/features/evidence/EvidenceDetail";
import {
  CopyStatusBadge,
  EvidenceStatusBadge,
  IntegritySeal,
} from "@/features/evidence/EvidenceViews";
import { EVIDENCE_TYPE_LABELS } from "@/modules/evidence/shared";

export const metadata: Metadata = { title: "Evidence item" };

export default async function EvidenceItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "evidence", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const detail = await getEvidenceDetail(id);
  // 404 rather than 403, as a case does it: whether an item exists on a case
  // this person cannot reach is not theirs to learn.
  if (!detail) notFound();

  const { item } = detail;

  return (
    <div className="space-y-5">
      <ClassificationBanner level={item.classification} caseId={item.caseReference} />

      <PageHeader
        title={item.evidenceId}
        description={item.description}
        breadcrumb={[
          { label: "Evidence", href: "/evidence" },
          { label: item.evidenceId },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <IntegritySeal
              status={item.integrityStatus}
              verifiedAt={item.verifiedAt}
            />
            <CopyStatusBadge item={item} />
            <EvidenceStatusBadge item={item} />
          </div>
        }
      />

      {item.integrityStatus === "mismatch" && (
        <Alert tone="danger" title="This item failed its integrity check">
          The stored file does not match the hash recorded when the item was
          collected. It cannot be cited in a report until that is resolved, and
          the mismatch is permanently recorded below.
        </Alert>
      )}

      <Card title="The item">
        <DescriptionList
          items={[
            { label: "Evidence ID", value: <Id>{item.evidenceId}</Id> },
            {
              label: "Case",
              value: (
                <AppLink
                  href={`/cases/${item.caseId}?tab=evidence`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{item.caseReference}</Id>
                </AppLink>
              ),
            },
            { label: "Type", value: EVIDENCE_TYPE_LABELS[item.evidenceType] },
            {
              label: "Exhibit number",
              value: item.exhibitNo ?? <Muted>not allocated</Muted>,
            },
            {
              label: "Collected",
              value: `${new Date(item.collectedAt).toLocaleString("en-GB")}${
                item.collectedByName ? ` by ${item.collectedByName}` : ""
              }`,
            },
            { label: "Where", value: item.collectionLocation },
            { label: "How", value: item.collectionMethod },
            {
              label: "Held by",
              value: item.currentCustodianName ?? <Muted>nobody</Muted>,
            },
            {
              label: "Original",
              value:
                item.copyStatus === "working_copy" && item.originalEvidenceId ? (
                  <AppLink
                    href={`/evidence/${item.originalEvidenceId}`}
                    className="text-signal-dark hover:underline"
                  >
                    <Id>{item.originalEvidenceReference ?? "the original"}</Id>
                  </AppLink>
                ) : (
                  <Muted>this is the original</Muted>
                ),
            },
            {
              label: "Working copies",
              value:
                item.workingCopyCount === 0 ? (
                  <Muted>none taken</Muted>
                ) : (
                  `${item.workingCopyCount} taken`
                ),
            },
            {
              label: "File",
              value: item.fileName ? (
                <>
                  {item.fileName}
                  <span className="ml-1 text-[11px] text-faint">
                    {item.fileType}
                    {item.fileSize !== null
                      ? `, ${Math.ceil(item.fileSize / 1024)} KB`
                      : ""}
                  </span>
                </>
              ) : (
                <NotSet />
              ),
            },
            {
              label: "Declared hash",
              value: item.declaredSha256 ? (
                <span className="font-mono text-[10px]">{item.declaredSha256}</span>
              ) : (
                <NotSet />
              ),
            },
            {
              label: "Server hash",
              value: item.computedSha256 ? (
                <span className="font-mono text-[10px]">{item.computedSha256}</span>
              ) : (
                <Muted>not verified yet</Muted>
              ),
            },
          ]}
        />
      </Card>

      <CustodyPanel
        caseRecordId={item.caseId}
        item={item}
        events={detail.events}
        chain={detail.chain}
        people={detail.people}
        canRecord={detail.can.recordCustody}
      />

      <EvidenceDetailPanels
        caseRecordId={item.caseId}
        item={item}
        checks={detail.checks}
        workingCopies={detail.workingCopies}
        people={detail.people}
        levels={detail.levels}
        actorId={detail.actorId}
        can={detail.can}
      />
    </div>
  );
}

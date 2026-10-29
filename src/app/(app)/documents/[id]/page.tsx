import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { Alert, Card, DescriptionList, Id, Muted, PageHeader } from "@/components/ui";
import { ClassificationBanner } from "@/components/ClassificationBanner";
import { can, requireActor } from "@/lib/auth/session";
import { getDocumentDetail } from "@/features/documents/queries";
import {
  DocumentDetailsPanel,
  VersionsPanel,
} from "@/features/documents/DocumentDetail";
import {
  ApproveVersionControl,
  DocumentRemovalPanel,
} from "@/features/documents/DocumentForms";
import {
  DocumentStatusBadge,
  VersionHistory,
} from "@/features/documents/DocumentViews";
import { DOCUMENT_TYPE_LABELS } from "@/modules/evidence/shared";

export const metadata: Metadata = { title: "Document" };

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "documents", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const detail = await getDocumentDetail(id);
  // 404 rather than 403, as evidence and cases do it: whether a document
  // exists on a case this person cannot reach is not theirs to learn.
  if (!detail) notFound();

  const { document } = detail;
  const approved = detail.versions.find(
    (version) => version.id === document.approvedVersionId,
  );

  return (
    <div className="space-y-5">
      <ClassificationBanner
        level={document.classification}
        caseId={document.caseReference}
      />

      <PageHeader
        title={document.title}
        description={DOCUMENT_TYPE_LABELS[document.documentType]}
        breadcrumb={[
          { label: "Documents", href: "/documents" },
          { label: document.documentId },
        ]}
        actions={<DocumentStatusBadge document={document} />}
      />

      {document.approvedVersionId !== null &&
        document.approvedVersionId !== document.currentVersionId && (
          <Alert tone="info" title="The approved version is not the latest one">
            {approved?.versionLabel ?? "The approved version"} is what a report
            should cite. {document.current?.versionLabel ?? "The latest version"} is
            a draft and is waiting on somebody other than whoever filed it.
          </Alert>
        )}

      <Card title="The document">
        <DescriptionList
          items={[
            { label: "Document ID", value: <Id>{document.documentId}</Id> },
            {
              label: "Case",
              value: (
                <AppLink
                  href={`/cases/${document.caseId}?tab=documents`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{document.caseReference}</Id>
                </AppLink>
              ),
            },
            { label: "Folder", value: document.folderName ?? <Muted>unfiled</Muted> },
            {
              label: "In force",
              value: approved ? (
                `${approved.versionLabel}, approved ${
                  approved.approvedAt
                    ? new Date(approved.approvedAt).toLocaleDateString("en-GB")
                    : ""
                }${approved.approvedByName ? ` by ${approved.approvedByName}` : ""}`
              ) : (
                <Muted>no version approved yet</Muted>
              ),
            },
            {
              label: "Latest",
              value: document.current
                ? `${document.current.versionLabel}, ${document.current.fileName}`
                : "none",
            },
            {
              label: "Versions",
              value: `${document.versionCount}`,
            },
            {
              label: "Filed",
              value: `${new Date(document.createdAt).toLocaleString("en-GB")}${
                document.createdByName ? ` by ${document.createdByName}` : ""
              }`,
            },
            {
              label: "Related evidence",
              value: document.relatedEvidenceId ? (
                <AppLink
                  href={`/evidence/${document.relatedEvidenceId}`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{document.relatedEvidenceReference ?? "the item"}</Id>
                </AppLink>
              ) : (
                <Muted>none</Muted>
              ),
            },
            {
              label: "Related task",
              value: document.relatedTaskId ? (
                <AppLink
                  href={`/tasks/${document.relatedTaskId}`}
                  className="text-signal-dark hover:underline"
                >
                  {document.relatedTaskTitle ?? "the task"}
                </AppLink>
              ) : (
                <Muted>none</Muted>
              ),
            },
            {
              label: "Tags",
              value:
                document.tags.length > 0 ? (
                  document.tags.join(", ")
                ) : (
                  <Muted>none</Muted>
                ),
            },
          ]}
        />
      </Card>

      <VersionsPanel
        caseRecordId={document.caseId}
        document={document}
        canAddVersion={detail.can.upload}
      >
        <VersionHistory versions={detail.versions}>
          {(version) => (
            <ApproveVersionControl
              caseRecordId={document.caseId}
              document={document}
              version={version}
              actorId={detail.actorId}
              canApprove={detail.can.edit}
            />
          )}
        </VersionHistory>
      </VersionsPanel>

      <DocumentDetailsPanel
        caseRecordId={document.caseId}
        document={document}
        folders={detail.folders}
        levels={detail.levels}
        canEdit={detail.can.edit}
      />

      <DocumentRemovalPanel
        caseRecordId={document.caseId}
        document={document}
        canRemove={detail.can.remove}
      />
    </div>
  );
}

import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { can, canAll, requireActor } from "@/lib/auth/session";
import { CLASSIFICATION_LABELS } from "@/modules/iam";
import { casework } from "@/modules/casework";
import { evidence } from "@/modules/evidence";
import { intel } from "@/modules/intel";
import { crm } from "@/modules/crm";
import { listUsers } from "@/features/admin-users/queries";
import { RestoreUserButton } from "@/features/admin-users/RestoreUserButton";
import {
  RemovedRecords,
  type RemovedRow,
} from "@/features/admin-users/RemovedRecords";
import {
  RestoreCaseButton,
  RestoreClientButton,
  RestoreEngagementButton,
} from "@/features/clients/RestoreButtons";
import { TaskRestoreForm } from "@/features/tasks/TaskForms";
import { EvidenceRestoreForm } from "@/features/evidence/RestoreForms";
import { DocumentRestoreForm } from "@/features/documents/RestoreForms";
import {
  EntityRestoreForm,
  FindingRestoreForm,
  InformationRestoreForm,
  SourceRestoreForm,
} from "@/features/intel/RestoreForms";

export const metadata: Metadata = { title: "Recycle bin" };

/**
 * Soft-deleted records (PRD 3.5, screen 29).
 *
 * "Delete is a soft-delete by default: records move to a recycle bin where an
 *  administrator can restore them within the retention period before
 *  permanent purge."
 *
 * Screen 29 names "users, roles, cases, documents, evidence and other
 * records", and every soft-deletable type in the platform appears here,
 * because a recycle bin that covers only some of them is worse than none:
 * somebody looking for a removed client would conclude it had been erased.
 *
 * Two kinds of record are deliberately absent, for different reasons.
 * Enquiries have no `deleted_at` at all, since intake history is retained
 * permanently (PRD 4.1). A case subject taken off a case is not here either:
 * looking at somebody and ruling them out is part of what the investigation
 * did, so it stays on the case with its reason.
 *
 * Permanent purge is deliberately not offered here. It needs a second
 * administrator's approval and is blocked under a legal hold, so it belongs
 * with the approval queue rather than behind a button on a list.
 */
export default async function RecycleBinPage() {
  const actor = await requireActor();
  if (!(await can(actor, "users", "view"))) {
    forbidden();
  }

  // Seeing a soft-deleted row needs the DELETE permission, not view: that is
  // what migrations 0032 and 0033 established, so a record nobody may remove
  // is not listed to them as "nothing was removed". Restoring needs edit,
  // which is what the restore actions check.
  const allowed = await canAll(actor, [
    { resource: "users", action: "edit" },
    { resource: "clients", action: "delete" },
    { resource: "clients", action: "edit" },
    { resource: "engagements", action: "delete" },
    { resource: "engagements", action: "edit" },
    { resource: "cases", action: "delete" },
    { resource: "cases", action: "edit" },
    { resource: "tasks", action: "delete" },
    { resource: "evidence", action: "delete" },
    { resource: "documents", action: "delete" },
    { resource: "entities", action: "delete" },
    { resource: "sources", action: "delete" },
    { resource: "information", action: "delete" },
    { resource: "findings", action: "delete" },
  ]);

  const empty = { rows: [], total: 0 };
  const api = crm(actor);
  const caseApi = casework(actor);
  const evidenceApi = evidence(actor);
  const intelApi = intel(actor);

  const [
    users,
    clients,
    engagements,
    cases,
    tasks,
    evidenceItems,
    documents,
    entities,
    sources,
    information,
    findings,
  ] = await Promise.all([
    listUsers({ onlyDeleted: true, perPage: 100 }),
    allowed["clients:delete"]
      ? api.clients.list({ onlyDeleted: true, limit: 100 })
      : Promise.resolve(empty),
    allowed["engagements:delete"]
      ? api.engagements.list({ onlyDeleted: true, limit: 100 })
      : Promise.resolve(empty),
    allowed["cases:delete"]
      ? caseApi.cases.list({ onlyDeleted: true, openness: "all", limit: 100 })
      : Promise.resolve(empty),
    // A removed task is revealed by tasks:delete, which is what both the
    // policy (migration 0032) and the removal action key on. PRD 16 grants it
    // to no role, so in practice this is the Administrator.
    allowed["tasks:delete"]
      ? caseApi.tasks.list({ onlyDeleted: true, limit: 100 })
      : Promise.resolve(empty),
    // Removing an item never touches its file or its custody ledger, so a
    // restored item comes back with its whole history intact.
    allowed["evidence:delete"]
      ? evidenceApi.items.list({ onlyDeleted: true, limit: 100 })
      : Promise.resolve(empty),
    allowed["documents:delete"]
      ? evidenceApi.documents.list({ onlyDeleted: true, limit: 100 })
      : Promise.resolve(empty),
    allowed["entities:delete"]
      ? intelApi.entities.list({ onlyDeleted: true, limit: 100 })
      : Promise.resolve(empty),
    allowed["sources:delete"]
      ? intelApi.sources.list({ onlyDeleted: true, limit: 100 })
      : Promise.resolve(empty),
    allowed["information:delete"]
      ? intelApi.information.list({ onlyDeleted: true, limit: 100 })
      : Promise.resolve(empty),
    allowed["findings:delete"]
      ? intelApi.findings.list({ onlyDeleted: true, limit: 100 })
      : Promise.resolve(empty),
  ]);

  const sections: Array<{
    show: boolean;
    props: Parameters<typeof RemovedRecords>[0];
  }> = [
    {
      show: true,
      props: {
        title: "Removed users",
        description:
          "Restoring brings the account back deactivated, so access has to be granted again deliberately.",
        emptyTitle: "No removed users",
        emptyDescription: "No user records have been removed.",
        nameHeading: "Name",
        referenceHeading: "Email",
        contextHeading: "Clearance",
        rows: users.rows.map(
          (user): RemovedRow => ({
            id: user.id,
            title: user.fullName ?? "Name not set",
            reference: user.email,
            context: CLASSIFICATION_LABELS[user.clearance],
            deletedAt: user.deletedAt,
            restore: allowed["users:edit"] ? (
              <RestoreUserButton
                userId={user.id}
                name={user.fullName ?? user.email}
              />
            ) : undefined,
          }),
        ),
      },
    },
    {
      show: allowed["clients:delete"],
      props: {
        title: "Removed clients",
        description:
          "A client with engagements or cases cannot be removed at all, so anything here had none.",
        emptyTitle: "No removed clients",
        emptyDescription: "No client records have been removed.",
        nameHeading: "Client",
        rows: clients.rows.map(
          (client): RemovedRow => ({
            id: client.id,
            title: client.organisationName,
            reference: client.clientId,
            href: `/clients/${client.id}`,
            deletedAt: client.deletedAt,
            restore: allowed["clients:edit"] ? (
              <RestoreClientButton
                id={client.id}
                name={client.organisationName}
              />
            ) : undefined,
          }),
        ),
      },
    },
    {
      show: allowed["engagements:delete"],
      props: {
        title: "Removed engagements",
        description:
          "Only a draft engagement can be removed. Once approved it is closed instead, which keeps the commercial record.",
        emptyTitle: "No removed engagements",
        emptyDescription: "No engagement records have been removed.",
        nameHeading: "Engagement",
        contextHeading: "Client",
        rows: engagements.rows.map(
          (engagement): RemovedRow => ({
            id: engagement.id,
            title: engagement.title,
            reference: engagement.engagementId,
            context: engagement.clientName,
            href: `/engagements/${engagement.id}`,
            deletedAt: engagement.deletedAt,
            restore: allowed["engagements:edit"] ? (
              <RestoreEngagementButton
                id={engagement.id}
                name={engagement.title}
              />
            ) : undefined,
          }),
        ),
      },
    },
    {
      show: allowed["cases:delete"],
      props: {
        title: "Removed cases",
        description:
          "Only a case that has not passed assignment can be removed at all. Once the work has started it is taken to closure instead, which keeps it readable.",
        emptyTitle: "No removed cases",
        emptyDescription: "No case records have been removed.",
        nameHeading: "Case",
        contextHeading: "Client",
        rows: cases.rows.map(
          (record): RemovedRow => ({
            id: record.id,
            title: record.title,
            reference: record.caseId,
            context: record.clientName,
            href: `/cases/${record.id}`,
            deletedAt: record.deletedAt,
            restore: allowed["cases:edit"] ? (
              <RestoreCaseButton id={record.id} name={record.title} />
            ) : undefined,
          }),
        ),
      },
    },
    {
      show: allowed["tasks:delete"],
      props: {
        title: "Removed tasks",
        description:
          "Work removed from a case. Cancelling a task keeps it and its reason on the case, which is usually the better record.",
        emptyTitle: "No removed tasks",
        emptyDescription: "No tasks have been removed.",
        nameHeading: "Task",
        contextHeading: "Case",
        rows: tasks.rows.map(
          (task): RemovedRow => ({
            id: task.id,
            title: task.title,
            reference: task.taskId,
            context: task.caseReference,
            href: `/tasks/${task.id}`,
            deletedAt: task.deletedAt,
            restore: <TaskRestoreForm task={task} />,
          }),
        ),
      },
    },
    {
      show: allowed["evidence:delete"],
      props: {
        title: "Removed evidence",
        description:
          "The item's file and its chain of custody are untouched by removal: what is removed is the register entry, and restoring brings it back with its whole history.",
        emptyTitle: "No removed evidence",
        emptyDescription: "No evidence items have been removed.",
        nameHeading: "Item",
        contextHeading: "Case",
        rows: evidenceItems.rows.map(
          (item): RemovedRow => ({
            id: item.id,
            title:
              item.description.length > 70
                ? `${item.description.slice(0, 70)}...`
                : item.description,
            reference: item.evidenceId,
            context: item.caseReference,
            href: `/evidence/${item.id}`,
            deletedAt: item.deletedAt,
            restore: <EvidenceRestoreForm item={item} />,
          }),
        ),
      },
    },
    {
      show: allowed["documents:delete"],
      props: {
        title: "Removed documents",
        description:
          "Every version and every stored file stays exactly as it was, including the approvals, so a report that cites one still reads true.",
        emptyTitle: "No removed documents",
        emptyDescription: "No documents have been removed.",
        nameHeading: "Document",
        contextHeading: "Case",
        rows: documents.rows.map(
          (document): RemovedRow => ({
            id: document.id,
            title: document.title,
            reference: document.documentId,
            context: document.caseReference,
            href: `/documents/${document.id}`,
            deletedAt: document.deletedAt,
            restore: <DocumentRestoreForm document={document} />,
          }),
        ),
      },
    },
    {
      show: allowed["entities:delete"],
      props: {
        title: "Removed subjects",
        description:
          "Only a subject on no case can be removed. Its aliases and relationships are untouched, and restoring brings them all back.",
        emptyTitle: "No removed subjects",
        emptyDescription: "No entity records have been removed.",
        nameHeading: "Subject",
        contextHeading: "Type",
        rows: entities.rows.map(
          (entity): RemovedRow => ({
            id: entity.id,
            title: entity.name,
            reference: entity.entityId,
            context: entity.entityType.replace(/_/g, " "),
            href: `/entities/${entity.id}`,
            deletedAt: entity.deletedAt,
            restore: (
              <EntityRestoreForm
                entityRecordId={entity.id}
                reference={entity.entityId}
              />
            ),
          }),
        ),
      },
    },
    {
      show: allowed["sources:delete"],
      props: {
        title: "Removed sources",
        description:
          "Only a source nothing is attributed to can be removed. Removing a cited one would leave its information attributed to nothing.",
        emptyTitle: "No removed sources",
        emptyDescription: "No sources have been removed.",
        nameHeading: "Source",
        contextHeading: "Case",
        rows: sources.rows.map(
          (source): RemovedRow => ({
            id: source.id,
            title:
              source.description.length > 70
                ? `${source.description.slice(0, 70)}...`
                : source.description,
            reference: source.sourceId,
            context: source.caseReference,
            href: `/sources/${source.id}`,
            deletedAt: source.deletedAt,
            restore: (
              <SourceRestoreForm
                caseRecordId={source.caseId}
                sourceRecordId={source.id}
                reference={source.sourceId}
              />
            ),
          }),
        ),
      },
    },
    {
      show: allowed["information:delete"],
      props: {
        title: "Removed information",
        description:
          "Only a statement no finding rests on can be removed, so no conclusion is left resting on something that is no longer there.",
        emptyTitle: "No removed information",
        emptyDescription: "No information has been removed.",
        nameHeading: "Statement",
        contextHeading: "Case",
        rows: information.rows.map(
          (piece): RemovedRow => ({
            id: piece.id,
            title:
              piece.description.length > 70
                ? `${piece.description.slice(0, 70)}...`
                : piece.description,
            reference: piece.informationId,
            context: piece.caseReference,
            href: `/information/${piece.id}`,
            deletedAt: piece.deletedAt,
            restore: (
              <InformationRestoreForm
                caseRecordId={piece.caseId}
                informationRecordId={piece.id}
                reference={piece.informationId}
              />
            ),
          }),
        ),
      },
    },
    {
      show: allowed["findings:delete"],
      props: {
        title: "Removed findings",
        description:
          "Withdrawing a finding is usually the better record: one that was reached and then abandoned is part of what the investigation did.",
        emptyTitle: "No removed findings",
        emptyDescription: "No findings have been removed.",
        nameHeading: "Finding",
        contextHeading: "Case",
        rows: findings.rows.map(
          (finding): RemovedRow => ({
            id: finding.id,
            title:
              finding.statement.length > 70
                ? `${finding.statement.slice(0, 70)}...`
                : finding.statement,
            reference: finding.findingId,
            context: finding.caseReference,
            href: `/findings/${finding.id}`,
            deletedAt: finding.deletedAt,
            restore: (
              <FindingRestoreForm
                caseRecordId={finding.caseId}
                findingRecordId={finding.id}
                reference={finding.findingId}
              />
            ),
          }),
        ),
      },
    },
  ];

  const shown = sections.filter((section) => section.show);
  const nothingRemoved = shown.every(
    (section) => section.props.rows.length === 0,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Recycle bin"
        description="Records removed but recoverable. Nothing here has been erased."
        breadcrumb={[
          { label: "Administration", href: "/admin" },
          { label: "Recycle bin" },
        ]}
      />

      <Alert tone="info" title="What is never deleted">
        Audit entries and chain-of-custody events are append-only for every
        role, so a removed user still appears in the history of everything they
        did. That is what keeps the trail credible if a report is challenged.
        Enquiries are never removable at all: intake history is kept
        permanently, so a declined enquiry stays readable with its reason. A
        merged subject is not here either: a merge is reversed rather than
        undone, from the record it was merged into.
      </Alert>

      {nothingRemoved && (
        <EmptyState
          title="The recycle bin is empty"
          description="No records have been removed."
        />
      )}

      {shown.map((section) => (
        <RemovedRecords key={section.props.title} {...section.props} />
      ))}
    </div>
  );
}

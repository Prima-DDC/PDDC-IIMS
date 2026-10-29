import { AppLink } from "@/components/AppLink";
import { CheckCircle2, FileText, FolderOpen, Lock, PenLine } from "lucide-react";
import {
  Badge,
  EmptyState,
  Id,
  Muted,
  Table,
  Td,
  Th,
} from "@/components/ui";
import {
  DOCUMENT_TYPE_LABELS,
  type CaseDocument,
  type CaseFolder,
  type DocumentVersion,
} from "@/modules/evidence/shared";

/**
 * Reading case documents (PRD 7).
 *
 * Server components: nothing here holds state. The one thing worth getting
 * right is that a reader can always tell which version is in force and which
 * is merely the latest, because PRD 7.2 locks the approved one and a report
 * may cite it years later.
 */

function when(value: string) {
  return new Date(value).toLocaleString("en-GB");
}

function sizeOf(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

/**
 * Where a document stands.
 *
 * Three states rather than two: a document whose approved version is not its
 * latest one is a real and common situation, and reading it as simply
 * "approved" would be wrong.
 */
export function DocumentStatusBadge({ document }: { document: CaseDocument }) {
  if (document.approvedVersionId === null) {
    return (
      <Badge tone="warn">
        <PenLine className="size-3" aria-hidden="true" />
        Draft, awaiting approval
      </Badge>
    );
  }

  if (document.approvedVersionId === document.currentVersionId) {
    return (
      <Badge tone="ok">
        <CheckCircle2 className="size-3" aria-hidden="true" />
        {document.current?.versionLabel ?? "Approved"} approved
      </Badge>
    );
  }

  return (
    <Badge tone="info">
      Newer draft {document.current?.versionLabel ?? ""} awaiting approval
    </Badge>
  );
}

export function DocumentTable({
  documents,
  showCase = true,
}: {
  documents: CaseDocument[];
  showCase?: boolean;
}) {
  if (documents.length === 0) {
    return (
      <EmptyState
        title="No documents match those filters"
        description="Clear the filters, or file what has come in."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Document</Th>
          {showCase && <Th>Case</Th>}
          <Th>Type</Th>
          <Th>Status</Th>
          <Th>Folder</Th>
          <Th className="text-right">Updated</Th>
        </tr>
      </thead>
      <tbody>
        {documents.map((document) => (
          <tr
            key={document.id}
            className="transition-colors hover:bg-surface-sunken/60"
          >
            <Td>
              <AppLink
                href={`/documents/${document.id}`}
                className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
              >
                {document.title}
              </AppLink>
              <span className="flex flex-wrap items-center gap-1.5">
                <Id>{document.documentId}</Id>
                {document.current && (
                  <span className="max-w-48 truncate text-[11px] text-faint">
                    {document.current.fileName}
                  </span>
                )}
              </span>
            </Td>
            {showCase && (
              <Td className="text-xs">
                <AppLink
                  href={`/cases/${document.caseId}`}
                  className="text-signal-dark hover:underline"
                >
                  {document.caseReference}
                </AppLink>
              </Td>
            )}
            <Td className="text-xs text-muted">
              {DOCUMENT_TYPE_LABELS[document.documentType]}
            </Td>
            <Td>
              <DocumentStatusBadge document={document} />
            </Td>
            <Td className="text-xs text-muted">
              {document.folderName ?? <Muted>unfiled</Muted>}
            </Td>
            <Td className="text-right text-xs whitespace-nowrap text-muted">
              {new Date(document.updatedAt).toLocaleDateString("en-GB")}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * The version history.
 *
 * Newest first, because the question a reader almost always has is "what is
 * in force now". An approved version carries a lock: PRD 7.2 is explicit that
 * it cannot be edited, and a change from there is the next version with a
 * recorded reason.
 */
export function VersionHistory({
  versions,
  children,
}: {
  versions: DocumentVersion[];
  /** The approval control for a version, rendered per row by the caller. */
  children?: (version: DocumentVersion) => React.ReactNode;
}) {
  if (versions.length === 0) {
    return (
      <EmptyState
        title="No versions"
        description="Every document is filed with its first version, so this should not be empty."
      />
    );
  }

  return (
    <ol className="space-y-2">
      {versions.map((version) => (
        <li
          key={version.id}
          className={`rounded-lg border p-3 ${
            version.isCurrent ? "border-signal/40 bg-signal/5" : "border-line"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-body">
              {version.versionLabel}
            </span>
            {version.isCurrent && <Badge tone="info">Current</Badge>}
            {version.isApproved ? (
              <Badge tone="ok">
                <Lock className="size-3" aria-hidden="true" />
                Approved and locked
              </Badge>
            ) : (
              <Badge tone="warn">Draft</Badge>
            )}
            <span className="ml-auto text-[11px] whitespace-nowrap text-muted">
              {when(version.createdAt)}
              {version.createdByName ? ` by ${version.createdByName}` : ""}
            </span>
          </div>

          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-body">
            <FileText className="size-3.5 text-faint" aria-hidden="true" />
            {version.fileName}
            <Muted>
              {version.mimeType}, {sizeOf(version.fileSize)}
            </Muted>
          </p>

          {version.changeNote && (
            <p className="mt-1 text-[11px] text-muted">
              What changed: {version.changeNote}
            </p>
          )}

          {version.isApproved && (
            <p className="mt-1 text-[11px] text-ok">
              Approved {version.approvedAt ? when(version.approvedAt) : ""}
              {version.approvedByName ? ` by ${version.approvedByName}` : ""}.
            </p>
          )}

          <p className="mt-1 font-mono text-[10px] break-all text-faint">
            {version.sha256}
          </p>

          {children?.(version)}
        </li>
      ))}
    </ol>
  );
}

/**
 * The folder tree for a case.
 *
 * Created from a template when the case is opened (PRD 7.1), so the structure
 * is the same on every case and a reader knows where to look rather than
 * guessing what somebody named a folder.
 */
export function FolderList({
  folders,
  caseRecordId,
  activeFolderId,
}: {
  folders: CaseFolder[];
  caseRecordId: string;
  activeFolderId?: string;
}) {
  if (folders.length === 0) {
    return <Muted>No folders on this case.</Muted>;
  }

  return (
    <ul className="flex flex-wrap gap-2">
      <li>
        <AppLink
          href={`/cases/${caseRecordId}?tab=documents`}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
            activeFolderId === undefined
              ? "border-signal/50 bg-signal/10 text-body"
              : "border-line text-muted hover:border-line-strong hover:text-body"
          }`}
        >
          All
        </AppLink>
      </li>
      {folders.map((folder) => (
        <li key={folder.id}>
          <AppLink
            href={`/cases/${caseRecordId}?tab=documents&folder=${folder.id}`}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
              activeFolderId === folder.id
                ? "border-signal/50 bg-signal/10 text-body"
                : "border-line text-muted hover:border-line-strong hover:text-body"
            }`}
          >
            <FolderOpen className="size-3.5" aria-hidden="true" />
            {folder.name}
            <span className="tabular-nums text-faint">{folder.documentCount}</span>
          </AppLink>
        </li>
      ))}
    </ul>
  );
}

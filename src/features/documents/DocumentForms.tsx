"use client";

import { useState } from "react";
import { Lock, Plus, Trash2, Upload, X } from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import {
  FileUpload,
  type UploadFieldNames,
  type UploadResult,
} from "@/components/FileUpload";
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Muted,
  Select,
  Textarea,
} from "@/components/ui";
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  nextVersionLabel,
  type CaseDocument,
  type CaseFolder,
  type DocumentVersion,
} from "@/modules/evidence/shared";
import {
  addDocumentVersion,
  approveDocumentVersion,
  createDocument,
  removeDocument,
  restoreDocument,
  updateDocument,
} from "./actions";

/** The forms that write case documents (PRD 7). */

type Level = { code: string; name: string };

/** What the document actions expect the uploader to post. */
const DOCUMENT_FIELDS: UploadFieldNames = {
  fileName: "fileName",
  fileType: "mimeType",
  fileSize: "fileSize",
  sha256: "sha256",
  storagePath: "storagePath",
};

/** The fields that describe a document, shared by filing and editing. */
function DocumentFields({
  document,
  folders,
  levels,
  defaultClassification,
  fieldErrors,
}: {
  document?: CaseDocument;
  folders: CaseFolder[];
  levels: Level[];
  defaultClassification: string;
  fieldErrors?: Record<string, string | undefined>;
}) {
  return (
    <>
      <div className="sm:col-span-2">
        <Field
          label="Title"
          htmlFor="doc-title"
          required
          hint="What a reader looking for this in two years would search for."
          error={fieldErrors?.title}
        >
          <Input
            id="doc-title"
            name="title"
            defaultValue={document?.title ?? ""}
            placeholder="Bank statement bundle, January to June"
          />
        </Field>
      </div>

      <Field
        label="Kind of document"
        htmlFor="doc-type"
        required
        error={fieldErrors?.documentType}
      >
        <Select
          id="doc-type"
          name="documentType"
          defaultValue={document?.documentType ?? "other"}
        >
          {DOCUMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {DOCUMENT_TYPE_LABELS[type]}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Folder"
        htmlFor="doc-folder"
        hint="The case's folders come from the template it was opened with."
        error={fieldErrors?.folderId}
      >
        <Select
          id="doc-folder"
          name="folderId"
          defaultValue={document?.folderId ?? ""}
        >
          <option value="">Unfiled</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Classification"
        htmlFor="doc-classification"
        required
        hint="Decides who can open it at all. It cannot exceed your own clearance."
        error={fieldErrors?.classification}
      >
        <Select
          id="doc-classification"
          name="classification"
          defaultValue={document?.classification ?? defaultClassification}
        >
          {levels.map((level) => (
            <option key={level.code} value={level.code}>
              {level.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Tags"
        htmlFor="doc-tags"
        hint="Comma separated. Used to find a document across cases."
        error={fieldErrors?.tags}
      >
        <Input
          id="doc-tags"
          name="tag"
          defaultValue={document?.tags.join(", ") ?? ""}
          placeholder="banking, kyc"
        />
      </Field>
    </>
  );
}

/**
 * Filing a document, which is the document and its first version together.
 *
 * The file is uploaded first and the form is only offered once it is stored,
 * because a document row with no version is a title with no file: nothing can
 * be read from it and no report can cite it.
 */
export function NewDocumentForm({
  caseRecordId,
  folders,
  levels,
  defaultClassification,
}: {
  caseRecordId: string;
  folders: CaseFolder[];
  levels: Level[];
  defaultClassification: string;
}) {
  const [uploaded, setUploaded] = useState<UploadResult | null>(null);

  return (
    <div className="space-y-3">
      <FileUpload
        bucket="documents"
        pathPrefix={`${caseRecordId}/filed`}
        names={DOCUMENT_FIELDS}
        hint="Hashed in your browser before it is sent, and the hash is recorded with the version."
        onUploaded={setUploaded}
      />

      {!uploaded ? (
        <Muted>Choose the file first, then describe what it is.</Muted>
      ) : (
        <ActionForm
          action={createDocument}
          submitLabel="File the document"
          submitSize="sm"
          hidden={{
            caseRecordId,
            fileName: uploaded.fileName,
            mimeType: uploaded.fileType,
            fileSize: uploaded.fileSize,
            sha256: uploaded.declaredSha256,
            storagePath: uploaded.storagePath,
          }}
        >
          {(state) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <DocumentFields
                folders={folders}
                levels={levels}
                defaultClassification={defaultClassification}
                fieldErrors={state.fieldErrors}
              />
              <div className="sm:col-span-2">
                <Field
                  label="What this version is"
                  htmlFor="doc-note"
                  hint="Optional for the first version. Required for one that replaces an approved version."
                  error={state.fieldErrors?.changeNote}
                >
                  <Textarea
                    id="doc-note"
                    name="changeNote"
                    rows={2}
                    placeholder="As received from the client on 14 March."
                  />
                </Field>
              </div>
            </div>
          )}
        </ActionForm>
      )}
    </div>
  );
}

/** Editing what a document is, which never touches its files. */
export function DocumentForm({
  caseRecordId,
  document,
  folders,
  levels,
}: {
  caseRecordId: string;
  document: CaseDocument;
  folders: CaseFolder[];
  levels: Level[];
}) {
  return (
    <ActionForm
      action={updateDocument}
      submitLabel="Save"
      submitSize="sm"
      hidden={{
        caseRecordId,
        documentRecordId: document.id,
        expectedVersion: document.version,
      }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <DocumentFields
            document={document}
            folders={folders}
            levels={levels}
            defaultClassification={document.classification}
            fieldErrors={state.fieldErrors}
          />
        </div>
      )}
    </ActionForm>
  );
}

/**
 * The next version (PRD 7.2).
 *
 * The label is derived rather than typed, so a history cannot acquire two
 * v1.0s. A draft steps the minor number and a final one takes the next whole
 * number, and the form says which it will be before it is submitted.
 */
export function NewVersionForm({
  caseRecordId,
  document,
}: {
  caseRecordId: string;
  document: CaseDocument;
}) {
  const [uploaded, setUploaded] = useState<UploadResult | null>(null);
  const [intent, setIntent] = useState<"draft" | "final">("draft");

  const replacingApproved = document.current?.isApproved ?? false;

  return (
    <div className="space-y-3">
      {replacingApproved && (
        <Alert tone="warn" title="This replaces an approved version">
          {document.current?.versionLabel} is approved and locked, so it stays
          exactly as it is and a report that cites it still reads true. The new
          version needs a reason and another person&apos;s approval.
        </Alert>
      )}

      <FileUpload
        bucket="documents"
        pathPrefix={`${document.caseId}/${document.documentId}`}
        names={DOCUMENT_FIELDS}
        label="The new file"
        onUploaded={setUploaded}
      />

      {uploaded && (
        <ActionForm
          action={addDocumentVersion}
          submitLabel={`Add ${nextVersionLabel(document.current, intent)}`}
          submitSize="sm"
          hidden={{
            caseRecordId,
            documentRecordId: document.id,
            fileName: uploaded.fileName,
            mimeType: uploaded.fileType,
            fileSize: uploaded.fileSize,
            sha256: uploaded.declaredSha256,
            storagePath: uploaded.storagePath,
          }}
        >
          {(state) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="This version is"
                htmlFor="ver-intent"
                hint={`Will be filed as ${nextVersionLabel(document.current, intent)}.`}
                error={state.fieldErrors?.intent}
              >
                <Select
                  id="ver-intent"
                  name="intent"
                  value={intent}
                  onChange={(event) =>
                    setIntent(event.target.value as "draft" | "final")
                  }
                >
                  <option value="draft">A further draft</option>
                  <option value="final">A new final version</option>
                </Select>
              </Field>

              <div className="sm:col-span-2">
                <Field
                  label="What changed"
                  htmlFor="ver-note"
                  required={replacingApproved}
                  hint={
                    replacingApproved
                      ? "Required, because this replaces a version somebody approved."
                      : "Optional, but it is what a reader of the history will rely on."
                  }
                  error={state.fieldErrors?.changeNote}
                >
                  <Textarea
                    id="ver-note"
                    name="changeNote"
                    rows={2}
                    placeholder="Pages 7 and 8 were missing from the bundle as first received."
                  />
                </Field>
              </div>
            </div>
          )}
        </ActionForm>
      )}
    </div>
  );
}

/**
 * Approving one version.
 *
 * Offered only on a draft, and never to whoever created it: PRD 16 is
 * explicit that nobody approves their own work, and the server refuses it as
 * well.
 */
export function ApproveVersionControl({
  caseRecordId,
  document,
  version,
  actorId,
  canApprove,
}: {
  caseRecordId: string;
  document: CaseDocument;
  version: DocumentVersion;
  actorId: string;
  canApprove: boolean;
}) {
  if (version.isApproved) return null;

  if (version.createdBy === actorId) {
    return (
      <p className="mt-2 border-t border-line pt-2 text-[11px] text-muted">
        You filed this version, so you cannot approve it. Somebody other than
        you has to, which is the only thing that makes the approval worth
        having.
      </p>
    );
  }

  if (!canApprove) {
    return (
      <p className="mt-2 border-t border-line pt-2 text-[11px] text-muted">
        Waiting on somebody who can approve it.
      </p>
    );
  }

  return (
    <div className="mt-2 border-t border-line pt-2">
      <ActionForm
        action={approveDocumentVersion}
        submitLabel={
          <>
            <Lock className="size-3.5" aria-hidden="true" />
            Approve {version.versionLabel}
          </>
        }
        submitSize="sm"
        hidden={{
          caseRecordId,
          documentRecordId: document.id,
          versionId: version.id,
        }}
        confirm={`Approve ${version.versionLabel}? It is then locked, and a change from there is a new version with a reason.`}
        compact
      />
    </div>
  );
}

export function DocumentRemovalPanel({
  caseRecordId,
  document,
  canRemove,
}: {
  caseRecordId: string;
  document: CaseDocument;
  canRemove: boolean;
}) {
  if (document.deletedAt !== null) {
    return (
      <Card title="Document status">
        <Alert tone="warn" title="Document removed">
          Removed on {new Date(document.deletedAt).toLocaleString("en-GB")} and now
          in the recycle bin. Its versions and their stored files are untouched.
          {canRemove && (
            <div className="mt-3">
              <ActionForm
                action={restoreDocument}
                submitLabel="Restore"
                submitSize="sm"
                hidden={{
                  caseRecordId,
                  documentRecordId: document.id,
                  reason: "restored from the recycle bin",
                }}
                confirm={`Restore ${document.documentId}?`}
                compact
              />
            </div>
          )}
        </Alert>
      </Card>
    );
  }

  if (!canRemove) return null;

  return (
    <Card
      title="Remove this document"
      description="A recoverable soft delete with a reason. The versions and their files stay exactly as they are."
    >
      <ActionForm
        action={removeDocument}
        submitLabel={
          <>
            <Trash2 className="size-4" aria-hidden="true" />
            Remove this document
          </>
        }
        submitTone="danger"
        submitSize="sm"
        hidden={{ caseRecordId, documentRecordId: document.id }}
        confirm={`Remove ${document.documentId}? It stays in the recycle bin.`}
      >
        {(state) => (
          <Field
            label="Reason for removal"
            htmlFor="doc-remove-reason"
            required
            hint="At least five characters. It goes into the audit trail."
            error={state.fieldErrors?.reason}
          >
            <Input
              id="doc-remove-reason"
              name="reason"
              placeholder="Filed against the wrong case in error"
            />
          </Field>
        )}
      </ActionForm>
    </Card>
  );
}

/** The case file's documents tab. */
export function CaseDocumentsPanel({
  caseRecordId,
  caseClassification,
  folders,
  levels,
  summary,
  canCreate,
  children,
}: {
  caseRecordId: string;
  caseClassification: string;
  folders: CaseFolder[];
  levels: Level[];
  summary: { total: number; approved: number; drafts: number };
  canCreate: boolean;
  /** The folder list and the table, both server-rendered. */
  children: React.ReactNode;
}) {
  const [filing, setFiling] = useState(false);

  return (
    <Card
      title="Documents"
      description="Filed into the case's folders, versioned, and locked once approved. A change to an approved version is a new version with a reason."
      actions={
        canCreate && !filing ? (
          <Button size="sm" onClick={() => setFiling(true)}>
            <Plus className="size-4" aria-hidden="true" />
            File a document
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {filing && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-medium text-body">
                <Upload className="size-3.5" aria-hidden="true" />
                File a document
              </p>
              <Button size="sm" tone="ghost" onClick={() => setFiling(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <NewDocumentForm
              caseRecordId={caseRecordId}
              folders={folders}
              levels={levels}
              defaultClassification={caseClassification}
            />
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Documents", value: summary.total, tone: "neutral" as const },
            { label: "Approved", value: summary.approved, tone: "ok" as const },
            {
              label: "Awaiting approval",
              value: summary.drafts,
              tone: summary.drafts > 0 ? ("warn" as const) : ("neutral" as const),
            },
          ].map((tile) => (
            <div key={tile.label} className="card rounded-xl p-3.5">
              <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                {tile.label}
              </p>
              <p
                className={`mt-1 text-2xl font-semibold tabular-nums ${
                  tile.tone === "warn"
                    ? "text-warn"
                    : tile.tone === "ok"
                      ? "text-ok"
                      : "text-body"
                }`}
              >
                {tile.value}
              </p>
            </div>
          ))}
        </div>

        {children}
      </div>
    </Card>
  );
}

"use client";

import { useState } from "react";
import { Pencil, Plus, X } from "lucide-react";
import { Button, Card } from "@/components/ui";
import type { CaseDocument, CaseFolder } from "@/modules/evidence/shared";
import { DocumentForm, NewVersionForm } from "./DocumentForms";

/**
 * The panels on one document's page that need to know which form is open.
 *
 * The version history itself is server-rendered and passed in, because it is
 * a read with no state: putting it in the client bundle would buy nothing.
 */

type Level = { code: string; name: string };

export function VersionsPanel({
  caseRecordId,
  document,
  canAddVersion,
  children,
}: {
  caseRecordId: string;
  document: CaseDocument;
  canAddVersion: boolean;
  children: React.ReactNode;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <Card
      title="Versions"
      description="Newest first. An approved version is locked: a change from there is the next version, with a reason, approved again by somebody else."
      actions={
        canAddVersion && document.deletedAt === null ? (
          <Button
            size="sm"
            tone={adding ? "ghost" : "primary"}
            onClick={() => setAdding(!adding)}
          >
            {adding ? (
              <>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </>
            ) : (
              <>
                <Plus className="size-4" aria-hidden="true" />
                Add a version
              </>
            )}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {adding && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <NewVersionForm caseRecordId={caseRecordId} document={document} />
          </div>
        )}
        {children}
      </div>
    </Card>
  );
}

export function DocumentDetailsPanel({
  caseRecordId,
  document,
  folders,
  levels,
  canEdit,
}: {
  caseRecordId: string;
  document: CaseDocument;
  folders: CaseFolder[];
  levels: Level[];
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (!canEdit || document.deletedAt !== null) return null;

  return (
    <Card
      title="Details"
      description="What this document is and who can open it. Changing the classification changes who can see it at all, and changes nothing about its files."
      actions={
        <Button
          size="sm"
          tone={editing ? "ghost" : "primary"}
          onClick={() => setEditing(!editing)}
        >
          {editing ? (
            <>
              <X className="size-4" aria-hidden="true" />
              Cancel
            </>
          ) : (
            <>
              <Pencil className="size-4" aria-hidden="true" />
              Edit
            </>
          )}
        </Button>
      }
    >
      {editing ? (
        <DocumentForm
          caseRecordId={caseRecordId}
          document={document}
          folders={folders}
          levels={levels}
        />
      ) : (
        <dl className="grid gap-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
              Folder
            </dt>
            <dd className="mt-0.5 text-body">{document.folderName ?? "Unfiled"}</dd>
          </div>
          <div>
            <dt className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
              Tags
            </dt>
            <dd className="mt-0.5 text-body">
              {document.tags.length > 0 ? document.tags.join(", ") : "none"}
            </dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

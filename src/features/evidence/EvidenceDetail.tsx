"use client";

import { AppLink } from "@/components/AppLink";
import { useState } from "react";
import { Copy, Pencil, Plus, X } from "lucide-react";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Id,
  Muted,
} from "@/components/ui";
import type {
  CustodyEvent,
  EvidenceItem,
  IntegrityCheck,
} from "@/modules/evidence/shared";
import { CustodyLedger, IntegrityHistory, IntegritySeal } from "./EvidenceViews";
import { FileUpload, type UploadResult } from "@/components/FileUpload";
import { ActionForm } from "@/components/ActionForm";
import { attachEvidenceFile } from "./actions";
import { verifyEvidence } from "./verify";
import {
  CustodyForm,
  EvidenceForm,
  EvidenceRemovalPanel,
  EvidenceStatusForm,
  WorkingCopyForm,
} from "./EvidenceForms";

/**
 * The panels on one evidence item's page.
 *
 * Client components because each holds the small amount of state that decides
 * which form is open. The ledger itself is a server component, passed in as
 * children would be: it needs no state and belongs in nobody's bundle.
 */

type Person = { id: string; name: string };
type Level = { code: string; name: string };

export function CustodyPanel({
  caseRecordId,
  item,
  events,
  chain,
  people,
  canRecord,
}: {
  caseRecordId: string;
  item: EvidenceItem;
  events: CustodyEvent[];
  chain: { events: number; intact: boolean; brokeAt: string | null };
  people: Person[];
  canRecord: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [correcting, setCorrecting] = useState<CustodyEvent | null>(null);

  // Only the latest entry can be corrected: a chain of corrections of
  // corrections is unreadable, and the rule refuses it anyway.
  const correctable = events
    .filter((event) => event.correctedByEventId === null)
    .at(-1);

  return (
    <Card
      title="Chain of custody"
      description="Every movement, in the order it happened. Append-only for every role: a mistake is put right by a correcting entry, never by changing one."
      actions={
        canRecord && !recording && item.deletedAt === null ? (
          <div className="flex flex-wrap gap-2">
            {correctable && (
              <Button
                size="sm"
                tone="ghost"
                onClick={() => setCorrecting(correctable)}
              >
                <Pencil className="size-4" aria-hidden="true" />
                Correct the last entry
              </Button>
            )}
            <Button size="sm" onClick={() => setRecording(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Record a movement
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {recording && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Record a custody event</p>
              <Button size="sm" tone="ghost" onClick={() => setRecording(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <CustodyForm
              caseRecordId={caseRecordId}
              item={item}
              people={people}
            />
          </div>
        )}

        {correcting && (
          <div className="rounded-lg border border-warn/40 bg-warn/5 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">
                Correct the entry of{" "}
                {new Date(correcting.occurredAt).toLocaleString("en-GB")}
              </p>
              <Button size="sm" tone="ghost" onClick={() => setCorrecting(null)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <p className="mb-3 text-[11px] text-muted">
              This records a new entry that supersedes the original. The original
              stays exactly as it is, which is what makes the ledger worth
              anything.
            </p>
            <CustodyForm
              caseRecordId={caseRecordId}
              item={item}
              people={people}
              correcting={correcting}
            />
          </div>
        )}

        <CustodyLedger events={events} chain={chain} />
      </div>
    </Card>
  );
}

export function EvidenceDetailPanels({
  caseRecordId,
  item,
  checks,
  workingCopies,
  people,
  levels,
  actorId,
  can,
}: {
  caseRecordId: string;
  item: EvidenceItem;
  checks: IntegrityCheck[];
  workingCopies: EvidenceItem[];
  people: Person[];
  levels: Level[];
  actorId: string;
  can: {
    edit: boolean;
    create: boolean;
    upload: boolean;
    download: boolean;
    remove: boolean;
    recordCustody: boolean;
  };
}) {
  const [editing, setEditing] = useState(false);
  const [copying, setCopying] = useState(false);

  return (
    <>
      {can.edit && item.deletedAt === null && (
        <Card
          title="Where it has got to"
          description="Releasing or returning an item is a movement, so it is recorded in the ledger as well."
        >
          <EvidenceStatusForm
            caseRecordId={caseRecordId}
            item={item}
            people={people}
          />
        </Card>
      )}

      <FilePanel
        caseRecordId={caseRecordId}
        item={item}
        canUpload={can.upload}
        canVerify={can.edit}
      />

      <Card
        title="Integrity"
        description="What the server found when it last read the stored file back and computed its own hash."
        actions={
          <IntegritySeal status={item.integrityStatus} verifiedAt={item.verifiedAt} />
        }
      >
        <IntegrityHistory checks={checks} />
      </Card>

      <Card
        title="Working copies"
        description="An original is never worked on. A copy carries the original's classification and its own collection record."
        actions={
          can.create && item.copyStatus === "original" && item.deletedAt === null ? (
            <Button size="sm" onClick={() => setCopying(!copying)}>
              <Copy className="size-4" aria-hidden="true" />
              {copying ? "Cancel" : "Take a copy"}
            </Button>
          ) : undefined
        }
      >
        <div className="space-y-4">
          {copying && (
            <div className="rounded-lg border border-line bg-surface-sunken p-3">
              <WorkingCopyForm
                caseRecordId={caseRecordId}
                original={item}
                people={people}
              />
            </div>
          )}

          {item.copyStatus === "working_copy" ? (
            <Muted>
              This is itself a working copy, so no copies are taken from it: a
              copy comes from the original, which keeps its provenance one step
              rather than a chain.
            </Muted>
          ) : workingCopies.length === 0 ? (
            <EmptyState
              title="No working copies"
              description="Take one before examining the item, so the original is left as collected."
            />
          ) : (
            <ul className="space-y-2">
              {workingCopies.map((copy) => (
                <li key={copy.id} className="rounded-lg border border-line p-3">
                  <AppLink
                    href={`/evidence/${copy.id}`}
                    className="text-xs font-medium text-body hover:text-signal-dark hover:underline"
                  >
                    <Id>{copy.evidenceId}</Id> {copy.description.slice(0, 100)}
                  </AppLink>
                  <p className="mt-1 text-[11px] text-muted">
                    {copy.currentCustodianName
                      ? `Held by ${copy.currentCustodianName}`
                      : "Nobody holds it"}
                    , taken {new Date(copy.collectedAt).toLocaleDateString("en-GB")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {can.edit && item.deletedAt === null && (
        <Card
          title="Details"
          description="The collection facts of who, when, where and how are what a report rests on, so changing them is audited like anything else."
          actions={
            !editing ? (
              <Button size="sm" onClick={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden="true" />
                Edit
              </Button>
            ) : (
              <Button size="sm" tone="ghost" onClick={() => setEditing(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            )
          }
        >
          {editing ? (
            <EvidenceForm
              caseRecordId={caseRecordId}
              item={item}
              people={people}
              levels={levels}
              defaultClassification={item.classification}
              actorId={actorId}
            />
          ) : (
            <Muted>
              Collected by {item.collectedByName ?? "somebody"} on{" "}
              {new Date(item.collectedAt).toLocaleString("en-GB")} at{" "}
              {item.collectionLocation}, {item.collectionMethod}.
            </Muted>
          )}
        </Card>
      )}

      <EvidenceRemovalPanel
        caseRecordId={caseRecordId}
        item={item}
        canRemove={can.remove}
      />
    </>
  );
}

/**
 * The file, its hash and its verification.
 *
 * An original with a file already attached offers no upload at all: the
 * bucket has no UPDATE policy, so a second upload would fail, and offering
 * the control would be offering something that cannot work. A working copy is
 * where a replacement belongs.
 */
function FilePanel({
  caseRecordId,
  item,
  canUpload,
  canVerify,
}: {
  caseRecordId: string;
  item: EvidenceItem;
  canUpload: boolean;
  canVerify: boolean;
}) {
  const [uploaded, setUploaded] = useState<UploadResult | null>(null);

  const bucket =
    item.copyStatus === "original" ? "evidence-originals" : "evidence-copies";

  return (
    <Card
      title="The file"
      description="Hashed in the browser before it is sent, then verified by the server against the stored object. Both hashes are kept."
      actions={
        item.storagePath && canVerify ? (
          <ActionForm
            action={verifyEvidence}
            submitLabel="Verify it now"
            submitSize="sm"
            hidden={{ caseRecordId, evidenceRecordId: item.id }}
            compact
          />
        ) : undefined
      }
    >
      <div className="space-y-4">
        {item.storagePath ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <IntegritySeal
                status={item.integrityStatus}
                verifiedAt={item.verifiedAt}
              />
              <span className="text-xs font-medium text-body">{item.fileName}</span>
              <Muted>
                {item.fileType}
                {item.fileSize !== null
                  ? `, ${Math.ceil(item.fileSize / 1024)} KB`
                  : ""}
              </Muted>
            </div>

            {item.integrityStatus === "hash_unverified" && (
              <Alert tone="warn">
                The hash was declared by the browser that uploaded it, which is
                not evidence of anything on its own. Verifying reads the stored
                object back and computes the server&apos;s own.
              </Alert>
            )}

            {item.copyStatus === "original" && (
              <Muted>
                This is an original, and its bucket has no policy that can
                change or remove an object. Work on a working copy instead.
              </Muted>
            )}
          </>
        ) : canUpload && item.deletedAt === null ? (
          <>
            {!uploaded ? (
              <FileUpload
                bucket={bucket}
                pathPrefix={`${item.caseId}/${item.evidenceId}`}
                onUploaded={setUploaded}
              />
            ) : (
              <div className="space-y-3">
                <Alert tone="info">
                  {uploaded.fileName} is in the {bucket} bucket. Recording it
                  against {item.evidenceId} is the step that puts its hash on the
                  item.
                </Alert>
                <ActionForm
                  action={attachEvidenceFile}
                  submitLabel="Record the file against this item"
                  submitSize="sm"
                  hidden={{
                    caseRecordId,
                    evidenceRecordId: item.id,
                    fileName: uploaded.fileName,
                    fileType: uploaded.fileType,
                    fileSize: uploaded.fileSize,
                    declaredSha256: uploaded.declaredSha256,
                    storagePath: uploaded.storagePath,
                  }}
                />
              </div>
            )}
          </>
        ) : (
          <EmptyState
            title="No file"
            description="Not every item has one: a physical item is registered with its collection record and its custody ledger."
          />
        )}
      </div>
    </Card>
  );
}

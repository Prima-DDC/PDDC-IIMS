"use client";

import { RotateCcw } from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import { restoreEntity, restoreFinding, restoreInformation, restoreSource } from "./actions";

/**
 * Restoring removed intelligence records from the recycle bin (PRD 3.5,
 * screen 29).
 *
 * The reason is fixed rather than asked for: the recycle bin's own context is
 * the reason, and asking for one in a table row gets "restore" typed into
 * every box.
 */

export function EntityRestoreForm({
  entityRecordId,
  reference,
}: {
  entityRecordId: string;
  reference: string;
}) {
  return (
    <ActionForm
      action={restoreEntity}
      submitLabel={
        <>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Restore
        </>
      }
      submitSize="sm"
      hidden={{ entityRecordId, reason: "restored from the recycle bin" }}
      confirm={`Restore ${reference}?`}
      compact
    />
  );
}

export function SourceRestoreForm({
  caseRecordId,
  sourceRecordId,
  reference,
}: {
  caseRecordId: string;
  sourceRecordId: string;
  reference: string;
}) {
  return (
    <ActionForm
      action={restoreSource}
      submitLabel={
        <>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Restore
        </>
      }
      submitSize="sm"
      hidden={{
        caseRecordId,
        sourceRecordId,
        reason: "restored from the recycle bin",
      }}
      confirm={`Restore ${reference}?`}
      compact
    />
  );
}

export function InformationRestoreForm({
  caseRecordId,
  informationRecordId,
  reference,
}: {
  caseRecordId: string;
  informationRecordId: string;
  reference: string;
}) {
  return (
    <ActionForm
      action={restoreInformation}
      submitLabel={
        <>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Restore
        </>
      }
      submitSize="sm"
      hidden={{
        caseRecordId,
        informationRecordId,
        reason: "restored from the recycle bin",
      }}
      confirm={`Restore ${reference}?`}
      compact
    />
  );
}

export function FindingRestoreForm({
  caseRecordId,
  findingRecordId,
  reference,
}: {
  caseRecordId: string;
  findingRecordId: string;
  reference: string;
}) {
  return (
    <ActionForm
      action={restoreFinding}
      submitLabel={
        <>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Restore
        </>
      }
      submitSize="sm"
      hidden={{
        caseRecordId,
        findingRecordId,
        reason: "restored from the recycle bin",
      }}
      confirm={`Restore ${reference}?`}
      compact
    />
  );
}

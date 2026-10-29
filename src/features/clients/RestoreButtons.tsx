"use client";

import { RotateCcw } from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import { restoreCase } from "@/features/cases/actions";
import { restoreEngagement } from "@/features/engagements/actions";
import { restoreClient } from "./actions";

/**
 * Restore buttons for the recycle bin.
 *
 * `compact` on purpose: the row leaving the bin is the feedback, so a success
 * banner inside a row that is about to disappear would be shown and then
 * immediately destroyed. The record's own page carries the wording.
 */

export function RestoreClientButton({ id, name }: { id: string; name: string }) {
  return (
    <ActionForm
      action={restoreClient}
      submitLabel={
        <>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Restore
        </>
      }
      submitSize="sm"
      hidden={{ clientId: id, reason: "restored from the recycle bin" }}
      confirm={`Restore ${name}?`}
      compact
    />
  );
}

export function RestoreEngagementButton({ id, name }: { id: string; name: string }) {
  return (
    <ActionForm
      action={restoreEngagement}
      submitLabel={
        <>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Restore
        </>
      }
      submitSize="sm"
      hidden={{ engagementId: id, reason: "restored from the recycle bin" }}
      confirm={`Restore ${name}?`}
      compact
    />
  );
}

export function RestoreCaseButton({ id, name }: { id: string; name: string }) {
  return (
    <ActionForm
      action={restoreCase}
      submitLabel={
        <>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Restore
        </>
      }
      submitSize="sm"
      hidden={{ caseRecordId: id, reason: "restored from the recycle bin" }}
      confirm={`Restore ${name}?`}
      compact
    />
  );
}

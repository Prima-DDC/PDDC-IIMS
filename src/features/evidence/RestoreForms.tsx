"use client";

import { RotateCcw } from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import type { EvidenceItem } from "@/modules/evidence/shared";
import { restoreEvidence } from "./actions";

/**
 * Restoring a removed item from the recycle bin (PRD 3.5, screen 29).
 *
 * Separate from the panel on the item's own page because the recycle bin
 * lists items across every case and cannot reach that page's state. The
 * reason is fixed here rather than asked for: the recycle bin's own context
 * is the reason, and asking for one in a table row gets "restore" typed into
 * every box.
 */
export function EvidenceRestoreForm({ item }: { item: EvidenceItem }) {
  return (
    <ActionForm
      action={restoreEvidence}
      submitLabel={
        <>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Restore
        </>
      }
      submitSize="sm"
      hidden={{
        caseRecordId: item.caseId,
        evidenceRecordId: item.id,
        reason: "restored from the recycle bin",
      }}
      confirm={`Restore ${item.evidenceId}? Its custody ledger is untouched either way.`}
      compact
    />
  );
}

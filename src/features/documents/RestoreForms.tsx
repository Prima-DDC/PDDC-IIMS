"use client";

import { RotateCcw } from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import type { CaseDocument } from "@/modules/evidence/shared";
import { restoreDocument } from "./actions";

/** Restoring a removed document from the recycle bin (PRD 3.5, screen 29). */
export function DocumentRestoreForm({ document }: { document: CaseDocument }) {
  return (
    <ActionForm
      action={restoreDocument}
      submitLabel={
        <>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Restore
        </>
      }
      submitSize="sm"
      hidden={{
        caseRecordId: document.caseId,
        documentRecordId: document.id,
        reason: "restored from the recycle bin",
      }}
      confirm={`Restore ${document.documentId}?`}
      compact
    />
  );
}

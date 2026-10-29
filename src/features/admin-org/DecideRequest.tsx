"use client";

import { Check, X } from "lucide-react";
import { Field, Input } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { decideAccessRequest } from "./actions";

/**
 * Approve or reject one access-change request.
 *
 * Two separate forms rather than a dropdown, so each decision is a single
 * deliberate click and the confirm text can differ.
 */
export function DecideRequest({ id }: { id: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <ActionForm
        action={decideAccessRequest}
        submitLabel={
          <>
            <Check className="size-4" aria-hidden="true" />
            Approve
          </>
        }
        submitSize="sm"
        submitTone="primary"
        hidden={{ id, approve: "true" }}
        confirm="Approve this high-risk change?"
      >
        <Field label="Note" htmlFor={`approve-note-${id}`}>
          <Input
            id={`approve-note-${id}`}
            name="note"
            placeholder="Optional note for the record"
          />
        </Field>
      </ActionForm>

      <ActionForm
        action={decideAccessRequest}
        submitLabel={
          <>
            <X className="size-4" aria-hidden="true" />
            Reject
          </>
        }
        submitSize="sm"
        submitTone="danger"
        hidden={{ id, approve: "false" }}
      >
        <Field label="Note" htmlFor={`reject-note-${id}`}>
          <Input
            id={`reject-note-${id}`}
            name="note"
            placeholder="Why it is being rejected"
          />
        </Field>
      </ActionForm>
    </div>
  );
}

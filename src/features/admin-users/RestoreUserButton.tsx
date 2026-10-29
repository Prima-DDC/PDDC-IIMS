"use client";

import { RotateCcw } from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import { restoreUser } from "./actions";

export function RestoreUserButton({
  userId,
  name,
}: {
  userId: string;
  name: string;
}) {
  return (
    <ActionForm
      action={restoreUser}
      submitLabel={
        <>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Restore
        </>
      }
      submitTone="secondary"
      submitSize="sm"
      hidden={{ userId, reason: "restored from the recycle bin" }}
      confirm={`Restore ${name}? The account comes back deactivated.`}
      compact
    />
  );
}

"use client";

import { useActionState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { verifyMfa } from "./actions";
import { EMPTY_AUTH_STATE } from "./schema";

export function MfaForm({
  factorId,
  next,
}: {
  factorId: string;
  next?: string;
}) {
  const [state, action, pending] = useActionState(verifyMfa, EMPTY_AUTH_STATE);

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="factorId" value={factorId} />
      {next && <input type="hidden" name="next" value={next} />}

      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <Field
        label="Authentication code"
        htmlFor="code"
        required
        hint="Six digits from your authenticator app."
        error={state.fieldErrors?.code}
      >
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          autoFocus
          disabled={pending}
          className="font-id text-center text-lg tracking-[0.4em]"
          placeholder="000000"
        />
      </Field>

      <Button type="submit" tone="primary" disabled={pending} className="w-full">
        {pending ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Verifying
          </>
        ) : (
          <>
            <ShieldCheck className="size-4" aria-hidden="true" />
            Verify and continue
          </>
        )}
      </Button>
    </form>
  );
}

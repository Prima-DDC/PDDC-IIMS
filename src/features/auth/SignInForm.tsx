"use client";

import { useActionState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { signIn } from "./actions";
import { EMPTY_AUTH_STATE } from "./schema";

export function SignInForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(signIn, EMPTY_AUTH_STATE);

  return (
    <form action={action} className="space-y-4" noValidate>
      {next && <input type="hidden" name="next" value={next} />}

      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <Field
        label="Work email"
        htmlFor="email"
        required
        error={state.fieldErrors?.email}
      >
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          placeholder="name@primaddc.com"
          disabled={pending}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        required
        error={state.fieldErrors?.password}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
        />
      </Field>

      {/* Double-click protection comes free from the pending state (PRD 21.6). */}
      <Button type="submit" tone="primary" disabled={pending} className="w-full">
        {pending ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Signing in
          </>
        ) : (
          <>
            <LogIn className="size-4" aria-hidden="true" />
            Sign in
          </>
        )}
      </Button>

      <p className="text-center text-[11px] text-muted">
        Use the same credentials as the PDDC staff portal. One account covers
        both.
      </p>
    </form>
  );
}

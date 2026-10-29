"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import Image from "next/image";
import { Loader2, ShieldCheck } from "lucide-react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * First-time TOTP enrolment.
 *
 * Runs in the browser because enrolment is interactive: Supabase returns a QR
 * code that has to be displayed, then the same factor id is used to verify the
 * first code. The secret never reaches our server, which is the right place
 * for it not to be.
 */
export function EnrolMfa({ next }: { next?: string }) {
  const router = useRouter();
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const begin = useCallback(async () => {
    // No setState before the first await: doing so synchronously inside the
    // mount effect would cascade a render.
    const supabase = createSupabaseBrowserClient();

    // A previous half-finished attempt leaves an unverified factor behind,
    // and Supabase refuses a second enrolment while one exists.
    const { data: existing } = await supabase.auth.mfa.listFactors();
    for (const factor of existing?.all ?? []) {
      if (factor.status === "unverified") {
        await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
    }

    const { data, error: enrolError } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `PDDC IIMS ${new Date().toISOString().slice(0, 10)}`,
    });

    if (enrolError || !data) {
      setError(enrolError?.message ?? "Could not start enrolment.");
      return;
    }

    setFactorId(data.id);
    setQr(data.totp.qr_code);
    setSecret(data.totp.secret);
  }, []);

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!factorId) return;

    setBusy(true);
    setError(null);

    const supabase = createSupabaseBrowserClient();
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId,
    });

    if (challengeError || !challenge) {
      setError(challengeError?.message ?? "Could not start verification.");
      setBusy(false);
      return;
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: code.trim(),
    });

    if (verifyError) {
      setError("That code is not valid. Check the app and try again.");
      setBusy(false);
      return;
    }

    // The session is now aal2. Re-render on the server so the layout sees it.
    router.replace(next && next.startsWith("/") ? next : "/dashboard");
    router.refresh();
  }

  // Enrolment starts on an explicit click rather than on mount. A TOTP secret
  // is a credential, so generating one should be something the user asked for,
  // and a half-finished attempt on every page view leaves unverified factors
  // behind that then block the next one.
  if (!qr) {
    return (
      <div className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Button
          type="button"
          tone="primary"
          disabled={busy}
          className="w-full"
          onClick={() => {
            setBusy(true);
            setError(null);
            void begin().finally(() => setBusy(false));
          }}
        >
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Preparing your authenticator setup
            </>
          ) : (
            <>
              <ShieldCheck className="size-4" aria-hidden="true" />
              Start two-factor setup
            </>
          )}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={verify} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex flex-col items-center gap-3">
        {/* Supabase returns a data: URI, which next/image cannot optimise. */}
        <Image
          src={qr}
          alt="QR code for authenticator app enrolment"
          width={180}
          height={180}
          unoptimized
          className="rounded-lg border border-line bg-white p-2"
        />
        {secret && (
          <details className="w-full text-center">
            <summary className="cursor-pointer text-[11px] text-muted">
              Cannot scan? Enter this key manually
            </summary>
            <p className="font-id mt-2 rounded-md bg-surface-sunken px-2 py-1.5 text-[11px] break-all">
              {secret}
            </p>
          </details>
        )}
      </div>

      <Field label="Authentication code" htmlFor="enrol-code" required>
        <Input
          id="enrol-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          disabled={busy}
          className="font-id text-center text-lg tracking-[0.4em]"
          placeholder="000000"
        />
      </Field>

      <Button type="submit" tone="primary" disabled={busy} className="w-full">
        {busy ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Verifying
          </>
        ) : (
          <>
            <ShieldCheck className="size-4" aria-hidden="true" />
            Confirm and continue
          </>
        )}
      </Button>
    </form>
  );
}

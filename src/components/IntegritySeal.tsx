"use client";

import { ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";

/**
 * Hash-verification state of a stored evidence file.
 *
 * `unverified` is a first-class state, not a loading spinner. Evidence files
 * upload direct from the browser to Supabase Storage (Vercel caps function
 * bodies at 4.5 MB, so the server cannot proxy and hash them), which means the
 * SHA-256 is initially only *declared* by the client. A background worker then
 * streams the object back, recomputes the hash server-side, and moves the row
 * to `verified` or `mismatch`.
 *
 * Showing that honestly matters: an investigator must be able to tell a
 * server-attested hash from a client-asserted one before relying on it.
 */
export type IntegrityState = "verified" | "unverified" | "mismatch";

const PRESENTATION: Record<
  IntegrityState,
  { icon: typeof ShieldCheck; label: string; detail: string; tone: string }
> = {
  verified: {
    icon: ShieldCheck,
    label: "Integrity verified",
    detail: "SHA-256 recomputed server-side and matched.",
    tone: "border-ok/35 bg-ok/10 text-ok",
  },
  unverified: {
    icon: ShieldQuestion,
    label: "Awaiting verification",
    detail: "Hash declared at upload; server-side verification is queued.",
    tone: "border-warn/35 bg-warn/10 text-warn",
  },
  mismatch: {
    icon: ShieldAlert,
    label: "Integrity FAILED",
    detail: "The stored file does not match its recorded hash. Do not rely on this item.",
    tone: "border-danger/45 bg-danger/10 text-danger",
  },
};

export function IntegritySeal({
  state,
  hash,
  verifiedAt,
  compact = false,
}: {
  state: IntegrityState;
  /** Full SHA-256, shown monospaced and truncated. */
  hash?: string;
  verifiedAt?: string;
  compact?: boolean;
}) {
  const { icon: Icon, label, detail, tone } = PRESENTATION[state];

  if (compact) {
    return (
      <span
        title={`${label}: ${detail}`}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {state === "verified" ? "Verified" : state === "mismatch" ? "Failed" : "Pending"}
      </span>
    );
  }

  return (
    <div className={`rounded-lg border p-3 ${tone}`}>
      <div className="flex items-start gap-2.5">
        <Icon
          className={`mt-0.5 size-5 shrink-0 ${
            state === "mismatch" ? "animate-pulse-ring" : ""
          }`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{label}</p>
          <p className="mt-0.5 text-xs opacity-90">{detail}</p>

          {hash && (
            <p className="font-id mt-2 truncate text-[11px] opacity-75" title={hash}>
              {hash.slice(0, 16)}...{hash.slice(-16)}
            </p>
          )}
          {verifiedAt && (
            <p className="mt-1 text-[11px] opacity-70">Checked {verifiedAt}</p>
          )}
        </div>
      </div>
    </div>
  );
}

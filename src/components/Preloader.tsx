"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const SEEN_KEY = "pddc.preloader.seen";

/**
 * Branded first-load preloader: the PDDC shield draws itself, with the
 * fingerprint ridges stroking in behind it.
 *
 * Shown once per session (sessionStorage-gated, matching the pattern already
 * used on primaddc.com) so it never becomes an obstacle between an
 * investigator and their work. Under prefers-reduced-motion the stroke
 * animation collapses and it simply fades.
 *
 * The "already seen" flag is read through useSyncExternalStore because
 * sessionStorage is an external store. The server snapshot is `true`, so the
 * preloader is never server-rendered, which is what prevents it flashing on
 * a navigation that did not need it.
 */
function subscribe() {
  // The flag only changes from inside this component, so there is nothing to
  // subscribe to; the setState below re-reads it.
  return () => {};
}

function hasSeen(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Private mode or blocked storage: treat as seen rather than replaying
    // the preloader on every navigation.
    return true;
  }
}

const seenOnServer = () => true;

export function Preloader({ note = "Securing session" }: { note?: string }) {
  const alreadySeen = useSyncExternalStore(subscribe, hasSeen, seenOnServer);
  const [phase, setPhase] = useState<"showing" | "leaving" | "done">("showing");

  useEffect(() => {
    if (alreadySeen) return;

    // Both setState calls happen in timer callbacks, not synchronously in the
    // effect body, so they do not cascade renders.
    const toLeaving = setTimeout(() => setPhase("leaving"), 1500);
    const toDone = setTimeout(() => {
      try {
        sessionStorage.setItem(SEEN_KEY, "1");
      } catch {
        // Non-fatal; the preloader simply shows again next navigation.
      }
      setPhase("done");
    }, 2100);

    return () => {
      clearTimeout(toLeaving);
      clearTimeout(toDone);
    };
  }, [alreadySeen]);

  if (alreadySeen || phase === "done") return null;

  // While it is fading out the overlay is already see-through, so letting it
  // keep swallowing clicks would make the first interaction of a session
  // silently do nothing.
  return (
    <div
      role="status"
      aria-live="polite"
      data-preloader=""
      className={`fixed inset-0 z-[100] grid place-items-center bg-ink-deep ${
        phase === "leaving"
          ? "animate-preloader-exit pointer-events-none"
          : "animate-fade-in"
      }`}
    >
      <div className="flex flex-col items-center gap-6">
        <svg
          viewBox="0 0 100 116"
          className="size-20"
          role="img"
          aria-label="Prima Due Diligence Consult"
        >
          {/* Fingerprint ridges, drawn first and dimmer. */}
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="animate-logo-draw text-signal/60"
            style={{ strokeDasharray: 520 }}
          >
            <path d="M50 34c-9 0-16 7-16 16v12a16 16 0 0 0 32 0V50c0-9-7-16-16-16Z" />
            <path d="M50 44c-4 0-6 3-6 6v12a6 6 0 0 0 12 0V50c0-3-2-6-6-6Z" />
            <path d="M50 54v10" />
          </g>

          {/* Shield outline. */}
          <path
            d="M50 4 12 18v34c0 26 16 46 38 60 22-14 38-34 38-60V18L50 4Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinejoin="round"
            className="animate-logo-draw text-on-ink"
            style={{ strokeDasharray: 520 }}
          />
        </svg>

        <div className="flex flex-col items-center gap-2">
          <p className="text-[11px] font-semibold tracking-[0.3em] text-on-ink/80 uppercase">
            PDDC&nbsp;IIMS
          </p>
          <p className="text-xs text-on-ink/55">{note}...</p>
        </div>

        {/* Honest about doing work, without pretending to know a percentage. */}
        <div className="h-0.5 w-40 overflow-hidden rounded-full bg-on-ink/15">
          <div className="h-full w-1/2 animate-shimmer rounded-full bg-signal" />
        </div>
      </div>
    </div>
  );
}

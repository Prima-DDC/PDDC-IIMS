import type { ClassificationLevel } from "@/lib/db/client";

const LABELS: Record<ClassificationLevel, string> = {
  PUBLIC: "Public",
  INTERNAL: "Internal",
  CONFIDENTIAL: "Confidential",
  RESTRICTED: "Restricted",
  STRICTLY_RESTRICTED: "Strictly Restricted",
};

// Each level gets its own colour so the banner is recognisable peripherally,
// without reading it. Deliberately distinct from the risk scale: an analyst
// must never confuse "how sensitive is this" with "how risky is this case".
const TONES: Record<ClassificationLevel, string> = {
  PUBLIC: "bg-class-public text-white",
  INTERNAL: "bg-class-internal text-white",
  CONFIDENTIAL: "bg-class-confidential text-ink-deep",
  RESTRICTED: "bg-class-restricted text-white",
  STRICTLY_RESTRICTED: "bg-class-secret text-white",
};

/**
 * The persistent classification banner (PRD §18, §23).
 *
 * Shown on every screen that displays classified material, and always
 * truthful to the record actually on screen: it is derived from the record's
 * own classification, never from a page-level default, so it cannot drift out
 * of step with what the user is looking at.
 *
 * It survives printing on purpose: an exported or printed page must carry its
 * classification (PRD §10.2).
 */
export function ClassificationBanner({
  level,
  caseId,
  sticky = true,
}: {
  level: ClassificationLevel;
  /** Shown alongside so a printed page is self-identifying. */
  caseId?: string;
  sticky?: boolean;
}) {
  return (
    <div
      role="note"
      aria-label={`Classification: ${LABELS[level]}`}
      className={`${TONES[level]} ${
        sticky ? "sticky top-0 z-30" : ""
      } flex items-center justify-center gap-3 px-4 py-1 text-center`}
    >
      <span className="text-[11px] font-bold tracking-[0.18em] uppercase">
        {LABELS[level]}
      </span>
      {caseId && (
        <span className="font-id text-[11px] opacity-80">{caseId}</span>
      )}
    </div>
  );
}

export { LABELS as CLASSIFICATION_LABELS };

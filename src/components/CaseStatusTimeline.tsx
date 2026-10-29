import { Check } from "lucide-react";

/**
 * The status rail that sits across the top of every case page (PRD §23).
 *
 * States come from the case lifecycle in PRD §4.2. The server is authoritative:
 * it returns which transitions are legal, and this only renders them. The UI
 * never decides what is allowed (PRD §21.2 "Workflow state").
 *
 * Long lifecycles scroll horizontally rather than wrapping, so the sense of a
 * single progression is preserved on a phone.
 */
export const CASE_LIFECYCLE = [
  "New",
  "Pending Approval",
  "Approved",
  "Assigned",
  "Investigation in Progress",
  "Awaiting Information",
  "Analysis",
  "Draft Report",
  "Quality Review",
  "Delivered",
  "Completed",
  "Closed",
  "Archived",
] as const;

export type CaseStatus = (typeof CASE_LIFECYCLE)[number];

export function CaseStatusTimeline({
  current,
  stages = CASE_LIFECYCLE,
  label = "Case progress",
}: {
  /**
   * The stage reached. A plain string rather than CaseStatus, because `stages`
   * is overridable and the same rail carries the intake pipeline and the
   * engagement progression.
   */
  current: string;
  /** Overridable: PDDC administrators can rename or reorder stages (§4.3). */
  stages?: readonly string[];
  label?: string;
}) {
  const currentIndex = stages.indexOf(current);

  return (
    <nav aria-label={label} className="no-scrollbar overflow-x-auto">
      <ol className="flex min-w-max items-center gap-0 px-1 py-3">
        {stages.map((stage, index) => {
          const done = index < currentIndex;
          const active = index === currentIndex;

          return (
            <li key={stage} className="flex items-center">
              <div className="flex flex-col items-center gap-1.5 px-2">
                <span
                  aria-hidden="true"
                  className={`grid size-6 place-items-center rounded-full border-2 text-[10px] font-bold transition-colors ${
                    done
                      ? "border-signal bg-signal text-white"
                      : active
                        ? "border-signal bg-surface text-signal-dark"
                        : "border-line-strong bg-surface text-faint"
                  }`}
                >
                  {done ? <Check className="size-3.5" /> : index + 1}
                </span>

                <span
                  className={`max-w-24 text-center text-[10.5px] leading-tight ${
                    active
                      ? "font-semibold text-body"
                      : done
                        ? "text-muted"
                        : "text-faint"
                  }`}
                >
                  {stage}
                </span>

                {active && <span className="sr-only">(current stage)</span>}
                {done && <span className="sr-only">(done)</span>}
              </div>

              {index < stages.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`mb-5 h-0.5 w-8 origin-left rounded-full ${
                    done ? "animate-timeline-grow bg-signal" : "bg-line-strong"
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

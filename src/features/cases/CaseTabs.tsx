"use client";

import { AppLink } from "@/components/AppLink";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * The case file's tabs (PRD 18, screen 9).
 *
 * The case record is the centre of the platform and it accumulates: the
 * objective, the lifecycle, risk, assignment, scope, the plan, the work, the
 * log, communications, safety and the commercials, with evidence, subjects,
 * findings and reports still to come. On one page that is a scroll nobody
 * reads to the end of, and every section's queries run whether anybody looks
 * at them or not.
 *
 * The tab lives in the URL rather than in state, for three reasons: a
 * particular tab of a particular case is a link somebody can send, the back
 * button does what it should, and the server renders only the tab being
 * looked at.
 *
 * Tabs appear as their milestones land. A tab that linked to an empty screen
 * would be worse than its absence, which is also why the ones still to come
 * are not stubbed here.
 */

export interface CaseTab {
  key: string;
  label: string;
  /** Shown as a count or a warning dot beside the label. */
  badge?: number | null;
  /** True when the tab holds something somebody should look at now. */
  alert?: boolean;
}

export function CaseTabs({ tabs, active }: { tabs: CaseTab[]; active: string }) {
  const pathname = usePathname();
  const params = useSearchParams();

  const href = (key: string) => {
    const next = new URLSearchParams(params.toString());
    if (key === "summary") next.delete("tab");
    else next.set("tab", key);
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  };

  return (
    <div
      role="tablist"
      aria-label="Case sections"
      // Scrolls horizontally rather than wrapping: on a phone a wrapped tab
      // bar three rows deep pushes the case itself off the screen.
      className="no-scrollbar -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0"
    >
      <div className="flex min-w-max gap-1 border-b border-line">
        {tabs.map((tab) => {
          const current = tab.key === active;
          return (
            <AppLink
              key={tab.key}
              href={href(tab.key)}
              role="tab"
              aria-selected={current}
              scroll={false}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                current
                  ? "border-signal text-signal-dark"
                  : "border-transparent text-muted hover:border-line-strong hover:text-body"
              }`}
            >
              {tab.label}
              {typeof tab.badge === "number" && tab.badge > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                    tab.alert
                      ? "bg-danger/15 text-danger"
                      : "bg-surface-sunken text-muted"
                  }`}
                >
                  {tab.badge}
                </span>
              )}
            </AppLink>
          );
        })}
      </div>
    </div>
  );
}

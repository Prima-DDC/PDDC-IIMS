"use client";

import { AppLink } from "@/components/AppLink";
import { usePathname } from "next/navigation";
import { NAV_ICONS } from "@/components/nav-icons";
import type { NavEntry } from "./navigation";

/**
 * Desktop side navigation. Hidden below `md`, where BottomNavBar takes over.
 */
/**
 * WHY PREFETCHING IS OFF HERE
 *
 * Next prefetches every `<AppLink>` that comes into view, which for a sidebar
 * means a full server render of every destination on every page view. Each of
 * those destinations is a permission-filtered, database-backed register:
 * cases, evidence, documents, subjects, sources, information, findings,
 * clients, engagements, intake, reports, tasks, safety and the dashboard.
 *
 * Measured against the live project, this was not a small waste. Submitting a
 * form on the case page took the browser's own request list from one POST to
 * fifteen GETs, every one of them a full render opening several transactions
 * against a database 130ms away and a pooler that serves this project from a
 * small server pool. The action's own re-render then queued behind them: the
 * write landed, the response came back 200 with a complete body, and the
 * screen never showed it because the client was still waiting on a dozen
 * renders nobody had asked for. It got worse with every milestone, because
 * every milestone adds another register to the sidebar.
 *
 * A sidebar is navigated deliberately and infrequently; the cost of fetching
 * a page when somebody actually clicks it is one render, which is the one
 * they want. So the links here are not prefetched, and that decision belongs
 * to navigation chrome specifically: a link inside a list, where the next
 * click is predictable and the target is cheap, can still prefetch.
 */
export function SideNav({ entries }: { entries: NavEntry[] }) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/dashboard"
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav
      aria-label="Sections"
      className="hidden w-56 shrink-0 border-r border-line md:block"
    >
      <ul className="sticky top-16 space-y-0.5 p-3">
        {entries.map((entry) => {
          const Icon = NAV_ICONS[entry.icon];
          const active = isActive(entry.href);

          return (
            <li key={entry.href}>
              <AppLink
                href={entry.href}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                  active
                    ? "bg-signal/10 font-medium text-signal-dark"
                    : "text-muted hover:bg-surface-sunken hover:text-body"
                }`}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{entry.label}</span>
              </AppLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

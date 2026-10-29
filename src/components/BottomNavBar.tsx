"use client";

import { AppLink } from "@/components/AppLink";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { NAV_ICONS, type NavIconName } from "./nav-icons";

export interface BottomNavItem {
  href: string;
  label: string;
  /** Icon NAME, not a component: nav items are built on the server and must
   *  survive serialisation across the boundary. Resolved via NAV_ICONS. */
  icon: NavIconName;
  /** Unread or overdue count, rendered as a dot with a number. */
  badge?: number;
}

/**
 * Mobile and tablet bottom navigation.
 *
 * Required on every dashboard below the `md` breakpoint (PRD §18 "works on
 * desktop, tablet and phone", and the standing requirement that admin and
 * portal dashboards use a bottom button navbar on small devices).
 *
 * Design notes:
 *  - Five primary destinations plus a "More" sheet. Five is the most that
 *    stays thumb-reachable at 360px without the labels truncating.
 *  - The active pill slides between items rather than cutting, which is the
 *    single cheapest thing that makes a web app feel native. It is a CSS
 *    transform transition, so it collapses with prefers-reduced-motion.
 *  - Safe-area insets are honoured so the bar clears the iOS home indicator.
 *  - Items are role-aware: the caller passes only destinations this user may
 *    actually reach, so the bar never shows a link that 403s.
 */
export function BottomNavBar({
  items,
  moreItems = [],
}: {
  items: BottomNavItem[];
  moreItems?: BottomNavItem[];
}) {
  const pathname = usePathname();
  const [sheetOpen, setSheetOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  const activeIndex = items.findIndex((i) => isActive(i.href));

  // Measure the active item so the pill can be positioned in pixels. Doing
  // this from the DOM rather than with a fixed width keeps it correct when
  // labels differ in length or the viewport rotates.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || activeIndex < 0) {
      setPill(null);
      return;
    }

    const measure = () => {
      const target = nav.querySelectorAll<HTMLElement>("[data-nav-item]")[activeIndex];
      if (!target) return;
      setPill({ left: target.offsetLeft, width: target.offsetWidth });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [activeIndex, items.length]);

  // Close the sheet on Escape. (Route changes close it via the links' own
  // onClick below, which avoids a setState cascade on every navigation.)
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  return (
    <>
      {/* Above the bar, not below it. At z-40 the bar stayed clickable through
          the overlay, which is not what a modal sheet means. */}
      {sheetOpen && (
        <div
          className="fixed inset-0 z-[60] bg-ink-deep/40 backdrop-blur-sm md:hidden animate-fade-in"
          onClick={() => setSheetOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* The sheet and the bar were both z-50 and both anchored to the bottom,
          so the bar, being later in the DOM, painted over the sheet's last row
          and swallowed taps meant for it. Adding two destinations was enough to
          push a real link under there. The sheet now sits above the bar and
          scrolls, so growing the menu cannot hide anything again. */}
      {sheetOpen && (
        <div
          id="bottom-nav-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="More destinations"
          className="fixed inset-x-0 bottom-0 z-[70] flex max-h-[80dvh] flex-col md:hidden animate-sheet-up glass-panel rounded-t-2xl pb-safe"
        >
          <div className="flex shrink-0 items-center justify-between px-5 pt-4 pb-2">
            <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
              More
            </h2>
            <button
              type="button"
              onClick={() => setSheetOpen(false)}
              className="grid size-9 place-items-center rounded-full text-muted hover:bg-surface-sunken hover:text-body"
              aria-label="Close"
            >
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>

          <ul className="grid grid-cols-3 gap-1 overflow-y-auto px-3 pb-4">
            {moreItems.map((item) => {
              const Icon = NAV_ICONS[item.icon];
              return (
                <li key={item.href}>
                  <AppLink
                    href={item.href}
                    // Not prefetched, for the reason SideNav records: a
                    // sidebar of database-backed registers prefetched on
                    // every page view costs fifteen server renders nobody
                    // asked for, and on a phone it costs them over mobile
                    // data as well.
                    prefetch={false}
                    onClick={() => setSheetOpen(false)}
                    className={`flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-center transition-colors ${
                      isActive(item.href)
                        ? "bg-signal/10 text-signal-dark"
                        : "text-muted hover:bg-surface-sunken hover:text-body"
                    }`}
                  >
                    <Icon className="size-5" aria-hidden="true" />
                    <span className="text-[11px] leading-tight font-medium">
                      {item.label}
                    </span>
                  </AppLink>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <nav
        ref={navRef}
        aria-label="Primary"
        className="glass fixed inset-x-0 bottom-0 z-50 border-t border-line pb-safe md:hidden"
      >
        {/* The sliding active indicator. */}
        {pill && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0 h-0.5 rounded-full bg-signal transition-[left,width] duration-300 ease-out-expo"
            style={{ left: pill.left, width: pill.width }}
          />
        )}

        <ul className="flex items-stretch">
          {items.map((item) => {
            const Icon = NAV_ICONS[item.icon];
            const active = isActive(item.href);
            return (
              <li key={item.href} className="flex-1" data-nav-item>
                <AppLink
                  href={item.href}
                  prefetch={false}
                  aria-current={active ? "page" : undefined}
                  // 56px min target: comfortably above the 44px guideline, and
                  // reachable one-handed at phone width.
                  className={`flex min-h-14 flex-col items-center justify-center gap-1 px-1 py-2 transition-colors active:scale-[0.96] ${
                    active ? "text-signal-dark" : "text-muted"
                  }`}
                >
                  <span className="relative">
                    <Icon className="size-[22px]" aria-hidden="true" />
                    {item.badge ? (
                      <span
                        className="absolute -top-1.5 -right-2 min-w-4 rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-white"
                        aria-label={`${item.badge} pending`}
                      >
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[10.5px] leading-none font-medium tracking-tight">
                    {item.label}
                  </span>
                </AppLink>
              </li>
            );
          })}

          {moreItems.length > 0 && (
            <li className="flex-1">
              <button
                type="button"
                onClick={() => setSheetOpen((v) => !v)}
                aria-expanded={sheetOpen}
                aria-controls="bottom-nav-sheet"
                className={`flex min-h-14 w-full flex-col items-center justify-center gap-1 px-1 py-2 transition-colors active:scale-[0.96] ${
                  sheetOpen ? "text-signal-dark" : "text-muted"
                }`}
              >
                <MoreHorizontal className="size-[22px]" aria-hidden="true" />
                <span className="text-[10.5px] leading-none font-medium tracking-tight">
                  More
                </span>
              </button>
            </li>
          )}
        </ul>
      </nav>
    </>
  );
}

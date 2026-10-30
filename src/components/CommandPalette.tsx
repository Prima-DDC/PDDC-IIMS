"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Search } from "lucide-react";
import { NAV_ICONS, type NavIconName } from "./nav-icons";

/**
 * The command palette (PRD screen 4).
 *
 * Ctrl+K, or Cmd+K. Two things only: jump to a screen, or search for a
 * record.
 *
 * The destinations are passed in from the server layout, already filtered by
 * the viewer's effective permissions, so the palette cannot offer somewhere
 * that would then refuse them. That is the same rule the side navigation
 * follows and it matters more here, because a palette is where somebody
 * types the name of a thing they are not sure exists: an entry for
 * "Administration" shown to an investigator would answer a question they
 * should not be able to ask of the menu.
 *
 * The filtering is over those destinations only. Records are found by
 * searching, which is a round trip to eleven permission-filtered queries and
 * belongs behind Enter rather than behind every keystroke.
 */

export interface PaletteEntry {
  href: string;
  label: string;
  icon: NavIconName;
}

export function CommandPalette({ entries }: { entries: PaletteEntry[] }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  /**
   * Closing clears the field, and it does so HERE rather than in an effect
   * watching `open`.
   *
   * Resetting state from an effect means a render with the palette closed and
   * the old term still in state, then a second render to clear it, and React
   * flags it for exactly that reason. Clearing where the close happens is one
   * render and one obvious place.
   */
  function close() {
    setOpen(false);
    setTerm("");
    setCursor(0);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((was) => !was);
        return;
      }
      if (event.key === "Escape") {
        setTerm("");
        setCursor(0);
        setOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Focused after the overlay is painted, so the caret lands in the field
    // rather than the key that opened it being swallowed.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search, or press Control and K"
        className="hidden items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-signal/40 hover:text-body sm:inline-flex"
      >
        <Search className="size-3.5" aria-hidden="true" />
        <span>Search</span>
        <kbd className="rounded border border-line bg-surface-sunken px-1 font-mono text-[10px]">
          Ctrl K
        </kbd>
      </button>
    );
  }

  const needle = term.trim().toLowerCase();
  const matches = needle
    ? entries.filter((entry) => entry.label.toLowerCase().includes(needle))
    : entries;

  // The search row is always last and always available, so Enter on a term
  // that matches no screen still does the obvious thing.
  const searchRow = needle.length > 0;
  const rowCount = matches.length + (searchRow ? 1 : 0);
  const active = Math.min(cursor, Math.max(rowCount - 1, 0));

  function go(index: number) {
    if (searchRow && index === matches.length) {
      router.push(`/search?q=${encodeURIComponent(term.trim())}`);
    } else if (matches[index]) {
      router.push(matches[index].href);
    } else {
      return;
    }
    close();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 px-4 pt-[12vh] backdrop-blur-sm"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-3.5">
          <Search className="size-4 shrink-0 text-faint" aria-hidden="true" />
          <input
            ref={inputRef}
            value={term}
            onChange={(event) => {
              setTerm(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((at) => (rowCount === 0 ? 0 : (at + 1) % rowCount));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((at) => (rowCount === 0 ? 0 : (at - 1 + rowCount) % rowCount));
              } else if (event.key === "Enter") {
                event.preventDefault();
                go(active);
              }
            }}
            type="text"
            placeholder="Go to a screen, or search for a record"
            aria-label="Go to a screen, or search for a record"
            className="h-12 w-full bg-transparent text-sm text-body outline-none placeholder:text-faint"
          />
          <kbd className="hidden shrink-0 rounded border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-faint sm:block">
            Esc
          </kbd>
        </div>

        <ul className="max-h-[50vh] overflow-y-auto p-1.5">
          {matches.map((entry, index) => {
            const Icon = NAV_ICONS[entry.icon];
            return (
              <li key={entry.href}>
                <button
                  type="button"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => go(index)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                    index === active
                      ? "bg-signal/10 text-signal-dark"
                      : "text-body hover:bg-surface-sunken"
                  }`}
                >
                  <Icon className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="flex-1 truncate">{entry.label}</span>
                  {index === active && (
                    <CornerDownLeft
                      className="size-3.5 shrink-0 text-faint"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </li>
            );
          })}

          {searchRow && (
            <li>
              <button
                type="button"
                onMouseEnter={() => setCursor(matches.length)}
                onClick={() => go(matches.length)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                  matches.length === active
                    ? "bg-signal/10 text-signal-dark"
                    : "text-body hover:bg-surface-sunken"
                }`}
              >
                <Search className="size-4 shrink-0 text-muted" aria-hidden="true" />
                <span className="flex-1 truncate">
                  Search the platform for{" "}
                  <span className="font-medium">{term.trim()}</span>
                </span>
                <CornerDownLeft
                  className="size-3.5 shrink-0 text-faint"
                  aria-hidden="true"
                />
              </button>
            </li>
          )}

          {rowCount === 0 && (
            <li className="px-2.5 py-6 text-center text-xs text-muted">
              No screen by that name.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

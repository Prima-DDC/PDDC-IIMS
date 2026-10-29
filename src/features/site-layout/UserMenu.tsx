"use client";

import { AppLink } from "@/components/AppLink";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, MonitorSmartphone, ShieldCheck, User } from "lucide-react";
import { signOut, signOutEverywhere } from "@/features/auth/actions";

/**
 * Account menu. Shows who you are acting as, your clearance and your primary
 * role, because on an evidence platform "which hat am I wearing" matters.
 */
export function UserMenu({
  fullName,
  email,
  clearance,
  primaryRole,
  isAdministrator,
}: {
  fullName: string | null;
  email: string;
  clearance: string;
  primaryRole: string | null;
  isAdministrator: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initials = (fullName ?? email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-full border border-line bg-surface py-0.5 pr-2 pl-0.5 transition-colors hover:bg-surface-sunken"
      >
        <span className="grid size-7 place-items-center rounded-full bg-ink text-[11px] font-semibold text-on-ink">
          {initials || "?"}
        </span>
        <span className="hidden max-w-32 truncate text-xs font-medium text-body sm:inline">
          {fullName ?? email}
        </span>
        <ChevronDown className="size-3.5 text-faint" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          className="glass-panel animate-dialog-in absolute right-0 z-50 mt-2 w-64 rounded-xl p-1.5 shadow-lg"
        >
          <div className="border-b border-line px-2.5 py-2">
            <p className="truncate text-sm font-medium text-body">
              {fullName ?? "Name not set"}
            </p>
            <p className="font-id truncate text-[11px] text-muted">{email}</p>

            <div className="mt-2 flex flex-wrap gap-1">
              {primaryRole && (
                <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-muted">
                  {primaryRole}
                </span>
              )}
              <span className="rounded-full bg-signal/12 px-2 py-0.5 text-[10px] font-medium text-signal-dark">
                {clearance.replace(/_/g, " ")}
              </span>
              {isAdministrator && (
                <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-medium text-warn">
                  Administrator
                </span>
              )}
            </div>
          </div>

          <ul className="py-1">
            <li>
              <AppLink
                href="/profile"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted hover:bg-surface-sunken hover:text-body"
              >
                <User className="size-3.5" aria-hidden="true" />
                My profile
              </AppLink>
            </li>
            <li>
              <AppLink
                href="/profile/security"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted hover:bg-surface-sunken hover:text-body"
              >
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                Security and sessions
              </AppLink>
            </li>
          </ul>

          <div className="border-t border-line pt-1">
            <form action={signOut}>
              <button
                type="submit"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-muted hover:bg-surface-sunken hover:text-body"
              >
                <LogOut className="size-3.5" aria-hidden="true" />
                Sign out
              </button>
            </form>
            <form action={signOutEverywhere}>
              <button
                type="submit"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-danger hover:bg-danger/10"
              >
                <MonitorSmartphone className="size-3.5" aria-hidden="true" />
                Sign out of all devices
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

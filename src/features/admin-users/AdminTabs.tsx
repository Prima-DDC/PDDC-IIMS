"use client";

import { AppLink } from "@/components/AppLink";
import { usePathname } from "next/navigation";

/**
 * Section navigation for administration.
 *
 * Horizontally scrollable rather than wrapping, so it stays a single row on a
 * phone. Tabs appear only where the viewer holds the matching permission.
 */
const TABS = [
  { href: "/admin", label: "Overview", need: "any" },
  { href: "/admin/users", label: "Users", need: "users" },
  { href: "/admin/roles", label: "Roles and permissions", need: "configure" },
  { href: "/admin/overrides", label: "Overrides and approvals", need: "users" },
  { href: "/admin/organisation", label: "Offices and departments", need: "configure" },
  { href: "/admin/features", label: "Features", need: "configure" },
  { href: "/admin/recycle-bin", label: "Recycle bin", need: "users" },
  { href: "/admin/audit", label: "Audit trail", need: "audit" },
] as const;

export function AdminTabs({
  canUsers,
  canConfigure,
  canAudit,
}: {
  canUsers: boolean;
  canConfigure: boolean;
  canAudit: boolean;
}) {
  const pathname = usePathname();

  const visible = TABS.filter((tab) => {
    if (tab.need === "any") return true;
    if (tab.need === "users") return canUsers;
    if (tab.need === "configure") return canConfigure;
    return canAudit;
  });

  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);

  return (
    <nav aria-label="Administration sections" className="no-scrollbar overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-line">
        {visible.map((tab) => {
          const active = isActive(tab.href);
          return (
            <li key={tab.href}>
              <AppLink
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`-mb-px block border-b-2 px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                  active
                    ? "border-signal text-signal-dark"
                    : "border-transparent text-muted hover:border-line-strong hover:text-body"
                }`}
              >
                {tab.label}
              </AppLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

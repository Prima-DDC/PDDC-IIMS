import "server-only";
import { canAll, type Actor } from "@/lib/auth/session";
import type { NavIconName } from "@/components/nav-icons";

/**
 * Navigation, built on the server from the signed-in user's effective
 * permissions.
 *
 * The point is that the menu can never offer a destination that would then
 * return 403. Items carry an icon NAME rather than a component, because this
 * crosses the server/client boundary into BottomNavBar.
 */

export interface NavEntry {
  href: string;
  label: string;
  icon: NavIconName;
  /** Permission required to see it. Absent means always visible. */
  requires?: { resource: string; action: string };
  /** Shown in the mobile bottom bar rather than the More sheet. */
  primary?: boolean;
}

const ENTRIES: NavEntry[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard", primary: true },
  {
    href: "/cases",
    label: "Cases",
    icon: "cases",
    requires: { resource: "cases", action: "view" },
    primary: true,
  },
  {
    href: "/tasks",
    label: "Tasks",
    icon: "tasks",
    requires: { resource: "tasks", action: "view" },
    primary: true,
  },
  {
    href: "/evidence",
    label: "Evidence",
    icon: "evidence",
    requires: { resource: "evidence", action: "view" },
    primary: true,
  },
  {
    href: "/documents",
    label: "Documents",
    icon: "documents",
    requires: { resource: "documents", action: "view" },
  },
  {
    href: "/sources",
    label: "Sources",
    icon: "sources",
    requires: { resource: "sources", action: "view" },
  },
  {
    href: "/information",
    label: "Information",
    icon: "information",
    requires: { resource: "information", action: "view" },
  },
  {
    href: "/findings",
    label: "Findings",
    icon: "findings",
    requires: { resource: "findings", action: "view" },
  },
  {
    href: "/reports",
    label: "Reports",
    icon: "reports",
    requires: { resource: "reports", action: "view" },
  },
  {
    href: "/clients",
    label: "Clients",
    icon: "clients",
    requires: { resource: "clients", action: "view" },
  },
  {
    href: "/intake",
    label: "Intake",
    icon: "intake",
    requires: { resource: "clients", action: "view" },
  },
  {
    href: "/engagements",
    label: "Engagements",
    icon: "engagements",
    requires: { resource: "engagements", action: "view" },
  },
  {
    href: "/entities",
    label: "Subjects",
    icon: "entities",
    requires: { resource: "entities", action: "view" },
  },
  {
    href: "/safety",
    label: "Safety",
    icon: "safety",
    requires: { resource: "cases", action: "view" },
  },
  {
    href: "/admin",
    label: "Administration",
    icon: "users",
    requires: { resource: "users", action: "view" },
  },
  {
    href: "/admin/audit",
    label: "Audit trail",
    icon: "audit",
    requires: { resource: "audit", action: "view" },
  },
];

export interface Navigation {
  all: NavEntry[];
  /** Up to five for the bottom bar; the rest go in the More sheet. */
  primary: NavEntry[];
  secondary: NavEntry[];
}

export async function buildNavigation(actor: Actor): Promise<Navigation> {
  const checks = ENTRIES.filter((e) => e.requires).map((e) => e.requires!);
  // One round trip for every permission the menu needs (PRD 21.4).
  const allowed = await canAll(actor, checks);

  const visible = ENTRIES.filter(
    (e) => !e.requires || allowed[`${e.requires.resource}:${e.requires.action}`],
  );

  const primary = visible.filter((e) => e.primary).slice(0, 5);
  const secondary = visible.filter((e) => !primary.includes(e));

  return { all: visible, primary, secondary };
}

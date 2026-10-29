import { AppLink } from "@/components/AppLink";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { canAll, requireActor } from "@/lib/auth/session";
import { AdminTabs } from "@/features/admin-users/AdminTabs";

/**
 * Administration shell.
 *
 * Gated on users:view. Anything stricter is checked per screen and per action,
 * because an HR Manager can administer people without being able to touch
 * roles or settings (PRD 3.1).
 *
 * 404 rather than 403 for someone with no administration rights at all: the
 * existence of the section is not information they need.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor();

  // One round trip for all three, not three concurrent ones. Every query
  // against the hosted database costs a network round trip and a pooler slot,
  // and the pooler is shared with the live primaddc.com site.
  const allowed = await canAll(actor, [
    { resource: "users", action: "view" },
    { resource: "settings", action: "configure" },
    { resource: "audit", action: "view" },
  ]);
  const mayViewUsers = allowed["users:view"];
  const mayConfigure = allowed["settings:configure"];
  const mayViewAudit = allowed["audit:view"];

  if (!mayViewUsers && !mayConfigure && !mayViewAudit) {
    notFound();
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.16em] text-faint uppercase">
          Administration
        </p>
        <AppLink
          href="/admin"
          className="text-xl font-semibold tracking-tight text-body hover:text-signal-dark"
        >
          System management
        </AppLink>
      </div>

      <AdminTabs
        canUsers={mayViewUsers}
        canConfigure={mayConfigure}
        canAudit={mayViewAudit}
      />

      {children}
    </div>
  );
}

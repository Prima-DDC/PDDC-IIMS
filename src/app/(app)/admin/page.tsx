import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { Suspense } from "react";
import {
  ArrowRight,
  Building2,
  ClipboardCheck,
  KeyRound,
  Landmark,
  Scale,
  Settings2,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  Users,
  Workflow,
} from "lucide-react";
import { Alert, Card, PageHeader } from "@/components/ui";
import { canAll, requireActor } from "@/lib/auth/session";
import { getAdminStats } from "@/features/admin-users/queries";

export const metadata: Metadata = { title: "Administration" };

/**
 * Administration overview: every managed area in one place, with the counts
 * that tell an administrator where to look first.
 */
export default async function AdminOverviewPage() {
  const actor = await requireActor();

  // One round trip for all five, not five concurrent ones.
  const allowed = await canAll(actor, [
    { resource: "users", action: "view" },
    { resource: "settings", action: "configure" },
    { resource: "audit", action: "view" },
    { resource: "clients", action: "view" },
    { resource: "conflicts", action: "view" },
    { resource: "cases", action: "view" },
  ]);
  const mayUsers = allowed["users:view"];
  const mayConfigure = allowed["settings:configure"];
  const mayAudit = allowed["audit:view"];

  return (
    <div className="space-y-6">
      <PageHeader
        title="System management"
        description="Users, roles, permissions, features, organisation units and the audit trail."
      />

      {mayUsers && (
        <Suspense fallback={<StatsSkeleton />}>
          <StatsRow />
        </Suspense>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {mayUsers && (
          <AreaCard
            href="/admin/users"
            icon={Users}
            title="Users"
            body="Add, invite, view, edit, suspend, remove and restore accounts. Roles, clearance, sessions and login history."
          />
        )}
        {mayConfigure && (
          <AreaCard
            href="/admin/roles"
            icon={ShieldCheck}
            title="Roles and permissions"
            body="Create, clone, edit and delete roles. Build permissions from resource, action, scope and classification ceiling."
          />
        )}
        {mayUsers && (
          <AreaCard
            href="/admin/overrides"
            icon={KeyRound}
            title="Overrides and approvals"
            body="Per-user grants and denies with a reason and expiry, plus the pending two-person approvals."
          />
        )}
        {mayConfigure && (
          <AreaCard
            href="/admin/organisation"
            icon={Building2}
            title="Offices and departments"
            body="Countries, offices and departments, with the data-residency notes attached to each jurisdiction."
          />
        )}
        {mayConfigure && (
          <AreaCard
            href="/admin/features"
            icon={Settings2}
            title="Features"
            body="Switch modules and capabilities on or off per role and per user."
          />
        )}
        {allowed["cases:view"] && (
          <AreaCard
            href="/admin/workflows"
            icon={Workflow}
            title="Case lifecycle"
            body="The stages a case moves through, the moves each one allows, and the case types. Configuration rather than code."
          />
        )}
        {allowed["clients:view"] && (
          <AreaCard
            href="/clients"
            icon={Landmark}
            title="Clients and engagements"
            body="The client register, its contacts, documents and KYC checks, and the engagements that work is opened against."
          />
        )}
        {allowed["conflicts:view"] && (
          <AreaCard
            href="/intake/conflicts"
            icon={ShieldQuestion}
            title="Conflict screening"
            body="Every screening run, what was searched for, and what an authorised manager decided. A recorded decision cannot be changed."
          />
        )}
        {mayUsers && (
          <AreaCard
            href="/admin/recycle-bin"
            icon={Trash2}
            title="Recycle bin"
            body="Soft-deleted records. Restore within the retention period, or purge with a second administrator's approval."
          />
        )}
        {mayAudit && (
          <AreaCard
            href="/admin/audit"
            icon={Scale}
            title="Audit trail"
            body="Append-only, hash-chained. Filter by user, action and date, and verify chain integrity."
          />
        )}
      </div>

      <Alert tone="info" title="What administrators cannot do">
        Audit entries and chain-of-custody events are append-only for every
        role, including this one. Corrections are added as new entries. Deleting
        a record is recoverable by default, and permanently purging evidence
        needs a second administrator and is blocked while a legal hold applies.
      </Alert>
    </div>
  );
}

async function StatsRow() {
  const stats = await getAdminStats();

  const cells: Array<{
    label: string;
    value: number;
    tone?: "warn" | "danger";
  }> = [
    { label: "Active", value: stats.active },
    { label: "Invited", value: stats.invited },
    {
      label: "Suspended",
      value: stats.suspended,
      tone: stats.suspended > 0 ? "warn" : undefined,
    },
    {
      label: "Locked out",
      value: stats.lockedOut,
      tone: stats.lockedOut > 0 ? "warn" : undefined,
    },
    {
      label: "Without MFA",
      value: stats.withoutMfa,
      tone: stats.withoutMfa > 0 ? "danger" : undefined,
    },
    { label: "Administrators", value: stats.administrators },
    { label: "In recycle bin", value: stats.deleted },
  ];

  return (
    <Card title="Accounts" description="Across the whole platform.">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
        {cells.map((cell) => (
          <div key={cell.label}>
            <dt className="text-[10.5px] tracking-wide text-faint uppercase">
              {cell.label}
            </dt>
            <dd
              className={`text-2xl font-semibold ${
                cell.tone === "danger"
                  ? "text-danger"
                  : cell.tone === "warn"
                    ? "text-warn"
                    : "text-body"
              }`}
            >
              {cell.value}
            </dd>
          </div>
        ))}
      </dl>

      {stats.withoutMfa > 0 && (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-danger">
          <ClipboardCheck className="size-3.5" aria-hidden="true" />
          {stats.withoutMfa} active account
          {stats.withoutMfa === 1 ? " has" : "s have"} no authenticator enrolled.
          Two-factor authentication is mandatory.
        </p>
      )}
    </Card>
  );
}

function AreaCard({
  href,
  icon: Icon,
  title,
  body,
}: {
  href: string;
  icon: typeof Users;
  title: string;
  body: string;
}) {
  return (
    <AppLink
      href={href}
      className="card group flex flex-col rounded-xl p-4 transition-colors hover:border-signal/40"
    >
      <span className="grid size-9 place-items-center rounded-lg bg-signal/10 text-signal-dark">
        <Icon className="size-4.5" aria-hidden="true" />
      </span>
      <p className="mt-3 text-sm font-semibold text-body">{title}</p>
      <p className="mt-1 flex-1 text-xs text-muted">{body}</p>
      <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-signal-dark">
        Open
        <ArrowRight
          className="size-3.5 transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </span>
    </AppLink>
  );
}

function StatsSkeleton() {
  return (
    <div className="card rounded-xl p-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="space-y-2">
            <div className="skeleton h-3 w-16" />
            <div className="skeleton h-7 w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}

import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { Suspense } from "react";
import {
  Activity,
  ArrowRight,
  Briefcase,
  CheckSquare,
  ShieldAlert,
} from "lucide-react";
import { Alert, Badge, Card, DescriptionList, PageHeader } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { CLASSIFICATION_LABELS } from "@/modules/iam";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * Role dashboard.
 *
 * Widgets load independently inside their own Suspense boundary, so one slow
 * query never blocks the page (PRD 11). The full widget set per role arrives
 * with the dashboards milestone; what is here now is wired to real data and
 * real permissions rather than placeholder numbers.
 */
export default async function DashboardPage() {
  const actor = await requireActor();

  const [maySeeUsers, maySeeCases, maySeeTasks] = await Promise.all([
    can(actor, "users", "view"),
    can(actor, "cases", "view"),
    can(actor, "tasks", "view"),
  ]);

  const firstName = actor.fullName?.split(" ")[0] ?? "there";

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Good to see you, ${firstName}`}
        description="Your workload, deadlines and anything waiting on you."
      />

      {!actor.mfaEnrolledAt && (
        <Alert tone="warn" title="Two-factor authentication is not set up">
          Every PDDC account must have an authenticator enrolled. Set it up in
          security settings before your next sign-in.
        </Alert>
      )}

      <Card title="Your access" description="What this account can see and do.">
        <DescriptionList
          items={[
            { label: "Primary role", value: actor.primaryRole ?? "Employee" },
            {
              label: "Clearance",
              value: (
                <Badge tone="signal">
                  {CLASSIFICATION_LABELS[actor.clearance]}
                </Badge>
              ),
            },
            { label: "Office", value: actor.officeName ?? "not set" },
            { label: "Department", value: actor.departmentName ?? "not set" },
            { label: "Employee number", value: actor.employeeId ?? "not set" },
            {
              label: "Session",
              value: `${actor.aal === "aal2" ? "Two-factor verified" : "Password only"}, times out after ${actor.sessionTimeoutMinutes} minutes`,
            },
          ]}
        />
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {maySeeCases && (
          <QuickLink
            href="/cases"
            icon={Briefcase}
            title="Cases"
            body="Open investigations you are assigned to."
          />
        )}
        {maySeeTasks && (
          <QuickLink
            href="/tasks"
            icon={CheckSquare}
            title="Tasks"
            body="What is due, overdue or blocked."
          />
        )}
        <QuickLink
          href="/safety"
          icon={ShieldAlert}
          title="Safety"
          body="Field check-in and incident reporting."
        />
        {maySeeUsers && (
          <Suspense fallback={<WidgetSkeleton />}>
            <UserAdminWidget />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/**
 * Administration summary. Its own component so its query sits behind a
 * Suspense boundary and does not delay the rest of the page.
 */
async function UserAdminWidget() {
  const actor = await requireActor();
  const { iam } = await import("@/modules/iam");
  const stats = await iam(actor).users.stats();

  return (
    <Card title="Administration" description="Accounts on the platform.">
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Stat label="Active" value={stats.active} />
        <Stat label="Invited" value={stats.invited} />
        <Stat label="Suspended" value={stats.suspended} tone={stats.suspended > 0 ? "warn" : undefined} />
        <Stat
          label="Without MFA"
          value={stats.withoutMfa}
          tone={stats.withoutMfa > 0 ? "danger" : undefined}
        />
      </dl>

      <AppLink
        href="/admin/users"
        className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-signal-dark hover:underline"
      >
        Manage users
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </AppLink>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warn" | "danger";
}) {
  const colour =
    tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-body";
  return (
    <div>
      <dt className="text-[10.5px] tracking-wide text-faint uppercase">{label}</dt>
      <dd className={`text-xl font-semibold ${colour}`}>{value}</dd>
    </div>
  );
}

function QuickLink({
  href,
  icon: Icon,
  title,
  body,
}: {
  href: string;
  icon: typeof Activity;
  title: string;
  body: string;
}) {
  return (
    <AppLink
      href={href}
      className="card group rounded-xl p-4 transition-colors hover:border-signal/40"
    >
      <span className="grid size-9 place-items-center rounded-lg bg-signal/10 text-signal-dark">
        <Icon className="size-4.5" aria-hidden="true" />
      </span>
      <p className="mt-3 text-sm font-semibold text-body">{title}</p>
      <p className="mt-0.5 text-xs text-muted">{body}</p>
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

function WidgetSkeleton() {
  return (
    <div className="card space-y-3 rounded-xl p-4">
      <div className="skeleton h-3 w-24" />
      <div className="skeleton h-7 w-16" />
      <div className="skeleton h-3 w-full" />
    </div>
  );
}

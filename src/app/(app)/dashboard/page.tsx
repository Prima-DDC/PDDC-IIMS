import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import { Alert, Badge, Card, DescriptionList, PageHeader } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { CLASSIFICATION_LABELS } from "@/modules/iam";
import { getDashboardAccess } from "@/features/dashboard/queries";
import {
  FinanceWidgets,
  ManagementWidgets,
  OperationsWidgets,
  PersonalWidgets,
  QaWidgets,
  QuickLinks,
  TeamWidgets,
  WidgetSkeleton,
} from "@/features/dashboard/DashboardWidgets";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The dashboard (PRD 11, screens 2 and 3).
 *
 * PRD 11 names six dashboards and PRD 16's last row maps each role to one.
 * This is one page that renders the groups of widgets the viewer's
 * permissions entitle them to, which is the same thing for a single-role
 * employee and a better answer for everybody else: a role is data an
 * administrator can rename or re-scope, and somebody holding two roles gets
 * the union of their permissions (PRD 3.2), so they should get the union of
 * their widgets. `src/features/dashboard/queries.ts` sets out the reasoning
 * and the permission behind each group.
 *
 * Every group is its own Suspense boundary, so one slow query never blocks
 * the page: PRD 11's "widgets load lazily and independently", which matters
 * most here because the management group is the heaviest read in the
 * platform and an investigator must not wait for it. They never ask for it
 * either, because the gate is checked before the component is rendered.
 */
export default async function DashboardPage() {
  const actor = await requireActor();

  // There is a permission for this, and PRD 16 gives it to every role, so it
  // is checked rather than assumed: an account provisioned with a custom role
  // that withholds it should land on a refusal, not a blank page.
  if (!(await can(actor, "dashboards", "view"))) {
    forbidden();
  }

  const access = await getDashboardAccess(actor);
  const firstName = actor.fullName?.split(" ")[0] ?? "there";

  const quickLinks = [
    access.mayViewCases && {
      href: "/cases",
      label: "Cases",
      body: "Open investigations you are authorised for.",
    },
    access.mayViewTasks && {
      href: "/tasks",
      label: "Tasks",
      body: "What is due, overdue or blocked.",
    },
    {
      href: "/safety",
      label: "Safety",
      body: "Field check-in and incident reporting.",
    },
    access.mayViewReports && {
      href: "/reports",
      label: "Reports",
      body: "Drafts, reviews and approved versions.",
    },
    access.mayViewUsers && {
      href: "/admin/users",
      label: "Administration",
      body: "Accounts, roles and access.",
    },
  ].filter((item): item is { href: string; label: string; body: string } =>
    Boolean(item),
  );

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

      {/*
        Personal first, for everybody including the CEO. Whatever else
        somebody is responsible for, the first question a dashboard should
        answer is what is waiting on them personally.
      */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense fallback={<WidgetSkeleton rows={2} />}>
          <PersonalWidgets />
        </Suspense>
      </div>

      {access.groups.includes("operations") && (
        <Section title="Operations">
          <Suspense fallback={<WidgetSkeleton rows={3} />}>
            <OperationsWidgets />
          </Suspense>
        </Section>
      )}

      {access.groups.includes("team") && (
        <Section title="Your team">
          <Suspense fallback={<WidgetSkeleton rows={3} />}>
            <TeamWidgets />
          </Suspense>
        </Section>
      )}

      {access.groups.includes("qa") && (
        <Section title="Quality assurance">
          <Suspense fallback={<WidgetSkeleton rows={3} />}>
            <QaWidgets />
          </Suspense>
        </Section>
      )}

      {access.groups.includes("management") && (
        <Section title="Management">
          <Suspense fallback={<WidgetSkeleton rows={4} />}>
            <ManagementWidgets />
          </Suspense>
        </Section>
      )}

      {access.groups.includes("finance") && (
        <Section title="Finance">
          <Suspense fallback={<WidgetSkeleton rows={3} />}>
            <FinanceWidgets />
          </Suspense>
        </Section>
      )}

      <QuickLinks items={quickLinks} />

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
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-[11px] font-semibold tracking-[0.08em] text-faint uppercase">
        {title}
      </h2>
      <div className="grid gap-4 lg:grid-cols-2">{children}</div>
    </section>
  );
}

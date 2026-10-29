import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import { Alert, ButtonLink, Card, PageHeader, TableSkeleton } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { getManagementReport } from "@/features/reporting/queries";
import {
  CaseRegisterTable,
  CommercialsTable,
  ManagementSummary,
  OverdueTable,
  TurnaroundCard,
  WorkloadTable,
} from "@/features/reporting/ManagementViews";

export const metadata: Metadata = { title: "Management reports" };

type Params = { since?: string };

/**
 * Management reports (PRD 10.4).
 *
 * The six figures PRD 10.4 names, read together because that is how a manager
 * reads them. Every one goes through row-level security, so this is what THIS
 * manager may see rather than the firm's totals, and the page says so: a
 * number presented as a total when it is a filtered subset is worse than no
 * number.
 */
export default async function ManagementReportsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  // Reading across the firm is what `export` distinguishes from being able to
  // read one report: PRD 10.4 says these are exportable with permission
  // checks applied.
  if (!(await can(actor, "reports", "export"))) {
    forbidden();
  }

  const params = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Management reports"
        description="The case register, turnaround, workload, overdue work, QA return rate and revenue against cost."
        breadcrumb={[{ label: "Reports", href: "/reports" }, { label: "Management" }]}
        actions={
          <ButtonLink href="/api/export/management" size="sm" tone="ghost">
            Export as CSV
          </ButtonLink>
        }
      />

      <Alert tone="info" title="What these numbers are">
        What you may see, not the firm&apos;s totals. Every figure is read
        through the same row-level security as every other screen, so a
        colleague with a different scope will legitimately see different
        numbers. The export applies the same rules.
      </Alert>

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <Figures params={params} />
      </Suspense>
    </div>
  );
}

async function Figures({ params }: { params: Params }) {
  const report = await getManagementReport({ since: params.since });

  return (
    <div className="space-y-5">
      <ManagementSummary report={report} />
      <TurnaroundCard report={report} />

      <Card
        title="Workload"
        description="Open cases and tasks per person, counted from live assignments."
      >
        <WorkloadTable report={report} />
      </Card>

      <Card
        title="Overdue work"
        description="Open tasks past their due date, soonest first."
      >
        <OverdueTable report={report} />
      </Card>

      <Card
        title="Revenue against cost"
        description="Billed is what was invoiced, not what was quoted: a quote is an intention. Cost is approved expenses."
      >
        <CommercialsTable report={report} />
      </Card>

      <Card
        title="Case register"
        description="Every case you can reach, newest first."
      >
        <CaseRegisterTable report={report} />
      </Card>
    </div>
  );
}

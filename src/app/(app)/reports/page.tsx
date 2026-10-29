import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import {
  Card,
  FiltersSkeleton,
  PageHeader,
  Pagination,
  StatTile,
  TableSkeleton,
} from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { listReports } from "@/features/reporting/queries";
import { ReportFilters } from "@/features/reporting/ReportFilters";
import { ReportTable } from "@/features/reporting/ReportViews";

export const metadata: Metadata = { title: "Reports" };

type Params = {
  search?: string;
  status?: string;
  queue?: string;
  page?: string;
};

/**
 * Reports across every case this person can reach (PRD 10, screen 18).
 *
 * A report is written on its case, where the findings and exhibits it cites
 * already are. This screen is for reading across cases and, more usefully,
 * for finding what is waiting on you: `?queue=mine` is the reviewer's list.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "reports", "view"))) {
    forbidden();
  }

  const params = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        description="What PDDC has written, where each one is in its review, and what is waiting on you."
      />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <Register params={params} />
      </Suspense>
    </div>
  );
}

async function Register({ params }: { params: Params }) {
  const result = await listReports({
    search: params.search,
    status: params.status,
    awaitingReview: params.queue === "mine",
    page: params.page ? Number(params.page) : 1,
  });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Reports" value={result.summary.total} />
        <StatTile label="Drafts" value={result.summary.drafts} />
        <StatTile
          label="In review"
          value={result.summary.inReview}
          tone={result.summary.inReview > 0 ? "warn" : "neutral"}
          href="/reports?queue=mine"
        />
        <StatTile
          label="Delivered"
          value={result.summary.delivered}
          tone="ok"
        />
      </div>

      {params.queue === "mine" && (
        <p className="text-xs text-muted">
          Reports at a review stage that somebody other than their author has
          to move on.{" "}
          <AppLink href="/reports" className="text-signal-dark hover:underline">
            Show all reports
          </AppLink>
        </p>
      )}

      <Suspense fallback={<FiltersSkeleton selects={2} />}>
        <ReportFilters />
      </Suspense>

      {result.rows.length === 0 ? (
        <ReportTable reports={result.rows} />
      ) : (
        <Card>
          <ReportTable reports={result.rows} />
          <Pagination
            basePath="/reports"
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            params={params}
            unit="report"
          />
        </Card>
      )}
    </div>
  );
}

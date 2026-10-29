import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import {
  Alert,
  Card,
  EmptyState,
  FiltersSkeleton,
  PageHeader,
  Pagination,
  StatTile,
  TableSkeleton,
} from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { listFindings } from "@/features/intel/queries";
import { FindingFilters } from "@/features/intel/IntelFilters";
import { FindingCard } from "@/features/intel/IntelViews";

export const metadata: Metadata = { title: "Findings" };

type Params = {
  search?: string;
  status?: string;
  page?: string;
};

/**
 * Findings and analysis (PRD 15, screen 17).
 *
 * Cards rather than a table: a finding is a sentence somebody has to read, and
 * a conclusion truncated into a table cell is a conclusion nobody reads.
 */
export default async function FindingsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "findings", "view"))) {
    forbidden();
  }

  const params = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Findings"
        description="The conclusions PDDC has reached, each resting on the information and evidence behind it."
      />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={6} />}>
        <Register params={params} />
      </Suspense>
    </div>
  );
}

async function Register({ params }: { params: Params }) {
  const result = await listFindings({
    search: params.search,
    status: params.status,
    page: params.page ? Number(params.page) : 1,
  });

  return (
    <div className="space-y-5">
      {result.summary.unsupported > 0 && (
        <Alert tone="warn" title="A finding rests on nothing">
          {result.summary.unsupported}{" "}
          {result.summary.unsupported === 1 ? "finding has" : "findings have"} no
          information or evidence linked, so they cannot be put forward for
          review. A conclusion that cannot be traced back is one PDDC cannot
          defend if the report is challenged.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Findings" value={result.summary.total} />
        <StatTile label="Accepted" value={result.summary.accepted} tone="ok" />
        <StatTile
          label="Awaiting review"
          value={result.summary.awaitingReview}
          tone={result.summary.awaitingReview > 0 ? "warn" : "neutral"}
          href="/findings?status=submitted"
        />
        <StatTile
          label="Rest on nothing"
          value={result.summary.unsupported}
          tone={result.summary.unsupported > 0 ? "danger" : "ok"}
        />
      </div>

      <Suspense fallback={<FiltersSkeleton selects={1} />}>
        <FindingFilters />
      </Suspense>

      {result.rows.length === 0 ? (
        <EmptyState
          title="No findings match those filters"
          description="A finding is drafted on its case, where the information and evidence it rests on already are."
        />
      ) : (
        <>
          <ul className="space-y-3">
            {result.rows.map((finding) => (
              <li key={finding.id}>
                <FindingCard finding={finding} />
              </li>
            ))}
          </ul>
          <Card>
            <Pagination
              basePath="/findings"
              page={result.page}
              pageCount={result.pageCount}
              total={result.total}
              params={params}
              unit="finding"
            />
          </Card>
        </>
      )}
    </div>
  );
}

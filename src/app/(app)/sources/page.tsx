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
import { listSources } from "@/features/intel/queries";
import { SourceFilters } from "@/features/intel/IntelFilters";
import { SourceTable } from "@/features/intel/IntelViews";

export const metadata: Metadata = { title: "Sources" };

type Params = {
  search?: string;
  sourceType?: string;
  reliability?: string;
  page?: string;
};

/**
 * The source register across every case this person can reach (PRD 6.4).
 *
 * Sources are recorded on their case, because a source is a particular
 * acquisition of material: which search, on what day, by whom. This screen is
 * for reading across cases, which is how a source that has been used before
 * is recognised.
 */
export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "sources", "view"))) {
    forbidden();
  }

  const params = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sources"
        description="Where the material came from, and how far each source can be relied on. Rated separately from what it said."
      />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <Register params={params} />
      </Suspense>
    </div>
  );
}

async function Register({ params }: { params: Params }) {
  const result = await listSources({
    search: params.search,
    sourceType: params.sourceType,
    sourceReliability: params.reliability,
    page: params.page ? Number(params.page) : 1,
  });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Sources" value={result.summary.total} />
        <StatTile label="Reliable" value={result.summary.reliable} tone="ok" />
        <StatTile label="Human sources" value={result.summary.humanSources} />
        <StatTile
          label="Not verified"
          value={result.summary.unverified}
          tone={result.summary.unverified > 0 ? "warn" : "ok"}
        />
      </div>

      <Suspense fallback={<FiltersSkeleton selects={2} />}>
        <SourceFilters />
      </Suspense>

      {result.rows.length === 0 ? (
        <SourceTable sources={result.rows} />
      ) : (
        <Card>
          <SourceTable sources={result.rows} />
          <Pagination
            basePath="/sources"
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            params={params}
            unit="source"
          />
        </Card>
      )}
    </div>
  );
}

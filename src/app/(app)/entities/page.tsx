import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import {
  Alert,
  Card,
  FiltersSkeleton,
  PageHeader,
  Pagination,
  StatTile,
  TableSkeleton,
} from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { listEntities } from "@/features/intel/queries";
import { EntityFilters } from "@/features/intel/IntelFilters";
import { EntityTable } from "@/features/intel/IntelViews";

export const metadata: Metadata = { title: "Subjects and entities" };

type Params = {
  search?: string;
  entityType?: string;
  resolution?: string;
  flagged?: string;
  page?: string;
};

/**
 * The entity register (PRD 15, screen 10).
 *
 * Not case-scoped, which is the point: the same company appears in several
 * investigations and being able to say so is most of the register's value. A
 * subject is attached to a case on the case's own Subjects tab, because that
 * is where the part it plays belongs.
 */
export default async function EntitiesPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "entities", "view"))) {
    forbidden();
  }

  const params = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Subjects and entities"
        description="The people, companies and assets PDDC has investigated, what they are known as, and how they connect."
      />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <Register params={params} />
      </Suspense>
    </div>
  );
}

async function Register({ params }: { params: Params }) {
  const result = await listEntities({
    search: params.search,
    entityType: params.entityType,
    resolutionStatus: params.resolution,
    flaggedOnly: params.flagged === "open",
    page: params.page ? Number(params.page) : 1,
  });

  return (
    <div className="space-y-5">
      {result.summary.openFlags > 0 && (
        <Alert tone="warn" title="Records that may be the same thing">
          {result.summary.openFlags}{" "}
          {result.summary.openFlags === 1 ? "pair is" : "pairs are"} waiting for a
          decision. Nothing is ever merged automatically, and a merge can be
          reversed.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Subjects" value={result.summary.total} />
        <StatTile label="People" value={result.summary.people} />
        <StatTile label="Companies" value={result.summary.companies} />
        <StatTile
          label="To decide"
          value={result.summary.openFlags}
          tone={result.summary.openFlags > 0 ? "warn" : "ok"}
          href="/entities?flagged=open"
        />
      </div>

      <Suspense fallback={<FiltersSkeleton selects={3} />}>
        <EntityFilters />
      </Suspense>

      {result.rows.length === 0 ? (
        <EntityTable entities={result.rows} />
      ) : (
        <Card>
          <EntityTable entities={result.rows} />
          <Pagination
            basePath="/entities"
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            params={params}
            unit="subject"
          />
        </Card>
      )}
    </div>
  );
}

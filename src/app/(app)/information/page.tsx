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
import { listInformation } from "@/features/intel/queries";
import { InformationFilters } from "@/features/intel/IntelFilters";
import { InformationTable } from "@/features/intel/IntelViews";

export const metadata: Metadata = { title: "Information" };

type Params = {
  search?: string;
  credibility?: string;
  corroboration?: string;
  page?: string;
};

/**
 * The information register (PRD 6.4, screen 14).
 *
 * The one list in the platform where the distinction PRD 6.4 draws is most
 * visible: a column of reliable sources next to a column of unverified
 * statements is an honest picture of where the work stands.
 */
export default async function InformationPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "information", "view"))) {
    forbidden();
  }

  const params = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Information"
        description="What each source said, and how far it is borne out. Rated separately from the source itself."
      />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <Register params={params} />
      </Suspense>
    </div>
  );
}

async function Register({ params }: { params: Params }) {
  const result = await listInformation({
    search: params.search,
    credibility: params.credibility,
    uncorroboratedOnly: params.corroboration === "none",
    page: params.page ? Number(params.page) : 1,
  });

  return (
    <div className="space-y-5">
      {result.summary.contradicted > 0 && (
        <Alert tone="danger" title="Something has been contradicted">
          {result.summary.contradicted}{" "}
          {result.summary.contradicted === 1 ? "statement has" : "statements have"} been
          contradicted. Nothing contradicted can be recorded as confirmed, and any
          finding resting on one needs looking at again.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Statements" value={result.summary.total} />
        <StatTile label="Confirmed" value={result.summary.confirmed} tone="ok" />
        <StatTile
          label="Nothing bears out"
          value={result.summary.uncorroborated}
          tone={result.summary.uncorroborated > 0 ? "warn" : "ok"}
          href="/information?corroboration=none"
        />
        <StatTile
          label="Contradicted"
          value={result.summary.contradicted}
          tone={result.summary.contradicted > 0 ? "danger" : "ok"}
        />
      </div>

      <Suspense fallback={<FiltersSkeleton selects={2} />}>
        <InformationFilters />
      </Suspense>

      {result.rows.length === 0 ? (
        <InformationTable information={result.rows} />
      ) : (
        <Card>
          <InformationTable information={result.rows} />
          <Pagination
            basePath="/information"
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            params={params}
            unit="statement"
          />
        </Card>
      )}
    </div>
  );
}

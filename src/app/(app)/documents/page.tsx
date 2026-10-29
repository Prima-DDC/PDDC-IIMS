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
import { listDocuments } from "@/features/documents/queries";
import { DocumentFilters } from "@/features/documents/DocumentFilters";
import { DocumentTable } from "@/features/documents/DocumentViews";

export const metadata: Metadata = { title: "Documents" };

type Params = {
  search?: string;
  documentType?: string;
  tag?: string;
  approval?: string;
  page?: string;
};

/**
 * The document library across every case this person can reach (PRD 7.3).
 *
 * Filing a document happens on its case, for the same reason evidence does:
 * the folder structure, the classification and the identifier all come from
 * the case it belongs to.
 */
export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "documents", "view"))) {
    forbidden();
  }

  const params = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Documents"
        description="Everything filed against a case, which version is in force, and what is still waiting on an approval."
      />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <Library params={params} />
      </Suspense>
    </div>
  );
}

async function Library({ params }: { params: Params }) {
  const result = await listDocuments({
    search: params.search,
    documentType: params.documentType,
    tag: params.tag,
    approvedOnly: params.approval === "approved",
    page: params.page ? Number(params.page) : 1,
  });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <StatTile label="Documents" value={result.summary.total} />
        <StatTile
          label="Approved"
          value={result.summary.approved}
          href="/documents?approval=approved"
        />
        <StatTile
          label="Awaiting approval"
          value={result.summary.drafts}
          tone={result.summary.drafts > 0 ? "warn" : "ok"}
        />
      </div>

      <Suspense fallback={<FiltersSkeleton selects={3} />}>
        <DocumentFilters tags={result.tags} />
      </Suspense>

      {result.rows.length === 0 ? (
        <DocumentTable documents={result.rows} />
      ) : (
        <Card>
          <DocumentTable documents={result.rows} />
          <Pagination
            basePath="/documents"
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            params={params}
            unit="document"
          />
        </Card>
      )}
    </div>
  );
}

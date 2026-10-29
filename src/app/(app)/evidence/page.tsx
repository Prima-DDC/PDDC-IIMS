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
import { listEvidence } from "@/features/evidence/queries";
import { EvidenceFilters } from "@/features/evidence/EvidenceFilters";
import { EvidenceTable } from "@/features/evidence/EvidenceViews";

export const metadata: Metadata = { title: "Evidence" };

type Params = {
  search?: string;
  evidenceType?: string;
  status?: string;
  copyStatus?: string;
  integrity?: string;
  page?: string;
};

/**
 * The evidence register across every case this person can reach (PRD 6.1).
 *
 * Registering an item happens on its case, because an item without a case has
 * nowhere to belong and no identifier: the EV-YYYY-CCCCCC-NNN format carries
 * the case number.
 */
export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "evidence", "view"))) {
    forbidden();
  }

  const params = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Evidence"
        description="What PDDC holds, who holds it, and whether each file still matches what was collected."
      />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <Register params={params} />
      </Suspense>
    </div>
  );
}

async function Register({ params }: { params: Params }) {
  const result = await listEvidence({
    search: params.search,
    evidenceType: params.evidenceType,
    status: params.status,
    copyStatus: params.copyStatus,
    integrityConcernsOnly: params.integrity === "concerns",
    page: params.page ? Number(params.page) : 1,
  });

  return (
    <div className="space-y-5">
      {result.summary.mismatched > 0 && (
        <Alert tone="danger" title="An item failed its integrity check">
          {result.summary.mismatched}{" "}
          {result.summary.mismatched === 1 ? "item does" : "items do"} not match the
          hash recorded when collected. Nothing that fails this check can be cited
          in a report until it is resolved.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Items" value={result.summary.total} />
        <StatTile label="Originals" value={result.summary.originals} />
        <StatTile label="Working copies" value={result.summary.workingCopies} />
        <StatTile
          label="Awaiting verification"
          value={result.summary.awaitingVerification}
          tone={result.summary.awaitingVerification > 0 ? "warn" : "ok"}
          href="/evidence?integrity=concerns"
        />
        <StatTile
          label="Out on release"
          value={result.summary.released}
          tone={result.summary.released > 0 ? "warn" : "neutral"}
          href="/evidence?status=released"
        />
      </div>

      <Suspense fallback={<FiltersSkeleton selects={4} />}>
        <EvidenceFilters />
      </Suspense>

      {result.rows.length === 0 ? (
        <EvidenceTable items={result.rows} />
      ) : (
        <Card>
          <EvidenceTable items={result.rows} />
          <Pagination
            basePath="/evidence"
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            params={params}
            unit="item"
          />
        </Card>
      )}
    </div>
  );
}

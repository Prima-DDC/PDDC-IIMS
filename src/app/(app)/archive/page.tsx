import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import { Lock } from "lucide-react";
import {
  Alert,
  Card,
  EmptyState,
  Id,
  Muted,
  PageHeader,
  Pagination,
  Table,
  TableSkeleton,
  Td,
  Th,
} from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { listArchive } from "@/features/reporting/queries";
import { RiskLevelBadge } from "@/features/cases/CaseBadges";

export const metadata: Metadata = { title: "Archive" };

type Params = { search?: string; page?: string };

/**
 * The archive (screen 21).
 *
 * Deliberately not a separate store. An archived case is a closed case whose
 * closure was approved, and it is read with exactly the same code and the
 * same row-level security as any other: that is what makes it searchable
 * rather than a pile of files nobody can find anything in. The read-only part
 * is not enforced here either, it is enforced where it belongs, by the case
 * lifecycle refusing to move a case out of its terminal stage.
 */
export default async function ArchivePage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "cases", "view"))) {
    forbidden();
  }

  const params = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Archive"
        description="Closed cases, kept for their retention period. Readable and searchable; nothing on them can change."
      />

      <Alert tone="info" title="What the archive is">
        A closed case, not a copy of one. It is the same record, read with the
        same permissions, which is why searching it works and why an audit
        trail from four years ago still names the people who did the work.
        Legal holds and the retention clock are administered under
        Administration.
      </Alert>

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <Archive params={params} />
      </Suspense>
    </div>
  );
}

async function Archive({ params }: { params: Params }) {
  const result = await listArchive({
    search: params.search,
    page: params.page ? Number(params.page) : 1,
  });

  if (result.rows.length === 0) {
    return (
      <EmptyState
        title="Nothing archived yet"
        description="A case reaches the archive when its closure is approved, which is the last step of PRD 5.9."
      />
    );
  }

  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <Th>Case</Th>
            <Th>Client</Th>
            <Th>Risk</Th>
            <Th>Retention</Th>
            <Th className="text-right">Closed</Th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((record) => (
            <tr key={record.id} className="transition-colors hover:bg-surface-sunken/60">
              <Td>
                <AppLink
                  href={`/cases/${record.id}`}
                  className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
                >
                  {record.title}
                </AppLink>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Id>{record.caseId}</Id>
                  <Lock className="size-3 text-faint" aria-hidden="true" />
                </span>
              </Td>
              <Td className="text-xs text-muted">{record.clientName}</Td>
              <Td>
                <RiskLevelBadge level={record.riskLevel} />
              </Td>
              <Td className="text-xs text-muted">
                {record.retentionClass ?? <Muted>not set</Muted>}
              </Td>
              <Td className="text-right text-xs whitespace-nowrap text-muted">
                {record.closedAt
                  ? new Date(record.closedAt).toLocaleDateString("en-GB")
                  : "unknown"}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Pagination
        basePath="/archive"
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        params={params}
        unit="case"
      />
    </Card>
  );
}

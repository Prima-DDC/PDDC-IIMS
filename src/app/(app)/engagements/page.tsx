import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import { Briefcase } from "lucide-react";
import {
  ButtonLink,
  Card,
  EmptyState,
  FiltersSkeleton,
  Id,
  Muted,
  NotSet,
  PageHeader,
  Pagination,
  Table,
  TableSkeleton,
  Td,
  Th,
} from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { ENGAGEMENT_TYPE_LABELS } from "@/modules/crm";
import { listEngagements } from "@/features/engagements/queries";
import { EngagementFilters } from "@/features/engagements/EngagementFilters";
import {
  ConflictBadge,
  EngagementStatusBadge,
} from "@/features/clients/ClientBadges";

export const metadata: Metadata = { title: "Engagements" };

type Params = {
  search?: string;
  status?: string;
  engagementType?: string;
  clientId?: string;
  responsibleManagerId?: string;
  sort?: string;
  page?: string;
};

export default async function EngagementsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "engagements", "view"))) {
    forbidden();
  }

  const params = await searchParams;
  const mayCreate = await can(actor, "engagements", "create");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Engagements"
        description="The instructions PDDC has taken on. An engagement carries the scope and the commercial terms, and cases are opened against it rather than against the client."
        actions={
          mayCreate ? (
            <ButtonLink href="/engagements/new" tone="primary" size="sm">
              <Briefcase className="size-4" aria-hidden="true" />
              New engagement
            </ButtonLink>
          ) : undefined
        }
      />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <EngagementList params={params} />
      </Suspense>
    </div>
  );
}

async function EngagementList({ params }: { params: Params }) {
  const result = await listEngagements({
    search: params.search,
    status: params.status,
    engagementType: params.engagementType,
    clientId: params.clientId,
    responsibleManagerId: params.responsibleManagerId,
    sort: params.sort,
    page: params.page ? Number(params.page) : 1,
  });

  return (
    <div className="space-y-5">
      <Suspense fallback={<FiltersSkeleton selects={4} />}>
        <EngagementFilters clients={result.clients} managers={result.managers} />
      </Suspense>

      {result.rows.length === 0 ? (
        <EmptyState
          title="No engagements match those filters"
          description="Clear the filters, or record the instruction a client has given."
          action={
            result.can.create ? (
              <ButtonLink href="/engagements/new" tone="primary" size="sm">
                <Briefcase className="size-4" aria-hidden="true" />
                New engagement
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Engagement</Th>
                <Th>Client</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Conflict</Th>
                <Th>Responsible</Th>
                <Th className="text-right">Starts</Th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((engagement) => (
                <tr
                  key={engagement.id}
                  className="transition-colors hover:bg-surface-sunken/60"
                >
                  <Td>
                    <AppLink
                      href={`/engagements/${engagement.id}`}
                      className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
                    >
                      {engagement.title}
                    </AppLink>
                    <Id>{engagement.engagementId}</Id>
                  </Td>
                  <Td className="text-xs">
                    <AppLink
                      href={`/clients/${engagement.clientId}`}
                      className="text-signal-dark hover:underline"
                    >
                      {engagement.clientName}
                    </AppLink>
                    <p className="text-[11px] text-faint">
                      {engagement.clientReference}
                    </p>
                  </Td>
                  <Td className="text-xs text-muted">
                    {ENGAGEMENT_TYPE_LABELS[engagement.engagementType]}
                  </Td>
                  <Td>
                    <EngagementStatusBadge status={engagement.status} />
                  </Td>
                  <Td>
                    <ConflictBadge status={engagement.conflictStatus} />
                  </Td>
                  <Td className="text-xs text-muted">
                    {engagement.responsibleManagerName ?? <NotSet />}
                  </Td>
                  <Td className="text-right text-xs whitespace-nowrap text-muted">
                    {engagement.startDate ? (
                      new Date(engagement.startDate).toLocaleDateString("en-GB")
                    ) : (
                      <Muted>not set</Muted>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <Pagination
            basePath="/engagements"
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            params={params}
            unit="engagement"
          />
        </Card>
      )}
    </div>
  );
}

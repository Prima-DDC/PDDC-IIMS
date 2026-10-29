import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import { Building2, UserPlus } from "lucide-react";
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
  StatTile,
  Table,
  TableSkeleton,
  Td,
  Th,
} from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { CLIENT_TYPE_LABELS } from "@/modules/crm";
import { listClients } from "@/features/clients/queries";
import { ClientFilters } from "@/features/clients/ClientFilters";
import {
  ClientStatusBadge,
  KycBadge,
  RiskBadge,
} from "@/features/clients/ClientBadges";

export const metadata: Metadata = { title: "Clients" };

type Params = {
  search?: string;
  status?: string;
  clientType?: string;
  kycStatus?: string;
  riskRating?: string;
  accountManagerId?: string;
  sort?: string;
  page?: string;
};

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "clients", "view"))) {
    forbidden();
  }

  const params = await searchParams;
  const mayCreate = await can(actor, "clients", "create");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Clients"
        description="The organisations PDDC works for. Every client has a KYC position and a risk rating, and work hangs off an engagement rather than off the client directly."
        actions={
          mayCreate ? (
            <ButtonLink href="/clients/new" tone="primary" size="sm">
              <UserPlus className="size-4" aria-hidden="true" />
              New client
            </ButtonLink>
          ) : undefined
        }
      />

      {/* Each block loads on its own, so a slow count never holds up the list. */}
      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <ClientList params={params} />
      </Suspense>
    </div>
  );
}

async function ClientList({ params }: { params: Params }) {
  const result = await listClients({
    search: params.search,
    status: params.status,
    clientType: params.clientType,
    kycStatus: params.kycStatus,
    riskRating: params.riskRating,
    accountManagerId: params.accountManagerId,
    sort: params.sort,
    page: params.page ? Number(params.page) : 1,
  });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Clients" value={result.summary.total} />
        <StatTile label="Active" value={result.summary.active} tone="ok" />
        <StatTile label="Prospects" value={result.summary.prospects} />
        <StatTile
          label="KYC outstanding"
          value={result.summary.kycOutstanding}
          tone={result.summary.kycOutstanding > 0 ? "warn" : "ok"}
          href="/clients?kycStatus=in_progress"
        />
        <StatTile
          label="High risk"
          value={result.summary.highRisk}
          tone={result.summary.highRisk > 0 ? "warn" : "neutral"}
          href="/clients?riskRating=high"
        />
      </div>

      <Suspense fallback={<FiltersSkeleton selects={5} />}>
        <ClientFilters managers={result.managers} />
      </Suspense>

      {result.rows.length === 0 ? (
        <EmptyState
          title="No clients match those filters"
          description="Clear the filters, or add the organisation that made the enquiry."
          action={
            result.can.create ? (
              <ButtonLink href="/clients/new" tone="primary" size="sm">
                <Building2 className="size-4" aria-hidden="true" />
                Add a client
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Client</Th>
                <Th>Type</Th>
                <Th>KYC</Th>
                <Th>Risk</Th>
                <Th>Status</Th>
                <Th>Account manager</Th>
                <Th className="text-right">Engagements</Th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((client) => (
                <tr
                  key={client.id}
                  className="transition-colors hover:bg-surface-sunken/60"
                >
                  <Td>
                    <AppLink
                      href={`/clients/${client.id}`}
                      className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
                    >
                      {client.organisationName}
                    </AppLink>
                    <Id>{client.clientId}</Id>
                  </Td>
                  <Td className="text-xs text-muted">
                    {CLIENT_TYPE_LABELS[client.clientType]}
                    {client.countryName && (
                      <p className="text-[11px] text-faint">{client.countryName}</p>
                    )}
                  </Td>
                  <Td>
                    <KycBadge status={client.kycStatus} />
                  </Td>
                  <Td>
                    <RiskBadge rating={client.riskRating} />
                  </Td>
                  <Td>
                    <ClientStatusBadge status={client.status} />
                  </Td>
                  <Td className="text-xs text-muted">
                    {client.accountManagerName ?? <NotSet />}
                  </Td>
                  <Td className="text-right text-xs tabular-nums">
                    {client.engagementCount === 0 ? (
                      <Muted>none</Muted>
                    ) : (
                      client.engagementCount
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <Pagination
            basePath="/clients"
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            params={params}
            unit="client"
          />
        </Card>
      )}
    </div>
  );
}

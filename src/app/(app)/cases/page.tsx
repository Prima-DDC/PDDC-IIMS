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
  StatTile,
  Table,
  TableSkeleton,
  Td,
  Th,
} from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { listCases } from "@/features/cases/queries";
import { CaseFilters } from "@/features/cases/CaseFilters";
import {
  DueSoonBadge,
  OverdueBadge,
  PriorityBadge,
  RiskLevelBadge,
  StageBadge,
} from "@/features/cases/CaseBadges";

export const metadata: Metadata = { title: "Cases" };

type Params = {
  search?: string;
  stageKey?: string;
  openness?: string;
  priority?: string;
  riskLevel?: string;
  caseType?: string;
  mine?: string;
  overdueOnly?: string;
  sort?: string;
  page?: string;
};

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "cases", "view"))) {
    forbidden();
  }

  const params = await searchParams;
  const mayCreate = await can(actor, "cases", "create");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Cases"
        description="The investigations themselves. An investigator sees the cases they are assigned to; a supervisor sees them all."
        actions={
          mayCreate ? (
            <ButtonLink href="/cases/new" tone="primary" size="sm">
              <Briefcase className="size-4" aria-hidden="true" />
              Open a case
            </ButtonLink>
          ) : undefined
        }
      />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <CaseList params={params} />
      </Suspense>
    </div>
  );
}

async function CaseList({ params }: { params: Params }) {
  const result = await listCases({
    search: params.search,
    stageKey: params.stageKey,
    openness: params.openness,
    priority: params.priority,
    riskLevel: params.riskLevel,
    caseType: params.caseType,
    mine: params.mine === "1",
    overdueOnly: params.overdueOnly === "1",
    sort: params.sort,
    page: params.page ? Number(params.page) : 1,
  });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Open" value={result.summary.open} />
        <StatTile
          label="Assigned to me"
          value={result.summary.mine}
          href="/cases?mine=1"
        />
        <StatTile
          label="Overdue"
          value={result.summary.overdue}
          tone={result.summary.overdue > 0 ? "danger" : "ok"}
          href="/cases?overdueOnly=1"
        />
        <StatTile
          label="Critical risk"
          value={result.summary.criticalRisk}
          tone={result.summary.criticalRisk > 0 ? "warn" : "neutral"}
          href="/cases?riskLevel=critical"
        />
        <StatTile
          label="Awaiting approval"
          value={result.summary.awaitingApproval}
          tone={result.summary.awaitingApproval > 0 ? "warn" : "neutral"}
        />
      </div>

      <Suspense fallback={<FiltersSkeleton selects={5} />}>
        <CaseFilters stages={result.stages} caseTypes={result.caseTypes} />
      </Suspense>

      {result.rows.length === 0 ? (
        <EmptyState
          title="No cases match those filters"
          description="Clear the filters, or open a case against an approved engagement."
          action={
            result.can.create ? (
              <ButtonLink href="/cases/new" tone="primary" size="sm">
                <Briefcase className="size-4" aria-hidden="true" />
                Open a case
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Case</Th>
                <Th>Client</Th>
                <Th>Stage</Th>
                <Th>Risk</Th>
                <Th>Lead</Th>
                <Th className="text-right">Target</Th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((record) => (
                <tr
                  key={record.id}
                  className="transition-colors hover:bg-surface-sunken/60"
                >
                  <Td>
                    <AppLink
                      href={`/cases/${record.id}`}
                      className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
                    >
                      {record.title}
                    </AppLink>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Id>{record.caseId}</Id>
                      <PriorityBadge priority={record.priority} />
                      <OverdueBadge record={record} />
                      <DueSoonBadge record={record} />
                    </span>
                  </Td>
                  <Td className="text-xs">
                    <AppLink
                      href={`/clients/${record.clientId}`}
                      className="text-signal-dark hover:underline"
                    >
                      {record.clientName}
                    </AppLink>
                    <p className="text-[11px] text-faint">{record.caseTypeName}</p>
                  </Td>
                  <Td>
                    <StageBadge
                      stageName={record.stageName}
                      isTerminal={record.stageIsTerminal}
                    />
                  </Td>
                  <Td>
                    <RiskLevelBadge level={record.riskLevel} />
                  </Td>
                  <Td className="text-xs text-muted">
                    {record.leadInvestigatorName ?? (
                      <Muted>unassigned</Muted>
                    )}
                  </Td>
                  <Td className="text-right text-xs whitespace-nowrap text-muted">
                    {record.targetCompletionAt ? (
                      new Date(record.targetCompletionAt).toLocaleDateString("en-GB")
                    ) : (
                      <NotSet />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <Pagination
            basePath="/cases"
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            params={params}
            unit="case"
          />
        </Card>
      )}
    </div>
  );
}

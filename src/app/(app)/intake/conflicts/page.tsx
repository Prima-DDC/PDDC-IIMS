import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import { ShieldQuestion } from "lucide-react";
import {
  ButtonLink,
  Card,
  EmptyState,
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
import { listConflictChecks } from "@/features/intake/queries";
import { ConflictBadge } from "@/features/clients/ClientBadges";

export const metadata: Metadata = { title: "Conflict checks" };

type Params = { status?: string; page?: string };

export default async function ConflictChecksPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "conflicts", "view"))) {
    forbidden();
  }

  const params = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Conflict checks"
        description="Every screening PDDC has run, with what was searched for and what was decided. A recorded decision cannot be changed, so the trail is the basis a clearance is relied on."
        breadcrumb={[
          { label: "Intake", href: "/intake" },
          { label: "Conflict checks" },
        ]}
        actions={
          <ButtonLink href="/intake/conflicts/new" tone="primary" size="sm">
            <ShieldQuestion className="size-4" aria-hidden="true" />
            Run a check
          </ButtonLink>
        }
      />

      <div className="flex flex-wrap gap-1.5 text-xs">
        {[
          { value: "", label: "All" },
          { value: "open", label: "Awaiting a decision" },
          { value: "cleared", label: "Cleared" },
          { value: "further_review", label: "Further review" },
          { value: "declined", label: "Declined" },
        ].map((tab) => {
          const active = (params.status ?? "") === tab.value;
          return (
            <AppLink
              key={tab.label}
              href={tab.value ? `/intake/conflicts?status=${tab.value}` : "/intake/conflicts"}
              aria-current={active ? "page" : undefined}
              className={`rounded-full border px-3 py-1 font-medium transition-colors ${
                active
                  ? "border-signal bg-signal/10 text-signal-dark"
                  : "border-line text-muted hover:bg-surface-sunken hover:text-body"
              }`}
            >
              {tab.label}
            </AppLink>
          );
        })}
      </div>

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton />}>
        <CheckList params={params} />
      </Suspense>
    </div>
  );
}

async function CheckList({ params }: { params: Params }) {
  const result = await listConflictChecks({
    status: params.status,
    page: params.page ? Number(params.page) : 1,
  });

  if (result.rows.length === 0) {
    return (
      <EmptyState
        title="No conflict checks"
        description="Run one before PDDC commits to any work, from an enquiry, a client or an engagement."
        action={
          <ButtonLink href="/intake/conflicts/new" tone="primary" size="sm">
            <ShieldQuestion className="size-4" aria-hidden="true" />
            Run a check
          </ButtonLink>
        }
      />
    );
  }

  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <Th>Check</Th>
            <Th>Searched for</Th>
            <Th>Outcome</Th>
            <Th>Matches</Th>
            <Th>Decided by</Th>
            <Th className="text-right">Run</Th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((check) => (
            <tr key={check.id} className="transition-colors hover:bg-surface-sunken/60">
              <Td>
                <AppLink
                  href={`/intake/conflicts/${check.id}`}
                  className="hover:text-signal-dark hover:underline"
                >
                  <Id>{check.checkId}</Id>
                </AppLink>
              </Td>
              <Td className="max-w-xs text-xs text-body">
                {check.searchedTerms.slice(0, 3).join(", ")}
                {check.searchedTerms.length > 3 && (
                  <Muted> and {check.searchedTerms.length - 3} more</Muted>
                )}
              </Td>
              <Td>
                <ConflictBadge status={check.status} />
              </Td>
              <Td className="text-xs tabular-nums">
                {check.matchCount === 0 ? (
                  <Muted>none</Muted>
                ) : (
                  <>
                    {check.matchCount}
                    {check.highestScore !== null && (
                      <span className="text-faint">
                        {" "}
                        (top {check.highestScore.toFixed(2)})
                      </span>
                    )}
                  </>
                )}
              </Td>
              <Td className="text-xs text-muted">{check.decidedByName ?? <NotSet />}</Td>
              <Td className="text-right text-xs whitespace-nowrap text-muted">
                {new Date(check.createdAt).toLocaleDateString("en-GB")}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Pagination
        basePath="/intake/conflicts"
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        params={params}
        unit="check"
      />
    </Card>
  );
}

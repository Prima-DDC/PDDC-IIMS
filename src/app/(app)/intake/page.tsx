import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import { Inbox, Send, ShieldQuestion } from "lucide-react";
import {
  ButtonLink,
  Card,
  EmptyState,
  FiltersSkeleton,
  Id,
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
import { ENQUIRY_CHANNEL_LABELS, enquiryParty } from "@/modules/crm";
import { listEnquiries } from "@/features/intake/queries";
import { IntakeFilters } from "@/features/intake/IntakeFilters";
import {
  ConflictBadge,
  EnquiryStatusBadge,
  UrgencyBadge,
} from "@/features/clients/ClientBadges";

export const metadata: Metadata = { title: "Intake" };

type Params = {
  search?: string;
  status?: string;
  urgency?: string;
  assignedTo?: string;
  sort?: string;
  page?: string;
};

export default async function IntakePage({
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
        title="Intake"
        description="Every enquiry PDDC receives, whether or not it becomes work. Intake history is kept permanently, so a declined enquiry stays readable with the reason it was declined."
        actions={
          <div className="flex gap-2">
            <ButtonLink href="/intake/conflicts" size="sm">
              <ShieldQuestion className="size-4" aria-hidden="true" />
              Conflict checks
            </ButtonLink>
            {mayCreate && (
              <ButtonLink href="/intake/new" tone="primary" size="sm">
                <Send className="size-4" aria-hidden="true" />
                Log an enquiry
              </ButtonLink>
            )}
          </div>
        }
      />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <EnquiryList params={params} />
      </Suspense>
    </div>
  );
}

async function EnquiryList({ params }: { params: Params }) {
  const result = await listEnquiries({
    search: params.search,
    status: params.status,
    urgency: params.urgency,
    assignedTo: params.assignedTo,
    sort: params.sort,
    page: params.page ? Number(params.page) : 1,
  });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Open enquiries"
          value={result.summary.openEnquiries}
          hint="New, being assessed, or at conflict check"
        />
        <StatTile
          label="Awaiting a conflict decision"
          value={result.summary.awaitingConflictDecision}
          tone={result.summary.awaitingConflictDecision > 0 ? "warn" : "ok"}
          href="/intake/conflicts?status=open"
        />
        <StatTile label="Quoted" value={result.summary.quoted} />
        <StatTile
          label="Urgent"
          value={result.summary.urgent}
          tone={result.summary.urgent > 0 ? "danger" : "neutral"}
          href="/intake?urgency=urgent"
        />
      </div>

      <Suspense fallback={<FiltersSkeleton selects={3} />}>
        <IntakeFilters people={result.people} />
      </Suspense>

      {result.rows.length === 0 ? (
        <EmptyState
          title="No enquiries match those filters"
          description="Clear the filters, or log the enquiry that has just come in."
          action={
            result.can.create ? (
              <ButtonLink href="/intake/new" tone="primary" size="sm">
                <Inbox className="size-4" aria-hidden="true" />
                Log an enquiry
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Enquiry</Th>
                <Th>Party</Th>
                <Th>Stage</Th>
                <Th>Conflict</Th>
                <Th>Assigned to</Th>
                <Th className="text-right">Received</Th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((enquiry) => (
                <tr
                  key={enquiry.id}
                  className="transition-colors hover:bg-surface-sunken/60"
                >
                  <Td>
                    <AppLink
                      href={`/intake/${enquiry.id}`}
                      className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
                    >
                      {enquiry.subject}
                    </AppLink>
                    <span className="flex items-center gap-2">
                      <Id>{enquiry.enquiryId}</Id>
                      <UrgencyBadge urgency={enquiry.urgency} />
                    </span>
                  </Td>
                  <Td className="text-xs">
                    {enquiry.clientId ? (
                      <AppLink
                        href={`/clients/${enquiry.clientId}`}
                        className="text-signal-dark hover:underline"
                      >
                        {enquiry.clientName}
                      </AppLink>
                    ) : (
                      <span className="text-body">{enquiryParty(enquiry)}</span>
                    )}
                    <p className="text-[11px] text-faint">
                      {ENQUIRY_CHANNEL_LABELS[enquiry.receivedVia]}
                    </p>
                  </Td>
                  <Td>
                    <EnquiryStatusBadge status={enquiry.status} />
                  </Td>
                  <Td>
                    <ConflictBadge status={enquiry.conflictStatus} />
                  </Td>
                  <Td className="text-xs text-muted">
                    {enquiry.assignedToName ?? <NotSet />}
                  </Td>
                  <Td className="text-right text-xs whitespace-nowrap text-muted">
                    {new Date(enquiry.receivedAt).toLocaleDateString("en-GB")}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <Pagination
            basePath="/intake"
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            params={params}
            unit="enquiry"
            plural="enquiries"
          />
        </Card>
      )}
    </div>
  );
}

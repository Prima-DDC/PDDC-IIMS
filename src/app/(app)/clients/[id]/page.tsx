import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { ShieldQuestion } from "lucide-react";
import {
  Alert,
  Card,
  DescriptionList,
  Id,
  NotSet,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { ClassificationBanner } from "@/components/ClassificationBanner";
import { can, requireActor } from "@/lib/auth/session";
import { CLIENT_TYPE_LABELS } from "@/modules/crm";
import { getClientDetail } from "@/features/clients/queries";
import { ClientForm } from "@/features/clients/ClientForm";
import {
  ClientEngagementsPanel,
  ClientStatusPanel,
  ContactsPanel,
  DocumentsPanel,
  KycPanel,
} from "@/features/clients/ClientPanels";
import {
  ClientStatusBadge,
  ConflictBadge,
  KycBadge,
  RiskBadge,
} from "@/features/clients/ClientBadges";

export const metadata: Metadata = { title: "Client" };

export default async function ClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "clients", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const detail = await getClientDetail(id);
  // 404 rather than 403 for a client this person's clearance cannot reach: the
  // existence of the record is not information they need (PRD 7.4).
  if (!detail) notFound();

  const { client } = detail;

  return (
    <div className="space-y-5">
      <ClassificationBanner level={client.classification} />

      <PageHeader
        title={client.organisationName}
        description={client.industry ?? undefined}
        breadcrumb={[
          { label: "Clients", href: "/clients" },
          { label: client.clientId },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ClientStatusBadge status={client.status} />
            <KycBadge status={detail.kyc.status} />
            <RiskBadge rating={client.riskRating} />
          </div>
        }
      />

      <Card title="Summary">
        <DescriptionList
          items={[
            { label: "Client ID", value: <Id>{client.clientId}</Id> },
            { label: "Type", value: CLIENT_TYPE_LABELS[client.clientType] },
            { label: "Main contact", value: client.contactPerson ?? <NotSet /> },
            {
              label: "Email",
              value: client.email ? (
                <a
                  href={`mailto:${client.email}`}
                  className="text-signal-dark hover:underline"
                >
                  {client.email}
                </a>
              ) : (
                <NotSet />
              ),
            },
            { label: "Telephone", value: client.telephone ?? <NotSet /> },
            { label: "Country", value: client.countryName ?? <NotSet /> },
            { label: "PDDC office", value: client.officeName ?? <NotSet /> },
            {
              label: "Account manager",
              value: client.accountManagerName ?? <NotSet />,
            },
            {
              label: "Onboarded",
              value: client.dateOnboarded ? (
                new Date(client.dateOnboarded).toLocaleDateString("en-GB")
              ) : (
                <NotSet />
              ),
            },
            {
              label: "Created",
              value: `${new Date(client.createdAt).toLocaleDateString("en-GB")}${
                client.createdByName ? ` by ${client.createdByName}` : ""
              }`,
            },
          ]}
        />
        {client.address && (
          <p className="mt-4 text-sm whitespace-pre-line text-muted">{client.address}</p>
        )}
        {client.notes && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
              Notes
            </p>
            <p className="mt-1 text-sm whitespace-pre-line text-body">{client.notes}</p>
          </div>
        )}
      </Card>

      <KycPanel
        client={client}
        records={detail.kycRecords}
        assessment={detail.kyc}
        documents={detail.documents}
        canEdit={detail.can.edit}
      />

      <ConflictPanel
        clientId={client.id}
        organisationName={client.organisationName}
        checks={detail.conflictChecks}
        canView={detail.can.viewConflicts}
      />

      <ClientEngagementsPanel
        clientId={client.id}
        engagements={detail.engagements}
        canCreate={detail.can.createEngagement && client.deletedAt === null}
      />

      <ContactsPanel
        clientId={client.id}
        contacts={detail.contacts}
        canEdit={detail.can.edit && client.deletedAt === null}
      />

      <DocumentsPanel
        clientId={client.id}
        documents={detail.documents}
        levels={detail.levels}
        canEdit={detail.can.edit && client.deletedAt === null}
      />

      {detail.can.edit && client.deletedAt === null && (
        <Card
          title="Details"
          description="Changing the risk rating changes which KYC checks are required."
        >
          <ClientForm
            client={client}
            offices={detail.offices}
            countries={detail.countries}
            levels={detail.levels}
            people={detail.people}
          />
        </Card>
      )}

      <ClientStatusPanel
        client={client}
        canEdit={detail.can.edit}
        canRemove={detail.can.remove}
      />
    </div>
  );
}

/**
 * Conflict screening for this client.
 *
 * The panel is deliberately read-only: a check is run from the intake screen,
 * where the names to search for are known, and decided by an authorised
 * manager on the check's own page. What belongs here is the answer to "has
 * this client been screened, and what was decided" (PRD 8.3).
 */
function ConflictPanel({
  clientId,
  organisationName,
  checks,
  canView,
}: {
  clientId: string;
  organisationName: string;
  checks: Array<{
    id: string;
    checkId: string;
    status: "open" | "cleared" | "further_review" | "declined";
    matchCount: number;
    highestScore: number | null;
    decisionReason: string | null;
    decidedByName: string | null;
    createdAt: string;
  }>;
  canView: boolean;
}) {
  if (!canView) return null;

  return (
    <Card
      title="Conflict screening"
      description="A check finds potential matches and scores them. It never concludes two parties are the same: a manager decides."
      actions={
        <AppLink
          href={`/intake/conflicts/new?clientId=${clientId}&term=${encodeURIComponent(organisationName)}`}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs font-medium text-body hover:bg-surface-sunken"
        >
          <ShieldQuestion className="size-4" aria-hidden="true" />
          Run a check
        </AppLink>
      }
    >
      {checks.length === 0 ? (
        <Alert tone="warn" title="Not screened">
          No conflict check has been run for this client. An engagement cannot be
          approved until one has been run and decided.
        </Alert>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Check</Th>
              <Th>Outcome</Th>
              <Th>Matches</Th>
              <Th>Decided by</Th>
              <Th className="text-right">Run</Th>
            </tr>
          </thead>
          <tbody>
            {checks.map((check) => (
              <tr key={check.id}>
                <Td>
                  <AppLink
                    href={`/intake/conflicts/${check.id}`}
                    className="hover:underline"
                  >
                    <Id>{check.checkId}</Id>
                  </AppLink>
                </Td>
                <Td>
                  <ConflictBadge status={check.status} />
                  {check.decisionReason && (
                    <p className="mt-1 max-w-sm text-[11px] text-muted">
                      {check.decisionReason}
                    </p>
                  )}
                </Td>
                <Td className="text-xs tabular-nums">
                  {check.matchCount}
                  {check.highestScore !== null && (
                    <span className="text-faint">
                      {" "}
                      (top {check.highestScore.toFixed(2)})
                    </span>
                  )}
                </Td>
                <Td className="text-xs text-muted">
                  {check.decidedByName ?? <NotSet />}
                </Td>
                <Td className="text-right text-xs whitespace-nowrap text-muted">
                  {new Date(check.createdAt).toLocaleDateString("en-GB")}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

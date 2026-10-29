import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { ShieldQuestion } from "lucide-react";
import {
  Alert,
  ButtonLink,
  Card,
  DescriptionList,
  Id,
  NotSet,
  PageHeader,
} from "@/components/ui";
import { ClassificationBanner } from "@/components/ClassificationBanner";
import { can, requireActor } from "@/lib/auth/session";
import { ENGAGEMENT_TYPE_LABELS } from "@/modules/crm";
import { getEngagementDetail } from "@/features/engagements/queries";
import {
  EngagementForm,
  EngagementStatusPanel,
} from "@/features/engagements/EngagementForms";
import {
  ConflictBadge,
  EngagementProgress,
  EngagementStatusBadge,
} from "@/features/clients/ClientBadges";

export const metadata: Metadata = { title: "Engagement" };

export default async function EngagementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "engagements", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const detail = await getEngagementDetail(id);
  if (!detail) notFound();

  const { engagement, check } = detail;

  return (
    <div className="space-y-5">
      <ClassificationBanner level={engagement.classification} />

      <PageHeader
        title={engagement.title}
        description={ENGAGEMENT_TYPE_LABELS[engagement.engagementType]}
        breadcrumb={[
          { label: "Engagements", href: "/engagements" },
          { label: engagement.engagementId },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <EngagementStatusBadge status={engagement.status} />
            <ConflictBadge status={engagement.conflictStatus} />
          </div>
        }
      />

      <Card>
        <EngagementProgress status={engagement.status} />
      </Card>

      <Card title="The instruction">
        <DescriptionList
          items={[
            { label: "Engagement ID", value: <Id>{engagement.engagementId}</Id> },
            {
              label: "Client",
              value: (
                <AppLink
                  href={`/clients/${engagement.clientId}`}
                  className="text-signal-dark hover:underline"
                >
                  {engagement.clientName} ({engagement.clientReference})
                </AppLink>
              ),
            },
            {
              label: "Arising from",
              value: engagement.enquiryId ? (
                <AppLink
                  href={`/intake/${engagement.enquiryId}`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{engagement.enquiryReference}</Id>
                </AppLink>
              ) : (
                <NotSet />
              ),
            },
            {
              label: "Responsible manager",
              value: engagement.responsibleManagerName ?? <NotSet />,
            },
            {
              label: "Starts",
              value: engagement.startDate ? (
                new Date(engagement.startDate).toLocaleDateString("en-GB")
              ) : (
                <NotSet />
              ),
            },
            {
              label: "Ends",
              value: engagement.endDate ? (
                new Date(engagement.endDate).toLocaleDateString("en-GB")
              ) : (
                <NotSet />
              ),
            },
            {
              label: "Contract reference",
              value: engagement.contractReference ?? <NotSet />,
            },
            { label: "NDA reference", value: engagement.ndaReference ?? <NotSet /> },
            {
              label: "Approved",
              value: engagement.approvedAt ? (
                `${new Date(engagement.approvedAt).toLocaleDateString("en-GB")}${
                  engagement.approvedByName ? ` by ${engagement.approvedByName}` : ""
                }`
              ) : (
                <NotSet />
              ),
            },
          ]}
        />

        {engagement.scopeOfServices && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
              Scope of services
            </p>
            <p className="mt-1 text-sm whitespace-pre-line text-body">
              {engagement.scopeOfServices}
            </p>
          </div>
        )}

        {engagement.commercialTerms && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
              Commercial terms
            </p>
            <p className="mt-1 text-sm whitespace-pre-line text-body">
              {engagement.commercialTerms}
            </p>
          </div>
        )}
      </Card>

      {detail.can.viewConflicts && (
        <Card
          title="Conflict screening"
          description="A decided conflict check is required before this engagement can be approved."
          actions={
            check === null ? (
              <ButtonLink
                href={`/intake/conflicts/new?engagementId=${engagement.id}&clientId=${engagement.clientId}&term=${encodeURIComponent(
                  engagement.clientName,
                )}`}
                tone="primary"
                size="sm"
              >
                <ShieldQuestion className="size-4" aria-hidden="true" />
                Run a check
              </ButtonLink>
            ) : (
              <ButtonLink href={`/intake/conflicts/${check.id}`} size="sm">
                Open {check.checkId}
              </ButtonLink>
            )
          }
        >
          {check === null ? (
            <Alert tone="warn" title="Not screened">
              No conflict check covers this engagement or the enquiry it came from.
            </Alert>
          ) : check.decision === null ? (
            <Alert tone="warn" title={`${check.checkId} is awaiting a decision`}>
              The search found {check.matchCount} potential match
              {check.matchCount === 1 ? "" : "es"}. An undecided check is not a
              clearance, so approval is blocked until a manager records the decision.
            </Alert>
          ) : (
            <Alert
              tone={
                check.decision === "declined"
                  ? "danger"
                  : check.decision === "further_review"
                    ? "warn"
                    : "ok"
              }
              title={`${check.checkId}: ${check.decision.replace(/_/g, " ")}`}
            >
              <p>{check.decisionReason}</p>
              <p className="mt-1 text-[11px]">
                Decided by {check.decidedByName ?? "an administrator"}
                {check.decidedAt
                  ? ` on ${new Date(check.decidedAt).toLocaleDateString("en-GB")}`
                  : ""}
                .
              </p>
            </Alert>
          )}
        </Card>
      )}

      <EngagementStatusPanel
        engagement={engagement}
        transitions={detail.transitions}
        isAuthor={detail.isAuthor}
        canEdit={detail.can.edit}
        canApprove={detail.can.approve}
        canRemove={detail.can.remove}
      />

      {engagement.status === "active" && detail.can.createCase && (
        <Card
          title="Cases"
          description="The investigation itself is run as a case under this engagement."
        >
          <Alert tone="info">
            Case creation arrives with the casework module. The engagement is approved
            and active, so it is ready to carry cases.
          </Alert>
        </Card>
      )}

      {detail.can.edit && engagement.deletedAt === null && (
        <Card title="Details">
          <EngagementForm
            engagement={engagement}
            reference={{
              offices: detail.offices,
              countries: detail.countries,
              levels: detail.levels,
              people: detail.people,
              clients: [],
              enquiries: engagement.enquiryId
                ? [
                    {
                      id: engagement.enquiryId,
                      name: engagement.enquiryReference ?? "the originating enquiry",
                    },
                  ]
                : [],
            }}
          />
        </Card>
      )}
    </div>
  );
}

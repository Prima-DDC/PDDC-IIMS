import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { Briefcase, ShieldQuestion } from "lucide-react";
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
import { ENQUIRY_CHANNEL_LABELS, enquiryParty } from "@/modules/crm";
import { getEnquiryDetail } from "@/features/intake/queries";
import { EnquiryForm, EnquiryStagePanel } from "@/features/intake/IntakeForms";
import {
  ConflictBadge,
  EnquiryStatusBadge,
  IntakePipeline,
  UrgencyBadge,
} from "@/features/clients/ClientBadges";

export const metadata: Metadata = { title: "Enquiry" };

export default async function EnquiryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "clients", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const detail = await getEnquiryDetail(id);
  if (!detail) notFound();

  const { enquiry, check } = detail;

  return (
    <div className="space-y-5">
      <ClassificationBanner level={enquiry.classification} />

      <PageHeader
        title={enquiry.subject}
        description={enquiry.requestedService ?? undefined}
        breadcrumb={[{ label: "Intake", href: "/intake" }, { label: enquiry.enquiryId }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <EnquiryStatusBadge status={enquiry.status} />
            <UrgencyBadge urgency={enquiry.urgency} />
            <ConflictBadge status={enquiry.conflictStatus} />
          </div>
        }
      />

      {/* Where the enquiry stands in the pipeline, as a rail rather than a
          single word, because the order is the thing being enforced. */}
      <Card>
        <IntakePipeline status={enquiry.status} />
      </Card>

      <Card title="The enquiry">
        <DescriptionList
          items={[
            { label: "Enquiry ID", value: <Id>{enquiry.enquiryId}</Id> },
            {
              label: "Party",
              value: enquiry.clientId ? (
                <AppLink
                  href={`/clients/${enquiry.clientId}`}
                  className="text-signal-dark hover:underline"
                >
                  {enquiry.clientName} ({enquiry.clientReference})
                </AppLink>
              ) : (
                <>
                  {enquiryParty(enquiry)}{" "}
                  <span className="text-[11px] text-faint">prospect</span>
                </>
              ),
            },
            { label: "Received", value: new Date(enquiry.receivedAt).toLocaleString("en-GB") },
            { label: "By", value: ENQUIRY_CHANNEL_LABELS[enquiry.receivedVia] },
            { label: "Contact", value: enquiry.contactName ?? <NotSet /> },
            {
              label: "Contact email",
              value: enquiry.contactEmail ? (
                <a
                  href={`mailto:${enquiry.contactEmail}`}
                  className="text-signal-dark hover:underline"
                >
                  {enquiry.contactEmail}
                </a>
              ) : (
                <NotSet />
              ),
            },
            { label: "Contact telephone", value: enquiry.contactPhone ?? <NotSet /> },
            { label: "Assigned to", value: enquiry.assignedToName ?? <NotSet /> },
            {
              label: "Engagement",
              value: enquiry.engagementId ? (
                <AppLink
                  href={`/engagements/${enquiry.engagementId}`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{enquiry.engagementReference}</Id>
                </AppLink>
              ) : (
                <NotSet />
              ),
            },
          ]}
        />

        {enquiry.summary && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
              What they told us
            </p>
            <p className="mt-1 text-sm whitespace-pre-line text-body">
              {enquiry.summary}
            </p>
          </div>
        )}

        {enquiry.status === "declined" && enquiry.declineReason && (
          <div className="mt-4">
            <Alert tone="warn" title="Declined">
              {enquiry.declineReason}
            </Alert>
          </div>
        )}
      </Card>

      {/* Conflict screening. The gate on quoting and on approving an
          engagement, so it sits above the editable detail. */}
      {detail.can.screen && (
        <Card
          title="Conflict screening"
          description="Run before PDDC commits to the work. A check finds potential matches and scores them; an authorised manager decides."
          actions={
            check === null ? (
              <ButtonLink
                href={`/intake/conflicts/new?enquiryId=${enquiry.id}&term=${encodeURIComponent(
                  enquiryParty(enquiry),
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
              No conflict check has been run. This enquiry cannot be quoted, and no
              engagement can be approved, until one has been run and decided.
            </Alert>
          ) : check.decision === null ? (
            <Alert tone="warn" title={`${check.checkId} is awaiting a decision`}>
              {check.matchCount === 0
                ? "The search found no potential matches. A manager still has to record the clearance."
                : `The search found ${check.matchCount} potential match${
                    check.matchCount === 1 ? "" : "es"
                  }. A manager has to decide before the work can proceed.`}
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

      <EnquiryStagePanel
        enquiry={enquiry}
        transitions={detail.transitions}
        people={detail.people}
        canEdit={detail.can.edit}
      />

      {/* An accepted enquiry becomes an engagement, which is the only route
          from intake into casework (PRD 4.1). */}
      {enquiry.status === "accepted" &&
        enquiry.engagementId === null &&
        detail.can.createEngagement && (
          <Card
            title="Next step"
            description="The enquiry has been accepted, so the instruction can be recorded as an engagement. Cases hang off the engagement."
          >
            <ButtonLink
              href={`/engagements/new?enquiryId=${enquiry.id}${
                enquiry.clientId ? `&clientId=${enquiry.clientId}` : ""
              }`}
              tone="primary"
              size="sm"
            >
              <Briefcase className="size-4" aria-hidden="true" />
              Create the engagement
            </ButtonLink>
            {enquiry.clientId === null && (
              <p className="mt-2 text-xs text-muted">
                This enquiry names a prospect rather than a client, so create the client
                record first.
              </p>
            )}
          </Card>
        )}

      {detail.can.edit && (
        <Card
          title="Details"
          description="Intake history is kept permanently; edits are recorded in the audit trail."
        >
          <EnquiryForm
            enquiry={enquiry}
            reference={{
              offices: detail.offices,
              countries: detail.countries,
              levels: detail.levels,
              people: detail.people,
              clients: detail.clients,
            }}
          />
        </Card>
      )}
    </div>
  );
}

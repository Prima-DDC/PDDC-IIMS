import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import {
  Alert,
  Card,
  DescriptionList,
  Id,
  Muted,
  NotSet,
  PageHeader,
} from "@/components/ui";
import { ClassificationBanner } from "@/components/ClassificationBanner";
import { can, requireActor } from "@/lib/auth/session";
import { getSourceDetail } from "@/features/intel/queries";
import { RemoveSourceForm, SourceForm } from "@/features/intel/IntelForms";
import {
  InformationTable,
  ReliabilityBadge,
} from "@/features/intel/IntelViews";
import {
  SOURCE_TYPE_LABELS,
  VERIFICATION_STATUS_LABELS,
} from "@/modules/intel/shared";

export const metadata: Metadata = { title: "Source" };

export default async function SourcePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "sources", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const detail = await getSourceDetail(id);
  if (!detail) notFound();

  const { source } = detail;

  return (
    <div className="space-y-5">
      <ClassificationBanner
        level={source.classification}
        caseId={source.caseReference}
      />

      <PageHeader
        title={source.sourceId}
        description={source.description}
        breadcrumb={[
          { label: "Sources", href: "/sources" },
          { label: source.sourceId },
        ]}
        actions={<ReliabilityBadge reliability={source.sourceReliability} />}
      />

      {source.identityRestricted && (
        <Alert
          tone={source.identityWithheld ? "warn" : "info"}
          title="A human source, with its identity protected"
        >
          {source.identityWithheld
            ? "An identity is held for this source and is withheld from you. That is PRD 6.4 working as written: what the source said is readable to the case team, who they are is need-to-know."
            : "PRD 6.4 makes a human source strictly restricted with its identity need-to-know. What it said stays readable to the case team; who it is does not."}
        </Alert>
      )}

      <Card title="The source">
        <DescriptionList
          items={[
            { label: "Identifier", value: <Id>{source.sourceId}</Id> },
            {
              label: "Case",
              value: (
                <AppLink
                  href={`/cases/${source.caseId}?tab=sources`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{source.caseReference}</Id>
                </AppLink>
              ),
            },
            { label: "Kind", value: SOURCE_TYPE_LABELS[source.sourceType] },
            {
              label: "Obtained",
              value: `${new Date(source.dateObtained).toLocaleDateString("en-GB")}${
                source.obtainedByName ? ` by ${source.obtainedByName}` : ""
              }`,
            },
            {
              label: "Verification",
              value: VERIFICATION_STATUS_LABELS[source.verificationStatus],
            },
            {
              label: "Access restrictions",
              value: source.accessRestrictions ?? <NotSet />,
            },
            {
              label: "Identity",
              value: source.identityWithheld ? (
                <Muted>held, and withheld from you</Muted>
              ) : source.identityName ? (
                <span>
                  {source.identityName}
                  {source.identityContact ? `, ${source.identityContact}` : ""}
                </span>
              ) : (
                <NotSet />
              ),
            },
          ]}
        />
        {source.identityNotes && (
          <p className="mt-4 border-t border-line pt-4 text-xs whitespace-pre-line text-muted">
            Handling: {source.identityNotes}
          </p>
        )}
      </Card>

      <Card
        title="What it said"
        description="Each statement is rated on its own, separately from how reliable the source is. That distinction is the point of PRD 6.4."
      >
        <InformationTable information={detail.information} showCase={false} />
      </Card>

      {detail.can.editSource && source.deletedAt === null && (
        <Card
          title="Details"
          description="Changing the classification changes who can open this source at all."
        >
          <SourceForm
            caseRecordId={source.caseId}
            source={source}
            people={detail.people}
            levels={detail.levels}
            defaultClassification={source.classification}
            actorId={detail.actorId}
          />
        </Card>
      )}

      {detail.can.removeSource && source.deletedAt === null && (
        <Card
          title="Remove this source"
          description="Only possible while nothing is attributed to it. Removing a cited source would leave its information attributed to nothing."
        >
          <RemoveSourceForm caseRecordId={source.caseId} source={source} />
        </Card>
      )}
    </div>
  );
}

import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { Alert, Card, DescriptionList, Id, Muted, PageHeader } from "@/components/ui";
import { ClassificationBanner } from "@/components/ClassificationBanner";
import { can, requireActor } from "@/lib/auth/session";
import { getReportDetail } from "@/features/reporting/queries";
import {
  AcknowledgeForm,
  AddVersionForm,
  CompleteQaForm,
  DeliveryForm,
  Expandable,
  OpenQaForm,
  QaItemForm,
  ReportForm,
  ReportRemovalPanel,
  ReportStatusForm,
  SectionControls,
  SectionForm,
  VersionForm,
} from "@/features/reporting/ReportForms";
import {
  DeliveryList,
  QaReviewView,
  ReportStatusBadge,
  ReportVersionHistory,
  ReportWorkflowRail,
  SectionList,
  WorkflowHistory,
} from "@/features/reporting/ReportViews";
import {
  REPORT_TYPE_LABELS,
  uncitedSections,
} from "@/modules/reporting/shared";

export const metadata: Metadata = { title: "Report" };

/**
 * The report builder (PRD 10, screen 18).
 *
 * Ordered the way the work is done: where the report is on PRD 10.1's line,
 * then what moves it, then the text, then what each section cites, then QA,
 * then delivery. A reader who only looks at the top of this page should be
 * able to say what has to happen next and who has to do it.
 */
export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "reports", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const detail = await getReportDetail(id);
  // 404 rather than 403, as the rest of the platform does it.
  if (!detail) notFound();

  const { report } = detail;
  const working = report.current;
  const uncited = uncitedSections(detail.sections);
  const approved = detail.versions.find(
    (version) => version.id === report.approvedVersionId,
  );

  const citable = {
    findings: detail.citable.findings,
    evidence: detail.citable.evidence,
    documents: detail.citable.documents,
    information: detail.citable.information,
  };

  return (
    <div className="space-y-5">
      <ClassificationBanner
        level={report.classification}
        caseId={report.caseReference}
      />

      <PageHeader
        title={report.title}
        description={`${REPORT_TYPE_LABELS[report.reportType]} for ${report.clientName}`}
        breadcrumb={[
          { label: "Reports", href: "/reports" },
          { label: report.reportId },
        ]}
        actions={<ReportStatusBadge status={report.status} />}
      />

      {/* The line first: "in review" means nothing without saying whose. */}
      <Card
        title="Where it is"
        description="PRD 10.1's seven stages. Each one is somebody reading it, and the author can never be the one who passes it on."
      >
        <div className="space-y-4">
          <ReportWorkflowRail status={report.status} />
          <div className="border-t border-line pt-4">
            <ReportStatusForm
              caseRecordId={report.caseId}
              report={report}
              isOwnReport={detail.isOwnReport}
              canApprove={detail.can.approve}
              canEdit={detail.can.edit}
            />
          </div>
        </div>
      </Card>

      {uncited.length > 0 && report.status === "draft" && (
        <Alert
          tone="warn"
          title={`${uncited.length} ${uncited.length === 1 ? "section asserts" : "sections assert"} something and cite nothing`}
        >
          {uncited.join(", ")}. PRD 10.2 wants every statement to cite the
          finding or exhibit it rests on, and this report cannot be put forward
          until they do: a QA reviewer would send it back for exactly this.
        </Alert>
      )}

      <Card title="The report">
        <DescriptionList
          items={[
            { label: "Identifier", value: <Id>{report.reportId}</Id> },
            {
              label: "Case",
              value: (
                <AppLink
                  href={`/cases/${report.caseId}?tab=reports`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{report.caseReference}</Id> {report.caseTitle}
                </AppLink>
              ),
            },
            { label: "Author", value: report.authorName ?? "unknown" },
            {
              label: "Working version",
              value: working ? (
                `${working.versionLabel}, ${working.sectionCount} sections`
              ) : (
                <Muted>none</Muted>
              ),
            },
            {
              label: "Approved version",
              value: approved ? (
                `${approved.versionLabel}, approved ${
                  approved.approvedAt
                    ? new Date(approved.approvedAt).toLocaleDateString("en-GB")
                    : ""
                }${approved.approvedByName ? ` by ${approved.approvedByName}` : ""}`
              ) : (
                <Muted>none yet</Muted>
              ),
            },
            {
              label: "Delivered",
              value:
                report.deliveryCount === 0 ? (
                  <Muted>not yet</Muted>
                ) : (
                  `${report.deliveryCount} ${report.deliveryCount === 1 ? "time" : "times"}`
                ),
            },
          ]}
        />
      </Card>

      {working && (
        <>
          <Expandable
            title="Sections"
            description="The report itself. A narrative, finding, analysis, conclusion or recommendation has to cite the finding or exhibit it rests on."
            openLabel="Add a section"
            canOpen={detail.can.edit && !working.isApproved}
            summary={
              <SectionList sections={detail.sections}>
                {(section) =>
                  detail.can.edit && !working.isApproved ? (
                    <SectionControls
                      caseRecordId={report.caseId}
                      report={report}
                      section={section}
                      citable={citable}
                    />
                  ) : null
                }
              </SectionList>
            }
          >
            <SectionForm
              caseRecordId={report.caseId}
              report={report}
              versionId={working.id}
            />
          </Expandable>

          <Card
            title="Front matter"
            description="The summary, scope, methodology, limitations and conclusion, which a PDF needs and a reader expects."
          >
            {detail.can.edit ? (
              <VersionForm
                caseRecordId={report.caseId}
                report={report}
                version={working}
              />
            ) : (
              <dl className="space-y-3 text-xs">
                {(
                  [
                    ["Executive summary", working.executiveSummary],
                    ["Scope", working.scopeStatement],
                    ["Methodology", working.methodology],
                    ["Limitations", working.limitations],
                    ["Conclusion", working.conclusion],
                  ] as Array<[string, string | null]>
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                      {label}
                    </dt>
                    <dd className="mt-0.5 whitespace-pre-line text-body">
                      {value?.trim() ? value : <Muted>not written</Muted>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
        </>
      )}

      <Expandable
        title="Versions"
        description="PRD 10.2: v0.1 to v1.0 and on. An approved version is locked, and a change from there is the next version with everything carried forward."
        openLabel="Start the next version"
        canOpen={detail.can.edit}
        summary={
          <ReportVersionHistory
            versions={detail.versions}
            approvedVersionId={report.approvedVersionId}
          />
        }
      >
        <AddVersionForm caseRecordId={report.caseId} report={report} />
      </Expandable>

      <Card
        title="QA review"
        description="PRD 10.3's twelve checks. The result follows the items: a review with a failed check is a return, whatever the reviewer meant to click."
      >
        <div className="space-y-4">
          {detail.openReview ? (
            <>
              <QaReviewView
                review={detail.openReview}
                checklist={detail.checklist}
              >
                {(item) => (
                  <QaItemForm
                    caseRecordId={report.caseId}
                    report={report}
                    review={detail.openReview!}
                    itemKey={item.key}
                    current={detail.openReview!.items.find(
                      (answer) => answer.itemKey === item.key,
                    )}
                  />
                )}
              </QaReviewView>
              <div className="border-t border-line pt-4">
                <CompleteQaForm
                  caseRecordId={report.caseId}
                  report={report}
                  review={detail.openReview}
                  answered={detail.openReview.items.length}
                  total={detail.checklist.length}
                  failed={
                    detail.openReview.items.filter(
                      (item) => item.result === "fail",
                    ).length
                  }
                />
              </div>
            </>
          ) : (
            <>
              {detail.reviews.length === 0 ? (
                <Muted>
                  No review yet. QA is the last gate before a client reads the
                  work, and it is twelve named checks rather than an opinion.
                </Muted>
              ) : (
                <ul className="space-y-4">
                  {detail.reviews.map((review) => (
                    <li key={review.id}>
                      <QaReviewView
                        review={review}
                        checklist={detail.checklist}
                      />
                    </li>
                  ))}
                </ul>
              )}

              {detail.can.qa && working && !detail.isOwnReport && (
                <div className="border-t border-line pt-4">
                  <OpenQaForm
                    caseRecordId={report.caseId}
                    report={report}
                    versionId={working.id}
                  />
                </div>
              )}

              {detail.isOwnReport && (
                <p className="border-t border-line pt-4 text-[11px] text-muted">
                  You wrote this report, so you cannot be its QA reviewer.
                </p>
              )}
            </>
          )}
        </div>
      </Card>

      <Expandable
        title="Client delivery"
        description="Who it went to, how, when, and what they said back. Only an approved version goes out."
        openLabel="Record a delivery"
        canOpen={detail.can.deliver && report.approvedVersionId !== null}
        summary={
          <div className="space-y-4">
            <DeliveryList deliveries={detail.deliveries} />
            {detail.can.deliver &&
              detail.deliveries
                .filter((delivery) => delivery.acknowledgedAt === null)
                .map((delivery) => (
                  <div
                    key={delivery.id}
                    className="rounded-lg border border-line p-3"
                  >
                    <p className="mb-2 text-xs text-body">
                      Record what {delivery.deliveredTo} said
                    </p>
                    <AcknowledgeForm
                      caseRecordId={report.caseId}
                      report={report}
                      deliveryId={delivery.id}
                    />
                  </div>
                ))}
          </div>
        }
      >
        <DeliveryForm
          caseRecordId={report.caseId}
          report={report}
          approvedVersionId={report.approvedVersionId}
          approvedVersionLabel={approved?.versionLabel ?? null}
        />
      </Expandable>

      <Card
        title="History"
        description="Every stage with who decided it, when and what they said. Append-only: a decision is corrected by recording the next one."
      >
        <WorkflowHistory history={detail.history} />
      </Card>

      {detail.can.edit && report.deletedAt === null && (
        <Card
          title="Details"
          description="Changing the classification changes who can open the report at all, and what its banner says."
        >
          <ReportForm
            caseRecordId={report.caseId}
            report={report}
            people={detail.people}
            levels={detail.levels}
            defaultClassification={report.classification}
            actorId={detail.actorId}
          />
        </Card>
      )}

      <ReportRemovalPanel
        caseRecordId={report.caseId}
        report={report}
        canRemove={detail.can.remove}
      />
    </div>
  );
}

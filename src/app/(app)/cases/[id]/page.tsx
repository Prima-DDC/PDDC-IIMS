import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { Suspense } from "react";
import { getCaseAssistant } from "@/features/ai/queries";
import { CaseAssistant } from "@/features/ai/AiViews";
import { forbidden, notFound } from "next/navigation";
import {
  Card,
  DescriptionList,
  Id,
  Muted,
  NotSet,
  PageHeader,
  TableSkeleton,
} from "@/components/ui";
import { ClassificationBanner } from "@/components/ClassificationBanner";
import { can, requireActor } from "@/lib/auth/session";
import { getCaseDetail } from "@/features/cases/queries";
import { CaseForm, ObjectiveForm } from "@/features/cases/CaseForm";
import {
  AssignmentPanel,
  CaseRemovalPanel,
  CommunicationsPanel,
  LifecyclePanel,
  RiskPanel,
  ScopePanel,
} from "@/features/cases/CasePanels";
import {
  CaseActivityTab,
  CasePlanTab,
  CaseTasksTab,
} from "@/features/tasks/CaseWork";
import { CaseSafetyTab } from "@/features/safety/CaseSafety";
import { CaseEvidenceTab } from "@/features/evidence/CaseEvidence";
import { CaseDocumentsTab } from "@/features/documents/CaseDocuments";
import {
  CaseFindingsTab,
  CaseSourcesTab,
  CaseSubjectsTab,
} from "@/features/intel/CaseIntel";
import {
  CaseClosureTab,
  CaseReportsTab,
} from "@/features/reporting/CaseReporting";
import { CaseFinanceTab } from "@/features/finance/CaseFinance";
import { CaseTabs, type CaseTab } from "@/features/cases/CaseTabs";
import { getCaseTabCounts } from "@/features/tasks/queries";
import { getIntelTabCounts } from "@/features/intel/queries";
import { getReportingTabCounts } from "@/features/reporting/queries";
import {
  CaseProgress,
  DueSoonBadge,
  OverdueBadge,
  PriorityBadge,
  RiskLevelBadge,
  StageBadge,
} from "@/features/cases/CaseBadges";

export const metadata: Metadata = { title: "Case" };

const TABS = [
  "summary",
  "plan",
  "tasks",
  "activity",
  "subjects",
  "sources",
  "evidence",
  "documents",
  "findings",
  "reports",
  "closure",
  "comms",
  "safety",
  "finance",
  "assistant",
] as const;

type TabKey = (typeof TABS)[number];

function tabFrom(value: string | undefined): TabKey {
  return TABS.includes(value as TabKey) ? (value as TabKey) : "summary";
}

export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; folder?: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "cases", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const query = await searchParams;
  const tab = tabFrom(query.tab);
  const detail = await getCaseDetail(id);
  // 404 rather than 403 for a case this person is not on and cannot reach:
  // the existence of the case is not information they need (PRD 20.2).
  if (!detail) notFound();

  const { record } = detail;

  return (
    <div className="space-y-5">
      <ClassificationBanner level={record.classification} caseId={record.caseId} />

      <PageHeader
        title={record.title}
        description={`${record.caseTypeName} for ${record.clientName}`}
        breadcrumb={[{ label: "Cases", href: "/cases" }, { label: record.caseId }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StageBadge
              stageName={record.stageName}
              isTerminal={record.stageIsTerminal}
            />
            <RiskLevelBadge level={record.riskLevel} />
            <PriorityBadge priority={record.priority} />
            <OverdueBadge record={record} />
            <DueSoonBadge record={record} />
          </div>
        }
      />

      {/* The progress rail, built from the configured lifecycle so an
          administrator who adds a stage sees it here without a release. */}
      <Card>
        <CaseProgress stages={detail.stages} currentStageName={record.stageName} />
      </Card>

      <Card title="The case">
        <DescriptionList
          items={[
            { label: "Case ID", value: <Id>{record.caseId}</Id> },
            {
              label: "Client",
              value: (
                <AppLink
                  href={`/clients/${record.clientId}`}
                  className="text-signal-dark hover:underline"
                >
                  {record.clientName} ({record.clientReference})
                </AppLink>
              ),
            },
            {
              label: "Engagement",
              value: (
                <AppLink
                  href={`/engagements/${record.engagementId}`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{record.engagementReference}</Id>
                </AppLink>
              ),
            },
            { label: "Type", value: record.caseTypeName },
            {
              label: "Jurisdiction",
              value:
                record.jurisdictionCountryName || record.jurisdictionRegion ? (
                  [record.jurisdictionRegion, record.jurisdictionCountryName]
                    .filter(Boolean)
                    .join(", ")
                ) : (
                  <NotSet />
                ),
            },
            { label: "PDDC office", value: record.officeName ?? <NotSet /> },
            {
              label: "Lead investigator",
              value: record.leadInvestigatorName ?? <Muted>unassigned</Muted>,
            },
            {
              label: "Supervisor",
              value: record.supervisorName ?? <Muted>unassigned</Muted>,
            },
            {
              label: "Opened",
              value: `${new Date(record.openedAt).toLocaleDateString("en-GB")}${
                record.createdByName ? ` by ${record.createdByName}` : ""
              }`,
            },
          ]}
        />
      </Card>

      {/* The objective comes before everything else on the page, because
          nothing else on a case means much without it (PRD 5.1).

          The form is rendered in the same place whether or not an objective
          exists, which is not a detail: moving it when the first one is saved
          remounts it, and a remounted form loses the confirmation of the save
          that caused it. Somebody would record the objective and be told
          nothing. */}
      <Card
        title="Objective"
        description="What this investigation is for, the questions it has to answer, and what the client gets."
      >
        <div className="space-y-4">
          {detail.objective && (
            <div className="space-y-4">
              {detail.objective.clientInstruction && (
                <div>
                  <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                    The client&apos;s instruction
                  </p>
                  <p className="mt-1 text-sm whitespace-pre-line text-body">
                    {detail.objective.clientInstruction}
                  </p>
                </div>
              )}

              <div>
                <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                  Objective
                </p>
                <p className="mt-1 text-sm whitespace-pre-line text-body">
                  {detail.objective.objective}
                </p>
              </div>

              {detail.objective.questions.length > 0 && (
                <div>
                  <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                    Questions to answer
                  </p>
                  <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-body">
                    {detail.objective.questions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ol>
                </div>
              )}

              {detail.objective.deliverables.length > 0 && (
                <div>
                  <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                    Deliverables
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-body">
                    {detail.objective.deliverables.map((deliverable) => (
                      <li key={deliverable}>{deliverable}</li>
                    ))}
                  </ul>
                </div>
              )}

              {detail.objective.deadline && (
                <p className="text-xs text-muted">
                  Deadline{" "}
                  {new Date(detail.objective.deadline).toLocaleString("en-GB")}.
                </p>
              )}
            </div>
          )}

          {detail.can.edit ? (
            <div className={detail.objective ? "border-t border-line pt-4" : ""}>
              <ObjectiveForm
                caseRecordId={record.id}
                objective={detail.objective ?? undefined}
              />
            </div>
          ) : (
            !detail.objective && (
              <Muted>No objective has been recorded for this case.</Muted>
            )
          )}
        </div>
      </Card>

      <Suspense fallback={null}>
        <Tabs caseRecordId={record.id} active={tab} />
      </Suspense>

      {tab === "summary" && (
        <>
          <LifecyclePanel
            record={record}
            transitions={detail.transitions}
            canEdit={detail.can.edit}
            canApprove={detail.can.approve}
          />

          <RiskPanel
            record={record}
            assessments={detail.riskAssessments}
            canEdit={detail.can.edit}
            canApprove={detail.can.approve}
          />

          <AssignmentPanel
            record={record}
            assignments={detail.assignments}
            history={detail.assignmentHistory}
            people={detail.people}
            blocker={detail.assignmentBlocker}
            canAssign={detail.can.assign}
          />

          <ScopePanel
            record={record}
            versions={detail.scopeVersions}
            changes={detail.scopeChanges}
            pending={detail.pendingScopeChange}
            isOwnRequest={detail.isOwnScopeChange}
            canEdit={detail.can.edit}
            canApprove={detail.can.approve}
          />

          {detail.can.edit && record.deletedAt === null && (
            <Card
              title="Details"
              description="Changing the classification changes who can open this case at all."
            >
              <CaseForm
                record={record}
                reference={{
                  caseTypes: detail.caseTypes,
                  offices: detail.offices,
                  countries: detail.countries,
                  levels: detail.levels,
                }}
              />
            </Card>
          )}
        </>
      )}

      {/* Each tab streams on its own and reads only what it shows. */}
      {tab === "plan" && (
        <Suspense fallback={<TableSkeleton rows={4} />}>
          <CasePlanTab caseRecordId={record.id} />
        </Suspense>
      )}

      {tab === "assistant" && (
        <Suspense fallback={<TableSkeleton rows={3} />}>
          <CaseAssistantTab caseRecordId={record.id} />
        </Suspense>
      )}

      {tab === "tasks" && (
        <Suspense fallback={<TableSkeleton rows={4} />}>
          <CaseTasksTab caseRecordId={record.id} />
        </Suspense>
      )}

      {tab === "activity" && (
        <Suspense fallback={<TableSkeleton rows={4} />}>
          <CaseActivityTab
            caseRecordId={record.id}
            caseClassification={record.classification}
          />
        </Suspense>
      )}

      {tab === "evidence" && (
        <Suspense fallback={<TableSkeleton rows={4} />}>
          <CaseEvidenceTab
            caseRecordId={record.id}
            caseClassification={record.classification}
          />
        </Suspense>
      )}

      {tab === "subjects" && (
        <Suspense fallback={<TableSkeleton rows={4} />}>
          <CaseSubjectsTab
            caseRecordId={record.id}
            caseClassification={record.classification}
          />
        </Suspense>
      )}

      {tab === "sources" && (
        <Suspense fallback={<TableSkeleton rows={4} />}>
          <CaseSourcesTab
            caseRecordId={record.id}
            caseClassification={record.classification}
          />
        </Suspense>
      )}

      {tab === "findings" && (
        <Suspense fallback={<TableSkeleton rows={4} />}>
          <CaseFindingsTab
            caseRecordId={record.id}
            caseClassification={record.classification}
          />
        </Suspense>
      )}

      {tab === "reports" && (
        <Suspense fallback={<TableSkeleton rows={4} />}>
          <CaseReportsTab
            caseRecordId={record.id}
            caseClassification={record.classification}
          />
        </Suspense>
      )}

      {tab === "closure" && (
        <Suspense fallback={<TableSkeleton rows={4} />}>
          <CaseClosureTab caseRecordId={record.id} />
        </Suspense>
      )}

      {tab === "documents" && (
        <Suspense fallback={<TableSkeleton rows={4} />}>
          <CaseDocumentsTab
            caseRecordId={record.id}
            caseClassification={record.classification}
            folderId={query.folder}
          />
        </Suspense>
      )}

      {tab === "comms" && (
        <CommunicationsPanel
          record={record}
          communications={detail.communications}
          levels={detail.levels}
          canEdit={detail.can.edit}
        />
      )}

      {tab === "safety" && (
        <Suspense fallback={<TableSkeleton rows={3} />}>
          <CaseSafetyTab
            caseRecordId={record.id}
            caseClassification={record.classification}
          />
        </Suspense>
      )}

      {tab === "finance" && (
        <Suspense fallback={<TableSkeleton rows={3} />}>
          <CaseFinanceTab caseRecordId={record.id} />
        </Suspense>
      )}

      <CaseRemovalPanel
        record={record}
        canRemove={detail.can.remove}
        canEdit={detail.can.edit}
      />
    </div>
  );
}

/**
 * The assistant (PRD 22).
 *
 * Its own tab rather than a panel on the summary, for a reason PRD 22.3
 * cares about: an AI suggestion must be visually distinct and must not sit
 * where somebody skims for facts about the case. Behind a tab, nobody
 * encounters a model's sentence while reading the record.
 */
async function CaseAssistantTab({ caseRecordId }: { caseRecordId: string }) {
  const view = await getCaseAssistant(caseRecordId);
  if (!view.mayView) return null;
  return <CaseAssistant caseRecordId={caseRecordId} view={view} />;
}

/**
 * The tab bar, with what sits behind each tab.
 *
 * Streamed separately from the case: the counts are three more queries, and a
 * case page that waited for them to draw its tabs would feel slower for a
 * number nobody is waiting on.
 */
async function Tabs({
  caseRecordId,
  active,
}: {
  caseRecordId: string;
  active: string;
}) {
  // Two reads rather than one: the intelligence counts come from a different
  // module, and reaching across it from the casework query would be the
  // coupling the boundary rules exist to prevent.
  const [counts, intelCounts, reportingCounts] = await Promise.all([
    getCaseTabCounts(caseRecordId),
    getIntelTabCounts(caseRecordId),
    getReportingTabCounts(caseRecordId),
  ]);

  const tabs: CaseTab[] = [
    { key: "summary", label: "Summary" },
    {
      key: "plan",
      label: "Plan",
      badge: counts.planAwaitingReview ? 1 : null,
      alert: counts.planAwaitingReview,
    },
    {
      key: "tasks",
      label: "Tasks",
      badge: counts.openTasks,
      alert: counts.overdueTasks > 0,
    },
    { key: "activity", label: "Activity", badge: counts.activities },
    {
      key: "subjects",
      label: "Subjects",
      badge: intelCounts.subjects,
      alert: intelCounts.subjectFlags > 0,
    },
    {
      key: "sources",
      label: "Sources",
      badge: intelCounts.sources + intelCounts.information,
      alert: intelCounts.uncorroborated > 0,
    },
    {
      key: "evidence",
      label: "Evidence",
      badge: counts.evidence,
      alert: counts.evidenceConcerns > 0,
    },
    {
      key: "documents",
      label: "Documents",
      badge: counts.documents,
      alert: counts.documentsAwaitingApproval > 0,
    },
    {
      key: "findings",
      label: "Findings",
      badge: intelCounts.findings,
      alert:
        intelCounts.findingsAwaitingReview > 0 ||
        intelCounts.unsupportedFindings > 0,
    },
    {
      key: "reports",
      label: "Reports",
      badge: reportingCounts.reports,
      alert: reportingCounts.reportsInReview > 0,
    },
    {
      key: "closure",
      label: "Closure",
      // A proposed closure is waiting on a supervisor, which is the one state
      // worth a dot on the tab.
      badge: reportingCounts.closureStatus === "proposed" ? 1 : null,
      alert: reportingCounts.closureStatus === "proposed",
    },
    { key: "comms", label: "Communications" },
    { key: "safety", label: "Safety" },
    { key: "finance", label: "Finance" },
    // Last, and with no badge. PRD 22's Amendment 12 makes AI assistive, and
    // a count on this tab would put it in the same visual class as the work.
    { key: "assistant", label: "Assistant" },
  ];

  return <CaseTabs tabs={tabs} active={active} />;
}

import { AppLink } from "@/components/AppLink";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  CircleDot,
  FileSearch,
  FileText,
  Lock,
  Quote,
  Scale,
  Send,
  ShieldCheck,
  Undo2,
  User,
  X,
} from "lucide-react";
import {
  Badge,
  EmptyState,
  Id,
  Muted,
  NotSet,
  Table,
  Td,
  Th,
} from "@/components/ui";
import {
  CITATION_TYPE_LABELS,
  CLOSURE_STATUS_LABELS,
  DELIVERY_METHOD_LABELS,
  QA_RESULT_LABELS,
  REPORT_STATUS_LABELS,
  REPORT_TYPE_LABELS,
  REPORT_WORKFLOW,
  SECTION_TYPE_LABELS,
  type CaseClosure,
  type ClosureGateItem,
  type Delivery,
  type QaReview,
  type Report,
  type ReportSection,
  type ReportStatus,
  type ReportTransition,
  type ReportVersion,
} from "@/modules/reporting/shared";

/**
 * Reading a report, its workflow and its closure (PRD 5.9, 10).
 *
 * Server components: nothing here holds state. Two things are built to be
 * read carefully.
 *
 * The workflow rail shows PRD 10.1's seven stages and where this report has
 * got to, because "in review" means nothing without saying whose review.
 *
 * The closure gate shows all nine of PRD 5.9's requirements, each with what
 * to do about it, and marks the three the platform answered for itself. A
 * checklist that let somebody tick "report approved" when there is no
 * approved report would look like assurance and be none.
 */

function when(value: string) {
  return new Date(value).toLocaleDateString("en-GB");
}

function at(value: string) {
  return new Date(value).toLocaleString("en-GB");
}

export function ReportStatusBadge({ status }: { status: ReportStatus }) {
  const tone =
    status === "final" || status === "delivered"
      ? "ok"
      : status === "withdrawn"
        ? "neutral"
        : status === "draft"
          ? "neutral"
          : "info";
  return (
    <Badge tone={tone}>
      {status === "delivered" && <Send className="size-3" aria-hidden="true" />}
      {status === "final" && <Lock className="size-3" aria-hidden="true" />}
      {REPORT_STATUS_LABELS[status]}
    </Badge>
  );
}

/**
 * PRD 10.1's line, and where this report is on it.
 *
 * Each stage is somebody reading it. A report that appeared to jump from
 * draft to final would be a report nobody read, so the rail shows every
 * stage whether or not it has been reached.
 */
export function ReportWorkflowRail({ status }: { status: ReportStatus }) {
  const index = REPORT_WORKFLOW.indexOf(status);

  if (status === "withdrawn") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        <X className="size-3.5" aria-hidden="true" />
        Withdrawn. It stays on the case with its history, which is what makes
        the history worth reading.
      </p>
    );
  }

  return (
    <nav
      aria-label="Report workflow"
      className="no-scrollbar -mx-1 overflow-x-auto px-1"
    >
      <ol className="flex min-w-max items-center gap-1">
        {REPORT_WORKFLOW.map((stage, position) => {
          const done = index > position;
          const here = index === position;
          return (
            <li key={stage} className="flex items-center gap-1">
              {position > 0 && (
                <ArrowRight
                  className="size-3 shrink-0 text-faint"
                  aria-hidden="true"
                />
              )}
              <span
                aria-current={here ? "step" : undefined}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] whitespace-nowrap ${
                  here
                    ? "bg-signal/10 font-medium text-signal-dark"
                    : done
                      ? "text-muted"
                      : "text-faint"
                }`}
              >
                {done ? (
                  <Check className="size-3" aria-hidden="true" />
                ) : here ? (
                  <CircleDot className="size-3" aria-hidden="true" />
                ) : null}
                {REPORT_STATUS_LABELS[stage]}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function ReportTable({
  reports,
  showCase = true,
}: {
  reports: Report[];
  showCase?: boolean;
}) {
  if (reports.length === 0) {
    return (
      <EmptyState
        title="No reports match those filters"
        description="A report is written on its case, where the findings and exhibits it cites already are."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Report</Th>
          {showCase && <Th>Case</Th>}
          <Th>Kind</Th>
          <Th>Where it is</Th>
          <Th>Author</Th>
          <Th className="text-right">Updated</Th>
        </tr>
      </thead>
      <tbody>
        {reports.map((report) => (
          <tr key={report.id} className="transition-colors hover:bg-surface-sunken/60">
            <Td>
              <AppLink
                href={`/reports/${report.id}`}
                className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
              >
                {report.title}
              </AppLink>
              <span className="flex flex-wrap items-center gap-1.5">
                <Id>{report.reportId}</Id>
                {report.current && (
                  <Muted>{report.current.versionLabel}</Muted>
                )}
                {report.approvedVersionId && (
                  <Badge tone="ok">
                    <Lock className="size-3" aria-hidden="true" />
                    approved
                  </Badge>
                )}
              </span>
            </Td>
            {showCase && (
              <Td className="text-xs">
                <AppLink
                  href={`/cases/${report.caseId}`}
                  className="text-signal-dark hover:underline"
                >
                  {report.caseReference}
                </AppLink>
              </Td>
            )}
            <Td className="text-xs text-muted">
              {REPORT_TYPE_LABELS[report.reportType]}
            </Td>
            <Td>
              <ReportStatusBadge status={report.status} />
            </Td>
            <Td className="text-xs text-muted">
              {report.authorName ?? <NotSet />}
            </Td>
            <Td className="text-right text-xs whitespace-nowrap text-muted">
              {when(report.updatedAt)}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * The sections of the working version, with what each one cites.
 *
 * The citations are shown under the text rather than beside it, because a
 * reader reads the statement first and then asks what it rests on, which is
 * also the order a QA reviewer works in.
 */
export function SectionList({
  sections,
  children,
}: {
  sections: ReportSection[];
  /** Per-section controls, rendered by the caller. */
  children?: (section: ReportSection) => React.ReactNode;
}) {
  if (sections.length === 0) {
    return (
      <EmptyState
        title="No sections yet"
        description="A report is built from sections, each citing the finding or exhibit it rests on."
      />
    );
  }

  return (
    <ol className="space-y-3">
      {sections.map((section) => {
        const needsCitation =
          ["narrative", "finding", "analysis", "conclusion", "recommendation"].includes(
            section.sectionType,
          ) &&
          (section.body?.trim().length ?? 0) > 0 &&
          section.citations.length === 0;

        return (
          <li
            key={section.id}
            className={`rounded-lg border p-3 ${
              needsCitation ? "border-warn/40 bg-warn/5" : "border-line"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] text-faint">
                {section.position}
              </span>
              <span className="text-xs font-semibold text-body">
                {section.heading}
              </span>
              <Badge tone="neutral">
                {SECTION_TYPE_LABELS[section.sectionType]}
              </Badge>
              {needsCitation && (
                <Badge tone="warn">
                  <Quote className="size-3" aria-hidden="true" />
                  Cites nothing
                </Badge>
              )}
            </div>

            {section.body && (
              <p className="mt-2 text-xs whitespace-pre-line text-body">
                {section.body}
              </p>
            )}

            {section.citations.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
                {section.citations.map((citation) => (
                  <li key={citation.id}>
                    <AppLink
                      href={citation.href}
                      className="inline-flex max-w-64 items-center gap-1.5 rounded-lg border border-line px-2 py-1 transition-colors hover:border-signal/50 hover:bg-signal/5"
                    >
                      <span className="text-[10px] text-faint">
                        {CITATION_TYPE_LABELS[citation.citationType]}
                      </span>
                      <span className="font-mono text-[10px] text-signal-dark">
                        {citation.targetReference}
                      </span>
                      <span className="min-w-0 truncate text-[11px] text-muted">
                        {citation.targetLabel}
                      </span>
                    </AppLink>
                  </li>
                ))}
              </ul>
            )}

            {needsCitation && (
              <p className="mt-2 text-[11px] text-warn">
                This asserts something and cites nothing. PRD 10.2 wants every
                statement to cite the finding or exhibit it rests on, and a QA
                reviewer will send it back for exactly this.
              </p>
            )}

            {children?.(section)}
          </li>
        );
      })}
    </ol>
  );
}

export function ReportVersionHistory({
  versions,
  approvedVersionId,
}: {
  versions: ReportVersion[];
  approvedVersionId: string | null;
}) {
  if (versions.length === 0) {
    return <Muted>No versions.</Muted>;
  }

  return (
    <ol className="space-y-2">
      {versions.map((version) => (
        <li
          key={version.id}
          className={`rounded-lg border p-3 ${
            version.isCurrent ? "border-signal/40 bg-signal/5" : "border-line"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-body">
              {version.versionLabel}
            </span>
            {version.isCurrent && <Badge tone="info">Working version</Badge>}
            {version.id === approvedVersionId && (
              <Badge tone="ok">
                <Lock className="size-3" aria-hidden="true" />
                Approved and locked
              </Badge>
            )}
            <Muted>{version.sectionCount} sections</Muted>
            <span className="ml-auto text-[11px] whitespace-nowrap text-muted">
              {at(version.createdAt)}
              {version.createdByName ? ` by ${version.createdByName}` : ""}
            </span>
          </div>

          {version.changeNote && (
            <p className="mt-1 text-[11px] text-muted">
              What changed: {version.changeNote}
            </p>
          )}

          {version.isApproved && (
            <p className="mt-1 text-[11px] text-ok">
              Approved {version.approvedAt ? at(version.approvedAt) : ""}
              {version.approvedByName ? ` by ${version.approvedByName}` : ""}.
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Every stage, with who decided it and when (PRD 10.1).
 *
 * Append-only: the database refuses a change to one of these rows, which is
 * what makes it a history rather than a status field somebody rewrote.
 */
export function WorkflowHistory({ history }: { history: ReportTransition[] }) {
  if (history.length === 0) {
    return (
      <Muted>
        Nothing yet. Each stage is recorded here with who decided it, when and
        what they said.
      </Muted>
    );
  }

  return (
    <ol className="space-y-0">
      {history.map((entry, index) => (
        <li
          key={entry.id}
          className={`relative border-l-2 pl-4 pb-4 ${
            entry.decision === "returned" ? "border-warn/60" : "border-signal/40"
          } ${index === history.length - 1 ? "pb-0" : ""}`}
        >
          <span
            className={`absolute -left-[5px] top-1.5 size-2 rounded-full ${
              entry.decision === "returned" ? "bg-warn" : "bg-signal"
            }`}
            aria-hidden="true"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-body">
              {REPORT_STATUS_LABELS[entry.fromStatus as ReportStatus] ??
                entry.fromStatus}
            </span>
            <ArrowRight className="size-3 text-faint" aria-hidden="true" />
            <span className="text-xs font-semibold text-body">
              {REPORT_STATUS_LABELS[entry.toStatus as ReportStatus] ??
                entry.toStatus}
            </span>
            {entry.decision === "returned" && (
              <Badge tone="warn">
                <Undo2 className="size-3" aria-hidden="true" />
                Returned
              </Badge>
            )}
            {entry.versionLabel && <Muted>{entry.versionLabel}</Muted>}
            <span className="ml-auto text-[11px] whitespace-nowrap text-muted">
              {at(entry.decidedAt)}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-faint">
            {entry.decidedByName ?? "somebody"}
          </p>
          {entry.notes && (
            <p className="mt-1 text-[11px] text-body">{entry.notes}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * A QA review, as the twelve checks of PRD 10.3.
 *
 * The result is shown as derived rather than chosen: a review with a failed
 * item is a return, whatever the reviewer meant to click, and the screen says
 * so before they finish.
 */
export function QaReviewView({
  review,
  checklist,
  children,
}: {
  review: QaReview;
  checklist: Array<{ key: string; label: string; guidance: string | null }>;
  children?: (item: { key: string; label: string; guidance: string | null }) => React.ReactNode;
}) {
  const answers = new Map(review.items.map((item) => [item.itemKey, item]));
  const failed = review.items.filter((item) => item.result === "fail").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={review.completedAt ? (review.result === "approved" ? "ok" : "warn") : "info"}>
          {review.completedAt
            ? review.result === "approved"
              ? "Passed"
              : "Returned for correction"
            : "In progress"}
        </Badge>
        <Muted>
          {review.items.length} of {checklist.length} answered
        </Muted>
        {failed > 0 && (
          <Badge tone="warn">
            {failed} {failed === 1 ? "failure" : "failures"}
          </Badge>
        )}
        <span className="ml-auto text-[11px] text-muted">
          {review.reviewerName ?? "a reviewer"}, {review.versionLabel}
        </span>
      </div>

      {!review.completedAt && failed > 0 && (
        <p className="rounded-lg border border-warn/40 bg-warn/5 p-2 text-[11px] text-body">
          With a failed check this review can only be a return, which is the
          one thing a checklist is for.
        </p>
      )}

      <ol className="space-y-2">
        {checklist.map((item) => {
          const answer = answers.get(item.key);
          return (
            <li
              key={item.key}
              className={`rounded-lg border p-3 ${
                answer?.result === "fail"
                  ? "border-warn/40 bg-warn/5"
                  : answer?.result === "pass"
                    ? "border-ok/30"
                    : "border-line"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-body">{item.label}</span>
                {answer ? (
                  <Badge
                    tone={
                      answer.result === "pass"
                        ? "ok"
                        : answer.result === "fail"
                          ? "warn"
                          : "neutral"
                    }
                  >
                    {QA_RESULT_LABELS[answer.result]}
                  </Badge>
                ) : (
                  <Badge tone="neutral">Not answered</Badge>
                )}
              </div>
              {item.guidance && (
                <p className="mt-1 text-[11px] text-faint">{item.guidance}</p>
              )}
              {answer?.comment && (
                <p className="mt-1 text-[11px] text-body">{answer.comment}</p>
              )}
              {children?.(item)}
            </li>
          );
        })}
      </ol>

      {review.summary && (
        <p className="rounded-lg border border-line bg-surface-sunken p-3 text-xs text-body">
          {review.summary}
        </p>
      )}
    </div>
  );
}

export function DeliveryList({ deliveries }: { deliveries: Delivery[] }) {
  if (deliveries.length === 0) {
    return (
      <Muted>
        Nothing delivered yet. A client delivery is recorded with who it went
        to, how, when, and what they said back.
      </Muted>
    );
  }

  return (
    <ul className="space-y-2">
      {deliveries.map((delivery) => (
        <li key={delivery.id} className="rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <ShieldCheck className="size-3.5 text-faint" aria-hidden="true" />
            <span className="font-medium text-body">{delivery.deliveredTo}</span>
            <Badge tone="neutral">
              {DELIVERY_METHOD_LABELS[delivery.deliveryMethod]}
            </Badge>
            <Muted>{delivery.versionLabel}</Muted>
            {delivery.acknowledgedAt ? (
              <Badge tone="ok">
                <CheckCircle2 className="size-3" aria-hidden="true" />
                Acknowledged
              </Badge>
            ) : (
              <Badge tone="warn">No acknowledgement yet</Badge>
            )}
            <span className="ml-auto text-[11px] whitespace-nowrap text-muted">
              {at(delivery.deliveredAt)}
            </span>
          </div>

          <p className="mt-1 text-[11px] text-faint">
            Sent by {delivery.deliveredByName ?? "somebody"}
          </p>

          {delivery.notes && (
            <p className="mt-1 text-[11px] text-muted">{delivery.notes}</p>
          )}

          {delivery.acknowledgement && (
            <p className="mt-1 text-[11px] text-body">
              {delivery.acknowledgedByName ?? "The client"}:{" "}
              {delivery.acknowledgement}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------------------- closure */

/**
 * PRD 5.9's nine requirements, as a gate.
 *
 * Every one is shown whether or not it is met, with what to do about it. The
 * three the platform answers for itself are marked, because the difference
 * between "somebody said the report was approved" and "a report is approved"
 * is the difference between a checklist and assurance.
 */
export function ClosureGate({ items }: { items: ClosureGateItem[] }) {
  return (
    <ol className="space-y-2">
      {items.map((item) => (
        <li
          key={item.key}
          className={`rounded-lg border p-3 ${
            item.met ? "border-ok/30" : "border-warn/40 bg-warn/5"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            {item.met ? (
              <CheckCircle2 className="size-3.5 text-ok" aria-hidden="true" />
            ) : (
              <CircleDot className="size-3.5 text-warn" aria-hidden="true" />
            )}
            <span className="text-xs font-medium text-body">{item.label}</span>
            {item.computed && (
              <Badge tone="neutral">
                <Scale className="size-3" aria-hidden="true" />
                Read from the records
              </Badge>
            )}
          </div>
          {!item.met && (
            <p className="mt-1 text-[11px] text-muted">{item.remedy}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

export function ClosureSummary({ closure }: { closure: CaseClosure }) {
  const lessons: Array<[string, string | null]> = [
    ["What worked", closure.whatWorked],
    ["What did not", closure.whatDidNotWork],
    ["Challenges", closure.challenges],
    ["New sources discovered", closure.newSources],
    ["New typologies", closure.newTypologies],
    ["Methodological lessons", closure.methodologicalLessons],
    ["Recommendations", closure.recommendations],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={
            closure.status === "approved"
              ? "ok"
              : closure.status === "returned"
                ? "warn"
                : "info"
          }
        >
          {CLOSURE_STATUS_LABELS[closure.status]}
        </Badge>
        <Muted>
          Kept under {closure.retentionClassName ?? closure.retentionClass}
        </Muted>
        {closure.contributeToKnowledgeBase && (
          <Badge tone="info">
            <FileSearch className="size-3" aria-hidden="true" />
            Offered to the knowledge base
          </Badge>
        )}
        <span className="ml-auto text-[11px] text-muted">
          <User className="mr-1 inline size-3" aria-hidden="true" />
          {closure.proposedByName ?? "somebody"}, {at(closure.proposedAt)}
        </span>
      </div>

      {closure.reviewNotes && (
        <p className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs text-body">
          {closure.approvedByName ?? "The supervisor"}: {closure.reviewNotes}
        </p>
      )}

      <dl className="space-y-3 text-xs">
        {(
          [
            ["Objectives", closure.objectivesOutcome],
            ["Evidence", closure.evidenceDisposition],
            ["Outstanding issues", closure.outstandingIssues],
            ["Financial status", closure.financialStatus],
          ] as Array<[string, string | null]>
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
              {label}
            </dt>
            <dd className="mt-0.5 whitespace-pre-line text-body">
              {value?.trim() ? value : <Muted>not recorded</Muted>}
            </dd>
          </div>
        ))}
      </dl>

      {lessons.some(([, value]) => value?.trim()) && (
        <div className="border-t border-line pt-4">
          <p className="mb-2 flex items-center gap-1.5 text-[10.5px] font-medium tracking-wide text-faint uppercase">
            <FileText className="size-3" aria-hidden="true" />
            Lessons learned
          </p>
          <dl className="space-y-3 text-xs">
            {lessons
              .filter(([, value]) => value?.trim())
              .map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                    {label}
                  </dt>
                  <dd className="mt-0.5 whitespace-pre-line text-body">{value}</dd>
                </div>
              ))}
          </dl>
        </div>
      )}
    </div>
  );
}

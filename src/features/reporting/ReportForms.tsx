"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Gavel,
  Plus,
  Quote,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Muted,
  Select,
  Textarea,
} from "@/components/ui";
import {
  CITATION_TYPES,
  CITATION_TYPE_LABELS,
  DELIVERY_METHODS,
  DELIVERY_METHOD_LABELS,
  QA_RESULTS,
  QA_RESULT_LABELS,
  REPORT_STATUS_LABELS,
  REPORT_TYPES,
  REPORT_TYPE_LABELS,
  SECTION_TYPES,
  SECTION_TYPE_LABELS,
  allowedReportTransitions,
  nextReportVersionLabel,
  type CaseClosure,
  type ClosureGateItem,
  type QaReview,
  type Report,
  type ReportSection,
  type ReportVersion,
  type RetentionClass,
} from "@/modules/reporting/shared";
import {
  acknowledgeDelivery,
  addSection,
  addVersion,
  answerQaItem,
  cite,
  completeQaReview,
  createReport,
  decideClosure,
  moveSection,
  openQaReview,
  proposeClosure,
  recordDelivery,
  removeReport,
  removeSection,
  setReportStatus,
  uncite,
  updateReport,
  updateSection,
  updateVersion,
} from "./actions";

/** The forms that write reports, QA results, deliveries and closures. */

type Person = { id: string; name: string };
type Level = { code: string; name: string };
type Option = { id: string; reference: string; label: string };

/* -------------------------------------------------------------- reports */

export function ReportForm({
  caseRecordId,
  report,
  people,
  levels,
  defaultClassification,
  actorId,
}: {
  caseRecordId: string;
  report?: Report;
  people: Person[];
  levels: Level[];
  defaultClassification: string;
  actorId: string;
}) {
  const editing = report !== undefined;

  return (
    <ActionForm
      action={editing ? updateReport : createReport}
      submitLabel={editing ? "Save" : "Start the report"}
      submitSize="sm"
      hidden={
        editing
          ? {
              caseRecordId,
              reportRecordId: report.id,
              expectedVersion: report.version,
            }
          : { caseRecordId }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field
              label="Title"
              htmlFor="rpt-title"
              required
              hint="What the client will see on the front page."
              error={state.fieldErrors?.title}
            >
              <Input
                id="rpt-title"
                name="title"
                defaultValue={report?.title ?? ""}
                placeholder="Investigation into three unauthorised payments"
              />
            </Field>
          </div>

          <Field
            label="Kind of report"
            htmlFor="rpt-type"
            required
            error={state.fieldErrors?.reportType}
          >
            <Select
              id="rpt-type"
              name="reportType"
              defaultValue={report?.reportType ?? "investigation_report"}
            >
              {REPORT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {REPORT_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>

          {!editing && (
            <Field
              label="Author"
              htmlFor="rpt-author"
              required
              hint="Whoever writes it. They can put it forward, and cannot be the one who passes it on."
              error={state.fieldErrors?.author}
            >
              <Select id="rpt-author" name="author" defaultValue={actorId}>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label="Classification"
            htmlFor="rpt-classification"
            required
            hint="Decides who can open it at all, and what the banner says."
            error={state.fieldErrors?.classification}
          >
            <Select
              id="rpt-classification"
              name="classification"
              defaultValue={report?.classification ?? defaultClassification}
            >
              {levels.map((level) => (
                <option key={level.code} value={level.code}>
                  {level.name}
                </option>
              ))}
            </Select>
          </Field>

          {!editing && (
            <>
              <div className="sm:col-span-2">
                <Field
                  label="Executive summary"
                  htmlFor="rpt-summary"
                  hint="The thing a client reads first, and sometimes the only thing."
                  error={state.fieldErrors?.executiveSummary}
                >
                  <Textarea id="rpt-summary" name="executiveSummary" rows={3} />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field
                  label="Scope"
                  htmlFor="rpt-scope"
                  hint="What was investigated, and what was explicitly not."
                  error={state.fieldErrors?.scopeStatement}
                >
                  <Textarea id="rpt-scope" name="scopeStatement" rows={2} />
                </Field>
              </div>
            </>
          )}
        </div>
      )}
    </ActionForm>
  );
}

/** The front matter of the working version. */
export function VersionForm({
  caseRecordId,
  report,
  version,
}: {
  caseRecordId: string;
  report: Report;
  version: ReportVersion;
}) {
  if (version.isApproved) {
    return (
      <Alert tone="info">
        {version.versionLabel} is approved and locked. A change from here is the
        next version, with a reason, approved again (PRD 10.2).
      </Alert>
    );
  }

  return (
    <ActionForm
      action={updateVersion}
      submitLabel="Save"
      submitSize="sm"
      hidden={{
        caseRecordId,
        reportRecordId: report.id,
        versionId: version.id,
        expectedVersion: version.version,
      }}
    >
      {(state) => (
        <div className="space-y-3">
          {(
            [
              [
                "executiveSummary",
                "Executive summary",
                version.executiveSummary,
                3,
              ],
              ["scopeStatement", "Scope", version.scopeStatement, 2],
              ["methodology", "Methodology", version.methodology, 2],
              ["limitations", "Limitations", version.limitations, 2],
              ["conclusion", "Conclusion", version.conclusion, 3],
            ] as Array<[string, string, string | null, number]>
          ).map(([name, label, value, rows]) => (
            <Field
              key={name}
              label={label}
              htmlFor={`ver-${name}`}
              error={state.fieldErrors?.[name]}
            >
              <Textarea
                id={`ver-${name}`}
                name={name}
                rows={rows}
                defaultValue={value ?? ""}
              />
            </Field>
          ))}
        </div>
      )}
    </ActionForm>
  );
}

export function AddVersionForm({
  caseRecordId,
  report,
}: {
  caseRecordId: string;
  report: Report;
}) {
  const [intent, setIntent] = useState<"draft" | "final">("draft");
  const replacingApproved = report.current?.isApproved ?? false;

  return (
    <ActionForm
      action={addVersion}
      submitLabel={`Start ${nextReportVersionLabel(report.current, intent)}`}
      submitSize="sm"
      hidden={{ caseRecordId, reportRecordId: report.id }}
    >
      {(state) => (
        <div className="space-y-3">
          {replacingApproved && (
            <Alert tone="warn" title="This replaces an approved version">
              {report.current?.versionLabel} is approved and locked, so it stays
              exactly as it is and a client who has read it still reads true.
              Everything in it is carried forward into the new version.
            </Alert>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="This version is"
              htmlFor="rv-intent"
              hint={`Will be ${nextReportVersionLabel(report.current, intent)}.`}
              error={state.fieldErrors?.intent}
            >
              <Select
                id="rv-intent"
                name="intent"
                defaultValue="draft"
                onChange={(event) =>
                  setIntent(event.target.value as "draft" | "final")
                }
              >
                <option value="draft">A further draft</option>
                <option value="final">A new final version</option>
              </Select>
            </Field>

            <div className="sm:col-span-2">
              <Field
                label="What changed"
                htmlFor="rv-note"
                required={replacingApproved}
                hint={
                  replacingApproved
                    ? "Required, because this replaces a version somebody approved."
                    : "Optional, and read by whoever compares the two."
                }
                error={state.fieldErrors?.changeNote}
              >
                <Textarea id="rv-note" name="changeNote" rows={2} />
              </Field>
            </div>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/* ------------------------------------------------------------- sections */

export function SectionForm({
  caseRecordId,
  report,
  versionId,
  section,
}: {
  caseRecordId: string;
  report: Report;
  versionId: string;
  section?: ReportSection;
}) {
  const editing = section !== undefined;

  return (
    <ActionForm
      action={editing ? updateSection : addSection}
      submitLabel={editing ? "Save" : "Add the section"}
      submitSize="sm"
      hidden={
        editing
          ? {
              caseRecordId,
              reportRecordId: report.id,
              sectionId: section.id,
              expectedVersion: section.version,
            }
          : { caseRecordId, reportRecordId: report.id, versionId }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Heading"
            htmlFor={`sec-heading-${section?.id ?? "new"}`}
            required
            error={state.fieldErrors?.heading}
          >
            <Input
              id={`sec-heading-${section?.id ?? "new"}`}
              name="heading"
              defaultValue={section?.heading ?? ""}
              placeholder="The three payments"
            />
          </Field>

          <Field
            label="What kind"
            htmlFor={`sec-type-${section?.id ?? "new"}`}
            required
            hint="A narrative, finding, analysis, conclusion or recommendation has to cite what it rests on."
            error={state.fieldErrors?.sectionType}
          >
            <Select
              id={`sec-type-${section?.id ?? "new"}`}
              name="sectionType"
              defaultValue={section?.sectionType ?? "narrative"}
            >
              {SECTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SECTION_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="The text"
              htmlFor={`sec-body-${section?.id ?? "new"}`}
              error={state.fieldErrors?.body}
            >
              <Textarea
                id={`sec-body-${section?.id ?? "new"}`}
                name="body"
                rows={6}
                defaultValue={section?.body ?? ""}
                placeholder="On 14 April 2026 three payments of GHS 45,000 were made to account 1234567. None carried a purchase order reference."
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/** The per-section controls: move, cite, remove. */
export function SectionControls({
  caseRecordId,
  report,
  section,
  citable,
}: {
  caseRecordId: string;
  report: Report;
  section: ReportSection;
  citable: {
    findings: Option[];
    evidence: Option[];
    documents: Option[];
    information: Option[];
  };
}) {
  const [citing, setCiting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [citationType, setCitationType] = useState<
    "finding" | "evidence" | "document" | "information"
  >("finding");

  const options =
    citationType === "finding"
      ? citable.findings
      : citationType === "evidence"
        ? citable.evidence
        : citationType === "document"
          ? citable.documents
          : citable.information;

  const kinds = CITATION_TYPES.filter((type) =>
    type === "finding"
      ? citable.findings.length > 0
      : type === "evidence"
        ? citable.evidence.length > 0
        : type === "document"
          ? citable.documents.length > 0
          : citable.information.length > 0,
  );

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <ActionForm
          action={moveSection}
          submitLabel={<ChevronUp className="size-3.5" aria-hidden="true" />}
          submitTone="ghost"
          submitSize="sm"
          hidden={{
            caseRecordId,
            reportRecordId: report.id,
            sectionId: section.id,
            direction: "up",
          }}
          compact
        />
        <ActionForm
          action={moveSection}
          submitLabel={<ChevronDown className="size-3.5" aria-hidden="true" />}
          submitTone="ghost"
          submitSize="sm"
          hidden={{
            caseRecordId,
            reportRecordId: report.id,
            sectionId: section.id,
            direction: "down",
          }}
          compact
        />
        <Button size="sm" tone="ghost" onClick={() => setEditing(!editing)}>
          {editing ? "Cancel" : "Edit"}
        </Button>
        {kinds.length > 0 && (
          <Button size="sm" tone="ghost" onClick={() => setCiting(!citing)}>
            <Quote className="size-3.5" aria-hidden="true" />
            {citing ? "Cancel" : "Cite something"}
          </Button>
        )}
        <ActionForm
          action={removeSection}
          submitLabel={<Trash2 className="size-3.5" aria-hidden="true" />}
          submitTone="ghost"
          submitSize="sm"
          hidden={{
            caseRecordId,
            reportRecordId: report.id,
            sectionId: section.id,
          }}
          confirm={`Remove "${section.heading}"? Its citations go with it.`}
          compact
        />
      </div>

      {section.citations.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {section.citations.map((citation) => (
            <ActionForm
              key={citation.id}
              action={uncite}
              submitLabel={`Remove ${citation.targetReference}`}
              submitTone="ghost"
              submitSize="sm"
              hidden={{
                caseRecordId,
                reportRecordId: report.id,
                citationId: citation.id,
              }}
              compact
            />
          ))}
        </div>
      )}

      {editing && (
        <div className="rounded-lg border border-line bg-surface-sunken p-3">
          <SectionForm
            caseRecordId={caseRecordId}
            report={report}
            versionId={section.versionId}
            section={section}
          />
        </div>
      )}

      {citing && (
        <div className="rounded-lg border border-line bg-surface-sunken p-3">
          <ActionForm
            action={cite}
            submitLabel="Cite it"
            submitSize="sm"
            hidden={{
              caseRecordId,
              reportRecordId: report.id,
              sectionId: section.id,
            }}
          >
            {(state) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="What kind"
                  htmlFor={`cite-type-${section.id}`}
                  required
                  hint="Only what a report may actually cite is offered: an accepted finding, a sound exhibit, an approved document."
                >
                  <Select
                    id={`cite-type-${section.id}`}
                    name="citationType"
                    defaultValue={kinds[0]}
                    onChange={(event) =>
                      setCitationType(event.target.value as typeof citationType)
                    }
                  >
                    {kinds.map((type) => (
                      <option key={type} value={type}>
                        {CITATION_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  label="Which one"
                  htmlFor={`cite-target-${section.id}`}
                  required
                  error={state.fieldErrors?.targetId}
                >
                  <Select id={`cite-target-${section.id}`} name="targetId">
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.reference} {option.label.slice(0, 70)}
                      </option>
                    ))}
                  </Select>
                </Field>

                <div className="sm:col-span-2">
                  <Field
                    label="Note"
                    htmlFor={`cite-note-${section.id}`}
                    error={state.fieldErrors?.note}
                  >
                    <Input
                      id={`cite-note-${section.id}`}
                      name="note"
                      placeholder="Page 4 shows the three payments"
                    />
                  </Field>
                </div>
              </div>
            )}
          </ActionForm>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------- the workflow */

/**
 * Moving a report along PRD 10.1's line.
 *
 * The select offers only the moves this person can make: the author can put
 * it forward and withdraw it, and somebody else decides. Offering "approve"
 * to the author would be offering something the server refuses.
 */
export function ReportStatusForm({
  caseRecordId,
  report,
  isOwnReport,
  canApprove,
  canEdit,
}: {
  caseRecordId: string;
  report: Report;
  isOwnReport: boolean;
  canApprove: boolean;
  canEdit: boolean;
}) {
  const all = allowedReportTransitions(report.status);

  const offered = all.filter((status) => {
    // Putting it forward the first time, and withdrawing it, are the
    // author's. Everything else is somebody reading it and deciding.
    if (status === "investigator_review" || status === "withdrawn") {
      return canEdit;
    }
    if (status === "final") return canApprove && !isOwnReport;
    return canEdit && !isOwnReport;
  });

  const [target, setTarget] = useState(offered[0] ?? "");

  /*
   * Said whenever it is true, not only when there is nothing else to offer.
   *
   * The author of a report under review can still withdraw it, so `offered`
   * is never empty and this used to go unsaid: they saw a status control
   * holding "withdrawn" alone, with no indication that the review stages
   * exist and are deliberately somebody else's. "The screen says why rather
   * than offering a form the server would refuse" is the rule everywhere
   * else here, and a control quietly missing its main options is the same
   * failure in a quieter form. The findings panel had the identical bug.
   */
  const ownUnderReview = isOwnReport && report.status !== "draft";
  const whoDecides = ownUnderReview ? (
    <Alert tone="info">
      You wrote this report, so you cannot be the one who passes it on. Somebody
      other than its author has to, which is the only thing that makes the
      review worth having (PRD 10.1).
    </Alert>
  ) : null;

  if (offered.length === 0) {
    if (ownUnderReview) {
      return whoDecides;
    }
    if (report.status === "delivered") {
      return (
        <Muted>
          Delivered, so this report is history. A correction is the next
          version, which starts as a draft on the same report.
        </Muted>
      );
    }
    return <Muted>Nothing for you to do with this report at the moment.</Muted>;
  }

  const deciding = target !== "investigator_review" && target !== "withdrawn";

  return (
    <div className="space-y-3">
      {whoDecides}
      <ActionForm
        action={setReportStatus}
        submitLabel={
          <>
            <Send className="size-4" aria-hidden="true" />
            {deciding ? "Record the decision" : "Put it forward"}
          </>
        }
        submitSize="sm"
        hidden={{ caseRecordId, reportRecordId: report.id }}
      >
        {(state) => (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Move it to"
              htmlFor="rpt-status"
              required
              error={state.fieldErrors?.status}
            >
              <Select
                id="rpt-status"
                name="status"
                defaultValue={offered[0]}
                onChange={(event) =>
                  setTarget(event.target.value as typeof target)
                }
              >
                {offered.map((status) => (
                  <option key={status} value={status}>
                    {REPORT_STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="sm:col-span-2">
              <Field
                label="Your note"
                htmlFor="rpt-notes"
                required={target === "draft"}
                hint={
                  target === "draft"
                    ? "Say what needs doing. A report returned with no note is one nobody can act on."
                    : "Recorded against this stage, and read by whoever looks at the history."
                }
                error={state.fieldErrors?.notes}
              >
                <Textarea id="rpt-notes" name="notes" rows={2} />
              </Field>
            </div>
          </div>
        )}
      </ActionForm>
    </div>
  );
}

/* ------------------------------------------------------------------- QA */

export function OpenQaForm({
  caseRecordId,
  report,
  versionId,
}: {
  caseRecordId: string;
  report: Report;
  versionId: string;
}) {
  return (
    <ActionForm
      action={openQaReview}
      submitLabel="Start a QA review"
      submitSize="sm"
      hidden={{ caseRecordId, reportRecordId: report.id, versionId }}
    />
  );
}

export function QaItemForm({
  caseRecordId,
  report,
  review,
  itemKey,
  current,
}: {
  caseRecordId: string;
  report: Report;
  review: QaReview;
  itemKey: string;
  current?: { result: string; comment: string | null };
}) {
  const [result, setResult] = useState(current?.result ?? "pass");

  return (
    <div className="mt-2 border-t border-line pt-2">
      <ActionForm
        action={answerQaItem}
        submitLabel="Record"
        submitSize="sm"
        hidden={{
          caseRecordId,
          reportRecordId: report.id,
          reviewId: review.id,
          itemKey,
        }}
        compact
      >
        {(state) => (
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Result" htmlFor={`qa-${itemKey}`} required>
              <Select
                id={`qa-${itemKey}`}
                name="result"
                defaultValue={current?.result ?? "pass"}
                onChange={(event) => setResult(event.target.value)}
              >
                {QA_RESULTS.map((value) => (
                  <option key={value} value={value}>
                    {QA_RESULT_LABELS[value]}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="sm:col-span-2">
              <Field
                label="Comment"
                htmlFor={`qa-comment-${itemKey}`}
                required={result === "fail"}
                hint={
                  result === "fail"
                    ? "Required: a failure with no comment tells the author nothing."
                    : undefined
                }
                error={state.fieldErrors?.comment}
              >
                <Input
                  id={`qa-comment-${itemKey}`}
                  name="comment"
                  defaultValue={current?.comment ?? ""}
                />
              </Field>
            </div>
          </div>
        )}
      </ActionForm>
    </div>
  );
}

export function CompleteQaForm({
  caseRecordId,
  report,
  review,
  answered,
  total,
  failed,
}: {
  caseRecordId: string;
  report: Report;
  review: QaReview;
  answered: number;
  total: number;
  failed: number;
}) {
  if (answered < total) {
    return (
      <Muted>
        {total - answered}{" "}
        {total - answered === 1 ? "check has" : "checks have"} not been
        answered. An unanswered check is one nobody looked at.
      </Muted>
    );
  }

  return (
    <ActionForm
      action={completeQaReview}
      submitLabel={
        <>
          <Gavel className="size-4" aria-hidden="true" />
          {failed > 0 ? "Return for correction" : "Pass it"}
        </>
      }
      submitTone={failed > 0 ? "danger" : "primary"}
      submitSize="sm"
      hidden={{ caseRecordId, reportRecordId: report.id, reviewId: review.id }}
      confirm={
        failed > 0
          ? `Return this report? ${failed} of the twelve checks failed, and it goes back to its author.`
          : "Pass this report? It moves on for approval."
      }
    >
      {(state) => (
        <Field
          label="Summary for the author"
          htmlFor="qa-summary"
          hint="What they should take from the review as a whole."
          error={state.fieldErrors?.summary}
        >
          <Textarea id="qa-summary" name="summary" rows={2} />
        </Field>
      )}
    </ActionForm>
  );
}

/* -------------------------------------------------------------- delivery */

export function DeliveryForm({
  caseRecordId,
  report,
  approvedVersionId,
  approvedVersionLabel,
}: {
  caseRecordId: string;
  report: Report;
  approvedVersionId: string | null;
  approvedVersionLabel: string | null;
}) {
  if (!approvedVersionId) {
    return (
      <Muted>
        No version has been approved, so there is nothing to send a client. A
        report goes out once it is final.
      </Muted>
    );
  }

  return (
    <ActionForm
      action={recordDelivery}
      submitLabel="Record the delivery"
      submitSize="sm"
      hidden={{
        caseRecordId,
        reportRecordId: report.id,
        versionId: approvedVersionId,
      }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Delivered to"
            htmlFor="del-to"
            required
            hint="The person at the client, not the organisation."
            error={state.fieldErrors?.deliveredTo}
          >
            <Input
              id="del-to"
              name="deliveredTo"
              placeholder="Ama Boateng, Head of Risk"
            />
          </Field>

          <Field
            label="How"
            htmlFor="del-method"
            required
            error={state.fieldErrors?.deliveryMethod}
          >
            <Select
              id="del-method"
              name="deliveryMethod"
              defaultValue="secure_link"
            >
              {DELIVERY_METHODS.map((method) => (
                <option key={method} value={method}>
                  {DELIVERY_METHOD_LABELS[method]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Notes"
              htmlFor="del-notes"
              hint={`${approvedVersionLabel ?? "The approved version"} is what goes out.`}
              error={state.fieldErrors?.notes}
            >
              <Input
                id="del-notes"
                name="notes"
                placeholder="Signed link, valid for seven days"
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

export function AcknowledgeForm({
  caseRecordId,
  report,
  deliveryId,
}: {
  caseRecordId: string;
  report: Report;
  deliveryId: string;
}) {
  return (
    <ActionForm
      action={acknowledgeDelivery}
      submitLabel="Record the acknowledgement"
      submitSize="sm"
      hidden={{ caseRecordId, reportRecordId: report.id, deliveryId }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="What they said"
            htmlFor={`ack-${deliveryId}`}
            required
            error={state.fieldErrors?.acknowledgement}
          >
            <Input
              id={`ack-${deliveryId}`}
              name="acknowledgement"
              placeholder="Received, thank you."
            />
          </Field>

          <Field
            label="Who said it"
            htmlFor={`ack-by-${deliveryId}`}
            error={state.fieldErrors?.acknowledgedByName}
          >
            <Input id={`ack-by-${deliveryId}`} name="acknowledgedByName" />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function ReportRemovalPanel({
  caseRecordId,
  report,
  canRemove,
}: {
  caseRecordId: string;
  report: Report;
  canRemove: boolean;
}) {
  if (!canRemove || report.deletedAt !== null) return null;

  return (
    <Card
      title="Remove this report"
      description="Withdrawing it is usually the better record: a report that was written and abandoned is part of what the case did."
    >
      <ActionForm
        action={removeReport}
        submitLabel={
          <>
            <Trash2 className="size-4" aria-hidden="true" />
            Remove this report
          </>
        }
        submitTone="danger"
        submitSize="sm"
        hidden={{ caseRecordId, reportRecordId: report.id }}
        confirm={`Remove ${report.reportId}? It stays in the recycle bin.`}
      >
        {(state) => (
          <Field
            label="Reason for removal"
            htmlFor="rpt-remove-reason"
            required
            error={state.fieldErrors?.reason}
          >
            <Input
              id="rpt-remove-reason"
              name="reason"
              placeholder="Started against the wrong case"
            />
          </Field>
        )}
      </ActionForm>
    </Card>
  );
}

/* --------------------------------------------------------------- closure */

/**
 * Proposing a closure (PRD 5.9).
 *
 * Every field the gate reads is on one form, because closure is one decision
 * and splitting it across screens is how a case ends up half closed. The gate
 * itself is shown above it, so somebody filling this in can see what is still
 * missing while they can still do something about it.
 */
export function ClosureForm({
  caseRecordId,
  closure,
  retentionClasses,
}: {
  caseRecordId: string;
  closure: CaseClosure | null;
  retentionClasses: RetentionClass[];
}) {
  return (
    <ActionForm
      action={proposeClosure}
      submitLabel={closure ? "Put it forward again" : "Propose closure"}
      submitSize="sm"
      hidden={{ caseRecordId }}
    >
      {(state) => (
        <div className="space-y-4">
          <div className="space-y-3">
            <Field
              label="Objectives addressed"
              htmlFor="cl-objectives"
              required
              hint="Against each objective, whether it was met and how."
              error={state.fieldErrors?.objectivesOutcome}
            >
              <Textarea
                id="cl-objectives"
                name="objectivesOutcome"
                rows={3}
                defaultValue={closure?.objectivesOutcome ?? ""}
              />
            </Field>

            <Field
              label="Evidence accounted for"
              htmlFor="cl-evidence"
              required
              hint="Where every item is now, and what will happen to it. Anything still out on release has to come back first."
              error={state.fieldErrors?.evidenceDisposition}
            >
              <Textarea
                id="cl-evidence"
                name="evidenceDisposition"
                rows={2}
                defaultValue={closure?.evidenceDisposition ?? ""}
              />
            </Field>

            <Field
              label="Outstanding issues"
              htmlFor="cl-outstanding"
              required
              hint='Say what is left unresolved. "Nothing outstanding" is an answer; leaving it empty is not.'
              error={state.fieldErrors?.outstandingIssues}
            >
              <Textarea
                id="cl-outstanding"
                name="outstandingIssues"
                rows={2}
                defaultValue={closure?.outstandingIssues ?? ""}
              />
            </Field>

            <Field
              label="Financial status"
              htmlFor="cl-financial"
              required
              hint="What was billed, what was written off, what is outstanding."
              error={state.fieldErrors?.financialStatus}
            >
              <Textarea
                id="cl-financial"
                name="financialStatus"
                rows={2}
                defaultValue={closure?.financialStatus ?? ""}
              />
            </Field>

            <Field
              label="Retention class"
              htmlFor="cl-retention"
              required
              hint="How long this case file is kept, and under what rule."
              error={state.fieldErrors?.retentionClass}
            >
              <Select
                id="cl-retention"
                name="retentionClass"
                defaultValue={closure?.retentionClass ?? "standard_7"}
              >
                {retentionClasses.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="space-y-3 border-t border-line pt-4">
            <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
              Lessons learned
            </p>
            <p className="text-[11px] text-muted">
              This is what the next case gets from this one. Answer at least one
              of them; the rest only if this case taught something under that
              heading.
            </p>

            {(
              [
                ["whatWorked", "What worked", closure?.whatWorked],
                ["whatDidNotWork", "What did not", closure?.whatDidNotWork],
                ["challenges", "Challenges", closure?.challenges],
                ["newSources", "New sources discovered", closure?.newSources],
                [
                  "newTypologies",
                  "New fraud typologies",
                  closure?.newTypologies,
                ],
                [
                  "methodologicalLessons",
                  "Methodological lessons",
                  closure?.methodologicalLessons,
                ],
                [
                  "recommendations",
                  "Recommendations",
                  closure?.recommendations,
                ],
              ] as Array<[string, string, string | null | undefined]>
            ).map(([name, label, value]) => (
              <Field
                key={name}
                label={label}
                htmlFor={`cl-${name}`}
                error={state.fieldErrors?.[name]}
              >
                <Textarea
                  id={`cl-${name}`}
                  name={name}
                  rows={2}
                  defaultValue={value ?? ""}
                />
              </Field>
            ))}

            <label className="flex items-start gap-2 text-xs text-body">
              <input
                type="checkbox"
                name="contributeToKnowledgeBase"
                defaultChecked={closure?.contributeToKnowledgeBase ?? false}
                className="mt-0.5 size-4 rounded border-line-strong"
              />
              <span>
                Offer these lessons to the PDDC training and knowledge base.
                Somebody will read them, so at least one of what worked, the
                methodological lessons or the recommendations has to say
                something.
              </span>
            </label>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/**
 * The supervisor's decision on a closure (PRD 5.9).
 *
 * Offered to anybody but the person who proposed it, and the screen says why
 * when that is the reader.
 */
export function ClosureDecisionForm({
  caseRecordId,
  closure,
  isOwnProposal,
  canClose,
}: {
  caseRecordId: string;
  closure: CaseClosure;
  isOwnProposal: boolean;
  canClose: boolean;
}) {
  const [status, setStatus] = useState<"approved" | "returned">("approved");

  if (closure.status !== "proposed") return null;

  if (isOwnProposal) {
    return (
      <Alert tone="info">
        You proposed this closure, so you cannot approve it. PRD 5.9 gives that
        to a supervisor other than you, which is the only thing that makes the
        approval worth having.
      </Alert>
    );
  }

  if (!canClose) {
    return <Muted>Waiting on somebody who can close a case.</Muted>;
  }

  return (
    <ActionForm
      action={decideClosure}
      submitLabel={
        <>
          <Gavel className="size-4" aria-hidden="true" />
          Record the decision
        </>
      }
      submitSize="sm"
      hidden={{ caseRecordId }}
      confirm={
        status === "approved"
          ? "Approve this closure? The case closes and is archived: nothing more can be changed on it."
          : "Return this closure to its proposer?"
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Decision"
            htmlFor="cl-decision"
            required
            error={state.fieldErrors?.status}
          >
            <Select
              id="cl-decision"
              name="status"
              defaultValue="approved"
              onChange={(event) =>
                setStatus(event.target.value as "approved" | "returned")
              }
            >
              <option value="approved">Approve, which closes the case</option>
              <option value="returned">Return for more work</option>
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Your note"
              htmlFor="cl-notes"
              required={status === "returned"}
              hint={
                status === "returned"
                  ? "Say what still needs doing. A closure returned with no note is one nobody can act on."
                  : "Optional, and read by anybody who opens the archived case."
              }
              error={state.fieldErrors?.reviewNotes}
            >
              <Textarea id="cl-notes" name="reviewNotes" rows={2} />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/** A panel whose form opens on a button, gated on permission. */
export function Expandable({
  title,
  description,
  openLabel,
  canOpen = true,
  children,
  summary,
}: {
  title: string;
  description?: string;
  openLabel: string;
  canOpen?: boolean;
  children: React.ReactNode;
  summary?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card
      title={title}
      description={description}
      actions={
        canOpen ? (
          <Button
            size="sm"
            tone={open ? "ghost" : "primary"}
            onClick={() => setOpen(!open)}
            // The button controls a region it shows and hides, so it has to
            // say which state that region is in. A screen reader otherwise
            // announces "Draft a finding" whether the form is open or not.
            aria-expanded={open}
          >
            {open ? (
              <>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </>
            ) : (
              <>
                <Plus className="size-4" aria-hidden="true" />
                {openLabel}
              </>
            )}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {canOpen && open && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            {children}
          </div>
        )}
        {summary}
      </div>
    </Card>
  );
}

/** Shown above the closure form, so nothing is a surprise at the end. */
export function ClosureGateNotice({ items }: { items: ClosureGateItem[] }) {
  const blocking = items.filter((item) => !item.met);
  if (blocking.length === 0) {
    return (
      <Alert tone="info" title="Every requirement is met">
        All nine of PRD 5.9&apos;s requirements are satisfied, so this closure
        can be put to a supervisor.
      </Alert>
    );
  }

  return (
    <Alert
      tone="warn"
      title={`${blocking.length} ${blocking.length === 1 ? "requirement is" : "requirements are"} not met`}
    >
      PRD 5.9 blocks closure until every one is. The list below says what each
      needs, and the three marked &quot;read from the records&quot; are ones the
      platform answers itself: they cannot be ticked, only done.
    </Alert>
  );
}

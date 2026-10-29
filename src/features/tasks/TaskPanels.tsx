"use client";

import { useState } from "react";
import {
  CheckCircle2,
  ClipboardList,
  CornerUpLeft,
  FilePlus2,
  Pencil,
  Plus,
  Send,
  X,
} from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import {
  Alert,
  Badge,
  Button,
  Card,
  DescriptionList,
  EmptyState,
  Field,
  Id,
  Input,
  ListField,
  Muted,
  Select,
  StatTile,
  Textarea,
} from "@/components/ui";
import {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_LABELS,
  PLAN_STATUS_LABELS,
  type Activity,
  type InvestigationPlan,
  type PlanStatus,
  type PlanVersion,
  type Task,
} from "@/modules/casework/shared";
import {
  correctActivity,
  createPlanVersion,
  recordActivity,
  reviewPlanVersion,
  submitPlanVersion,
  updatePlanVersion,
} from "./actions";
import { TaskForm } from "./TaskForms";
import { TaskList, TaskViewSwitcher, TaskViews, type TaskView } from "./TaskViews";

/** The work section of a case page: tasks, the activity log and the plan. */

function when(value: string) {
  return new Date(value).toLocaleString("en-GB");
}

/* ------------------------------------------------------------------ tasks */

export function CaseTasksPanel({
  caseRecordId,
  tasks,
  summary,
  people,
  canCreate,
}: {
  caseRecordId: string;
  tasks: Task[];
  summary: { open: number; overdue: number; blocked: number; unassigned: number };
  people: Array<{ id: string; name: string }>;
  canCreate: boolean;
}) {
  const [view, setView] = useState<TaskView>("list");
  const [adding, setAdding] = useState(false);

  // The picker offers only open tasks as parents: hanging new work under
  // something already finished or cancelled is almost always a mistake, and
  // the parent could never be completed again without reopening it.
  const parentOptions = tasks
    .filter((t) => t.status !== "cancelled" && t.status !== "completed")
    .map((t) => ({ id: t.id, title: `${t.taskId} ${t.title}` }));

  return (
    <Card
      title="Work"
      description="The tasks on this case. Blocked and cancelled each need a reason, so a stalled task cannot go unexplained."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <TaskViewSwitcher current={view} onChange={setView} />
          {canCreate && !adding && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add a task
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Open" value={summary.open} />
          <StatTile
            label="Overdue"
            value={summary.overdue}
            tone={summary.overdue > 0 ? "danger" : "ok"}
          />
          <StatTile
            label="Blocked"
            value={summary.blocked}
            tone={summary.blocked > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Unassigned"
            value={summary.unassigned}
            tone={summary.unassigned > 0 ? "warn" : "neutral"}
          />
        </div>

        {adding && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Add a task</p>
              <Button size="sm" tone="ghost" onClick={() => setAdding(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <TaskForm
              caseRecordId={caseRecordId}
              people={people}
              parentOptions={parentOptions}
            />
          </div>
        )}

        {view === "list" ? (
          <TaskList tasks={tasks} showCase={false} />
        ) : (
          <TaskViews view={view} tasks={tasks} showCase={false} />
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------- activities */

/** The fields shared by recording an activity and correcting one. */
function ActivityFields({
  fieldErrors,
  idPrefix,
  tasks,
  levels,
  defaultClassification,
  activity,
  showTask = true,
}: {
  fieldErrors?: Record<string, string>;
  idPrefix: string;
  tasks: Task[];
  levels: Array<{ code: string; name: string }>;
  defaultClassification: string;
  activity?: Activity;
  showTask?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field
        label="Type"
        htmlFor={`${idPrefix}-type`}
        required
        error={fieldErrors?.activityType}
      >
        <Select
          id={`${idPrefix}-type`}
          name="activityType"
          defaultValue={activity?.activityType ?? "research"}
        >
          {ACTIVITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {ACTIVITY_TYPE_LABELS[type]}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="When it happened"
        htmlFor={`${idPrefix}-occurred`}
        hint="Leave empty for now."
        error={fieldErrors?.occurredAt}
      >
        <Input
          id={`${idPrefix}-occurred`}
          name="occurredAt"
          type="datetime-local"
          defaultValue={activity ? activity.occurredAt.slice(0, 16) : ""}
        />
      </Field>

      <div className="sm:col-span-2">
        <Field
          label="What was done"
          htmlFor={`${idPrefix}-description`}
          required
          error={fieldErrors?.description}
        >
          <Textarea
            id={`${idPrefix}-description`}
            name="description"
            rows={3}
            defaultValue={activity?.description ?? ""}
            placeholder="Searched the companies registry for the three named directors."
          />
        </Field>
      </div>

      <Field label="Where" htmlFor={`${idPrefix}-location`} error={fieldErrors?.location}>
        <Input
          id={`${idPrefix}-location`}
          name="location"
          defaultValue={activity?.location ?? ""}
        />
      </Field>

      <Field
        label="Classification"
        htmlFor={`${idPrefix}-classification`}
        required
        hint="May be stricter than the case: what was done can be more sensitive than the file it is on."
        error={fieldErrors?.classification}
      >
        <Select
          id={`${idPrefix}-classification`}
          name="classification"
          defaultValue={activity?.classification ?? defaultClassification}
        >
          {levels.map((level) => (
            <option key={level.code} value={level.code}>
              {level.name}
            </option>
          ))}
        </Select>
      </Field>

      {showTask && (
        <div className="sm:col-span-2">
          <Field
            label="Against which task"
            htmlFor={`${idPrefix}-task`}
            hint="Optional. Linking it means the task shows what was actually done."
            error={fieldErrors?.relatedTaskId}
          >
            <Select id={`${idPrefix}-task`} name="relatedTaskId" defaultValue="">
              <option value="">Not against a particular task</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.taskId} {task.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </div>
  );
}

/**
 * The case activity log (PRD 9.4).
 *
 * Append-only: there is no edit and no delete here, because there is none in
 * the database either. A mistake is put right by recording a correction that
 * points at the original, and both stay visible.
 */
export function ActivityLogPanel({
  caseRecordId,
  caseClassification,
  activities,
  tasks,
  levels,
  canEdit,
}: {
  caseRecordId: string;
  caseClassification: string;
  activities: Activity[];
  tasks: Task[];
  levels: Array<{ code: string; name: string }>;
  canEdit: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [correcting, setCorrecting] = useState<Activity | null>(null);

  return (
    <Card
      title="Activity log"
      description="What was actually done, in the order it was done. Append-only: a mistake is corrected by a new entry, never by changing an old one."
      actions={
        canEdit && !recording ? (
          <Button size="sm" onClick={() => setRecording(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Record an activity
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {recording && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Record an activity</p>
              <Button size="sm" tone="ghost" onClick={() => setRecording(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ActionForm
              action={recordActivity}
              submitLabel="Record it"
              submitSize="sm"
              hidden={{ caseRecordId }}
            >
              {(state) => (
                <ActivityFields
                  fieldErrors={state.fieldErrors}
                  idPrefix="activity"
                  tasks={tasks}
                  levels={levels}
                  defaultClassification={caseClassification}
                />
              )}
            </ActionForm>
          </div>
        )}

        {correcting && (
          <div className="rounded-lg border border-warn/40 bg-warn/5 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">
                Correct {correcting.activityId}
              </p>
              <Button size="sm" tone="ghost" onClick={() => setCorrecting(null)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <p className="mb-3 text-[11px] text-muted">
              This records a new entry that supersedes {correcting.activityId}. The
              original stays exactly as it is, which is what makes the log worth
              anything.
            </p>
            <ActionForm
              action={correctActivity}
              submitLabel="Record the correction"
              submitSize="sm"
              hidden={{ caseRecordId, correctsActivityId: correcting.id }}
            >
              {(state) => (
                <div className="space-y-3">
                  <Field
                    label="What was wrong with the original"
                    htmlFor="correction-reason"
                    required
                    error={state.fieldErrors?.correctionReason}
                  >
                    <Input
                      id="correction-reason"
                      name="correctionReason"
                      placeholder="Recorded against the wrong date"
                    />
                  </Field>
                  <ActivityFields
                    fieldErrors={state.fieldErrors}
                    idPrefix="correction"
                    tasks={tasks}
                    levels={levels}
                    defaultClassification={caseClassification}
                    activity={correcting}
                    showTask={false}
                  />
                </div>
              )}
            </ActionForm>
          </div>
        )}

        {activities.length === 0 ? (
          <EmptyState
            title="Nothing recorded yet"
            description="Record what was done as it is done. A log written at the end of a case is the one nobody believes."
          />
        ) : (
          <ol className="space-y-3">
            {activities.map((entry) => (
              <li
                key={entry.id}
                className={`rounded-lg border p-3 ${
                  entry.correctedByActivityId !== null
                    ? "border-line bg-surface-sunken/60"
                    : "border-line"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">
                    {ACTIVITY_TYPE_LABELS[entry.activityType]}
                  </Badge>
                  <Id>{entry.activityId}</Id>
                  {entry.correctsActivityId !== null && (
                    <Badge tone="warn">
                      Corrects {entry.correctsActivityReference ?? "an earlier entry"}
                    </Badge>
                  )}
                  {entry.correctedByActivityId !== null && (
                    <Badge tone="info">
                      Superseded by {entry.correctedByReference ?? "a later entry"}
                    </Badge>
                  )}
                  <span className="ml-auto text-[11px] whitespace-nowrap text-muted">
                    {when(entry.occurredAt)}
                  </span>
                </div>

                <p className="mt-2 text-xs whitespace-pre-line text-body">
                  {entry.description}
                </p>

                {entry.correctionReason && (
                  <p className="mt-1.5 text-[11px] text-warn">
                    Correction: {entry.correctionReason}
                  </p>
                )}

                <p className="mt-2 text-[11px] text-muted">
                  {entry.location ? `${entry.location}, ` : ""}
                  recorded {when(entry.recordedAt)}
                  {entry.recordedByName ? ` by ${entry.recordedByName}` : ""}
                </p>

                {entry.relatedTaskId && (
                  <p className="mt-1 text-[11px] text-muted">
                    Against {entry.relatedTaskTitle ?? "a task"}
                  </p>
                )}

                {canEdit && entry.correctedByActivityId === null && (
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" tone="ghost" onClick={() => setCorrecting(entry)}>
                      <Pencil className="size-3.5" aria-hidden="true" />
                      Correct this entry
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

/* -------------------------------------------------- investigation plan */

const PLAN_TONES: Record<PlanStatus, "neutral" | "info" | "warn" | "ok"> = {
  draft: "neutral",
  submitted: "info",
  approved: "ok",
  returned: "warn",
  superseded: "neutral",
};

/** The plan form, used to draft a version and to edit one still in draft. */
function PlanVersionForm({
  caseRecordId,
  version,
}: {
  caseRecordId: string;
  version?: PlanVersion;
}) {
  const [sources, setSources] = useState<string[]>(
    version?.sourcesToConsult.length ? version.sourcesToConsult : [""],
  );
  const [personnel, setPersonnel] = useState<string[]>(
    version?.assignedPersonnel.length ? version.assignedPersonnel : [""],
  );
  const [deliverables, setDeliverables] = useState<string[]>(
    version?.expectedDeliverables.length ? version.expectedDeliverables : [""],
  );

  return (
    <ActionForm
      action={version ? updatePlanVersion : createPlanVersion}
      submitLabel={
        version ? (
          "Save the plan"
        ) : (
          <>
            <FilePlus2 className="size-4" aria-hidden="true" />
            Draft the plan
          </>
        )
      }
      submitSize="sm"
      hidden={
        version
          ? { caseRecordId, versionId: version.id, expectedVersion: version.version }
          : { caseRecordId }
      }
    >
      {(state) => (
        <div className="space-y-3">
          <Field
            label="Objective"
            htmlFor="plan-objective"
            required
            hint="What this investigation is trying to establish."
            error={state.fieldErrors?.objective}
          >
            <Textarea
              id="plan-objective"
              name="objective"
              rows={3}
              defaultValue={version?.objective ?? ""}
            />
          </Field>

          <Field
            label="Scope"
            htmlFor="plan-scope"
            hint="What is in, and just as usefully what is out."
            error={state.fieldErrors?.scope}
          >
            <Textarea
              id="plan-scope"
              name="scope"
              rows={2}
              defaultValue={version?.scope ?? ""}
            />
          </Field>

          <Field
            label="Methodology"
            htmlFor="plan-methodology"
            required
            hint="How the work will actually be done, step by step."
            error={state.fieldErrors?.methodology}
          >
            <Textarea
              id="plan-methodology"
              name="methodology"
              rows={3}
              defaultValue={version?.methodology ?? ""}
            />
          </Field>

          <ListField
            label="Sources to consult"
            name="source"
            values={sources}
            onChange={setSources}
            placeholder="Companies registry"
            error={state.fieldErrors?.sourcesToConsult}
          />

          <ListField
            label="Personnel"
            name="personnel"
            values={personnel}
            onChange={setPersonnel}
            placeholder="Lead investigator"
            error={state.fieldErrors?.assignedPersonnel}
          />

          <ListField
            label="Expected deliverables"
            name="deliverable"
            values={deliverables}
            onChange={setDeliverables}
            placeholder="Written report with exhibits"
            error={state.fieldErrors?.expectedDeliverables}
          />

          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label="Timeline"
              htmlFor="plan-timeline"
              error={state.fieldErrors?.timeline}
            >
              <Textarea
                id="plan-timeline"
                name="timeline"
                rows={2}
                defaultValue={version?.timeline ?? ""}
              />
            </Field>
            <Field label="Risks" htmlFor="plan-risks" error={state.fieldErrors?.risks}>
              <Textarea
                id="plan-risks"
                name="risks"
                rows={2}
                defaultValue={version?.risks ?? ""}
              />
            </Field>
            <Field
              label="Resources"
              htmlFor="plan-resources"
              error={state.fieldErrors?.resources}
            >
              <Textarea
                id="plan-resources"
                name="resources"
                rows={2}
                defaultValue={version?.resources ?? ""}
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/**
 * A supervisor's decision on a submitted plan.
 *
 * Returning it needs notes, because "returned for changes" with nothing said
 * is a round trip that teaches the author nothing. The requirement is in the
 * domain rule as well, so this only announces it.
 */
function ReviewPlanForm({
  caseRecordId,
  versionId,
}: {
  caseRecordId: string;
  versionId: string;
}) {
  const [decision, setDecision] = useState("approve");

  return (
    <ActionForm
      action={reviewPlanVersion}
      submitLabel={
        decision === "approve" ? (
          <>
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Approve the plan
          </>
        ) : (
          <>
            <CornerUpLeft className="size-4" aria-hidden="true" />
            Return it for changes
          </>
        )
      }
      submitTone={decision === "approve" ? "primary" : "secondary"}
      submitSize="sm"
      hidden={{ caseRecordId, versionId }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Decision"
            htmlFor="plan-decision"
            required
            error={state.fieldErrors?.decision}
          >
            {/* Uncontrolled, for the reason TaskForms records: React resets
                a controlled field on hydration, so a decision made before
                the JavaScript arrived would be thrown away. */}
            <Select
              id="plan-decision"
              name="decision"
              defaultValue="approve"
              onChange={(e) => setDecision(e.target.value)}
            >
              <option value="approve">Approve</option>
              <option value="return">Return for changes</option>
            </Select>
          </Field>

          <Field
            label="Notes"
            htmlFor="plan-notes"
            required={decision === "return"}
            hint={
              decision === "return"
                ? "Required. Say what has to change."
                : "Optional, and worth writing if anything was conditional."
            }
            error={state.fieldErrors?.notes}
          >
            <Input id="plan-notes" name="notes" />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

function PlanVersionDetail({ version }: { version: PlanVersion }) {
  const list = (values: string[]) =>
    values.length === 0 ? (
      <Muted>none recorded</Muted>
    ) : (
      <ul className="list-disc space-y-0.5 pl-4">
        {values.map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ul>
    );

  return (
    <DescriptionList
      items={[
        { label: "Objective", value: version.objective },
        { label: "Scope", value: version.scope ?? <Muted>not stated</Muted> },
        { label: "Methodology", value: version.methodology },
        { label: "Sources", value: list(version.sourcesToConsult) },
        { label: "Personnel", value: list(version.assignedPersonnel) },
        { label: "Deliverables", value: list(version.expectedDeliverables) },
        { label: "Timeline", value: version.timeline ?? <Muted>not stated</Muted> },
        { label: "Risks", value: version.risks ?? <Muted>not stated</Muted> },
        { label: "Resources", value: version.resources ?? <Muted>not stated</Muted> },
      ]}
    />
  );
}

/**
 * The investigation plan (PRD 9.3).
 *
 * One plan per case with numbered versions. The approved version is what the
 * work is being done against, and a new one supersedes it only once somebody
 * other than its author has approved it.
 */
export function InvestigationPlanPanel({
  caseRecordId,
  plan,
  isOwnSubmission,
  canEdit,
  canApprove,
}: {
  caseRecordId: string;
  plan: InvestigationPlan | null;
  isOwnSubmission: boolean;
  canEdit: boolean;
  canApprove: boolean;
}) {
  const [drafting, setDrafting] = useState(false);
  const working = plan?.working ?? null;
  const current = plan?.current ?? null;
  const earlier =
    plan?.versions.filter((v) => v.id !== current?.id && v.id !== working?.id) ?? [];

  return (
    <Card
      title="Investigation plan"
      description="What the work is being done against. A supervisor other than its author has to approve it."
      actions={
        canEdit && plan && !working && !drafting ? (
          <Button size="sm" onClick={() => setDrafting(true)}>
            <FilePlus2 className="size-4" aria-hidden="true" />
            Draft a new version
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {!plan ? (
          canEdit ? (
            <>
              <p className="text-xs text-muted">
                No plan yet. Drafting one is what turns an objective into work that
                can be assigned.
              </p>
              <PlanVersionForm caseRecordId={caseRecordId} />
            </>
          ) : (
            <EmptyState
              title="No investigation plan yet"
              description="The lead investigator drafts it, and a supervisor approves it."
            />
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Id>{plan.planId}</Id>
              {current ? (
                <Badge tone="ok">
                  <CheckCircle2 className="size-3" aria-hidden="true" />
                  Version {current.versionNo} approved
                </Badge>
              ) : (
                <Badge tone="warn">No approved version yet</Badge>
              )}
              {working && (
                <Badge tone={PLAN_TONES[working.status]}>
                  Version {working.versionNo}: {PLAN_STATUS_LABELS[working.status]}
                </Badge>
              )}
            </div>

            {working?.status === "returned" && working.reviewNotes && (
              <Alert tone="warn" title="Returned for changes">
                {working.reviewNotes}
              </Alert>
            )}

            {/* The version in flight comes first, because it is the one
                anybody opening this panel has something to do about. */}
            {working && (
              <div className="rounded-lg border border-line p-3">
                <p className="mb-2 text-xs font-semibold text-body">
                  Version {working.versionNo}, {PLAN_STATUS_LABELS[working.status]}
                </p>

                {working.status === "submitted" ? (
                  <>
                    <PlanVersionDetail version={working} />
                    <p className="mt-2 text-[11px] text-muted">
                      Submitted {when(working.submittedAt ?? working.updatedAt)}
                      {working.submittedByName ? ` by ${working.submittedByName}` : ""}.
                    </p>
                    <div className="mt-3 border-t border-line pt-3">
                      {isOwnSubmission ? (
                        <Alert tone="info">
                          You submitted this version, so you cannot review it. A
                          supervisor other than you has to look at it, which is the
                          only thing that makes the review worth having.
                        </Alert>
                      ) : canApprove ? (
                        <ReviewPlanForm
                          caseRecordId={caseRecordId}
                          versionId={working.id}
                        />
                      ) : (
                        <Muted>Waiting on a supervisor to review it.</Muted>
                      )}
                    </div>
                  </>
                ) : canEdit ? (
                  <>
                    <PlanVersionForm caseRecordId={caseRecordId} version={working} />
                    <div className="mt-3 border-t border-line pt-3">
                      <ActionForm
                        action={submitPlanVersion}
                        submitLabel={
                          <>
                            <Send className="size-4" aria-hidden="true" />
                            Submit for review
                          </>
                        }
                        submitSize="sm"
                        hidden={{ caseRecordId, versionId: working.id }}
                      />
                    </div>
                  </>
                ) : (
                  <PlanVersionDetail version={working} />
                )}
              </div>
            )}

            {drafting && !working && (
              <div className="rounded-lg border border-line bg-surface-sunken p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-medium text-body">
                    New version
                    {current ? `, superseding version ${current.versionNo}` : ""}
                  </p>
                  <Button size="sm" tone="ghost" onClick={() => setDrafting(false)}>
                    <X className="size-4" aria-hidden="true" />
                    Cancel
                  </Button>
                </div>
                <PlanVersionForm caseRecordId={caseRecordId} />
              </div>
            )}

            {current && (
              <div className="rounded-lg border border-ok/35 bg-ok/5 p-3">
                <p className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-body">
                  <ClipboardList className="size-3.5" aria-hidden="true" />
                  Version {current.versionNo}, in force
                </p>
                <PlanVersionDetail version={current} />
                <p className="mt-2 text-[11px] text-muted">
                  Approved {when(current.reviewedAt ?? current.updatedAt)}
                  {current.reviewedByName ? ` by ${current.reviewedByName}` : ""}.
                </p>
              </div>
            )}

            {earlier.length > 0 && (
              <details className="rounded-lg border border-line p-3">
                <summary className="cursor-pointer text-xs font-medium text-body">
                  Earlier versions ({earlier.length})
                </summary>
                <ol className="mt-3 space-y-2">
                  {earlier.map((v) => (
                    <li key={v.id} className="rounded-md border border-line p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-body">
                          Version {v.versionNo}
                        </span>
                        <Badge tone={PLAN_TONES[v.status]}>
                          {PLAN_STATUS_LABELS[v.status]}
                        </Badge>
                        <span className="ml-auto text-[11px] text-muted">
                          {when(v.updatedAt)}
                        </span>
                      </div>
                      {v.reviewNotes && (
                        <p className="mt-1.5 text-[11px] text-muted">
                          <CornerUpLeft
                            className="mr-1 inline size-3"
                            aria-hidden="true"
                          />
                          {v.reviewNotes}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

"use client";

import { useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  FileWarning,
  Gavel,
  Plus,
  RotateCcw,
  ShieldAlert,
  Trash2,
  UserPlus,
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
  Muted,
  NotSet,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import {
  ASSIGNMENT_ROLE_LABELS,
  ASSIGNMENT_ROLES,
  COMMUNICATION_CHANNEL_LABELS,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_DIRECTION_LABELS,
  COMMUNICATION_DIRECTIONS,
  COMMUNICATION_KIND_LABELS,
  COMMUNICATION_KINDS,
  RISK_DIMENSION_LABELS,
  RISK_LEVEL_LABELS,
  RISK_LEVELS,
  type Case,
  type CaseAssignment,
  type CaseCommunication,
  type RiskAssessment,
  type ScopeChangeRequest,
  type ScopeVersion,
  type WorkflowTransition,
} from "@/modules/casework/shared";
import {
  addRiskAssessment,
  approveRiskAssessment,
  assignToCase,
  decideScopeChange,
  logCommunication,
  moveStage,
  recordObjectiveOverride,
  removeCase,
  removeCommunication,
  requestScopeChange,
  restoreCase,
  setOriginalScope,
  unassignFromCase,
  withdrawScopeChange,
} from "./actions";
import { RiskLevelBadge } from "./CaseBadges";

const when = (value: string | null) =>
  value ? new Date(value).toLocaleString("en-GB") : null;

const onDay = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("en-GB") : null;

/* ---------------------------------------------------------- the lifecycle */

/**
 * Moving the case along (PRD 4.2).
 *
 * The dropdown lists only the moves the configured lifecycle permits from
 * here, so it cannot offer one the server would refuse, and a transition that
 * carries a permission requirement says so. The objective gate is surfaced as
 * a blocker rather than as a failure after the fact.
 */
export function LifecyclePanel({
  record,
  transitions,
  canEdit,
  canApprove,
}: {
  record: Case;
  transitions: WorkflowTransition[];
  canEdit: boolean;
  canApprove: boolean;
}) {
  const [showOverride, setShowOverride] = useState(false);

  // Leaving the first stage is "opening" the case, which PRD 5.1 gates on an
  // objective or a recorded override.
  const blockedByObjective =
    record.stagePosition <= 10 &&
    !record.hasObjective &&
    (record.objectiveOverrideReason ?? "").trim().length < 10;

  return (
    <Card
      title="Lifecycle"
      description="Every move records who made it, when, and why. Illegal moves are refused by the server, not hidden by the screen."
    >
      <div className="space-y-4">
        <DescriptionList
          items={[
            {
              label: "Stage",
              value: (
                <>
                  {record.stageName}
                  {record.methodologyStage && (
                    <span className="ml-2 text-[11px] text-faint">
                      {record.methodologyStage}
                    </span>
                  )}
                </>
              ),
            },
            {
              label: "Opened",
              value: when(record.openedAt) ?? <NotSet />,
            },
            {
              label: "Target",
              value: when(record.targetCompletionAt) ?? <NotSet />,
            },
            {
              label: "Finished",
              value: when(record.actualCompletionAt) ?? <Muted>not yet</Muted>,
            },
          ]}
        />

        {blockedByObjective && (
          <Alert tone="warn" title="This case has no objective">
            PRD 5.1 does not let a case proceed without one. Record an
            objective, or, if this case genuinely does not need one, record an
            override saying why.
            {canApprove && !showOverride && (
              <div className="mt-2">
                <Button size="sm" onClick={() => setShowOverride(true)}>
                  <FileWarning className="size-4" aria-hidden="true" />
                  Record an override
                </Button>
              </div>
            )}
          </Alert>
        )}

        {showOverride && canApprove && (
          <div className="rounded-lg border border-warn/40 bg-warn/5 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">
                Proceed without an objective
              </p>
              <Button
                size="sm"
                tone="ghost"
                onClick={() => setShowOverride(false)}
              >
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ActionForm
              action={recordObjectiveOverride}
              submitLabel="Record the override"
              submitTone="danger"
              submitSize="sm"
              hidden={{ caseRecordId: record.id }}
              confirm="Record that this case is proceeding without an objective?"
            >
              {(state) => (
                <Field
                  label="Why this case does not need an objective"
                  htmlFor="override-reason"
                  required
                  hint="Recorded against your name, permanently. This is a decision, not a formality."
                  error={state.fieldErrors?.reason}
                >
                  <Textarea
                    id="override-reason"
                    name="reason"
                    rows={2}
                    placeholder="Retainer case: the objective is set per instruction and recorded on each task."
                  />
                </Field>
              )}
            </ActionForm>
          </div>
        )}

        {record.objectiveOverrideReason && (
          <Alert tone="info" title="Proceeding without an objective">
            <p>{record.objectiveOverrideReason}</p>
            <p className="mt-1 text-[11px]">
              Recorded{" "}
              {when(record.objectiveOverrideAt) ?? "at an unrecorded time"}.
            </p>
          </Alert>
        )}

        {!canEdit ? (
          <Alert tone="info">
            You do not have permission to move this case on.
          </Alert>
        ) : transitions.length === 0 ? (
          <Alert tone="info">
            {record.stageName} is{" "}
            {record.stageIsTerminal
              ? "final"
              : "a dead end in the configured lifecycle"}
            .
            {record.stageIsTerminal
              ? " The case and everything under it stay readable."
              : " An administrator has to configure a move out of it."}
          </Alert>
        ) : (
          <ActionForm
            action={moveStage}
            submitLabel={
              <>
                <ArrowRight className="size-4" aria-hidden="true" />
                Move the case on
              </>
            }
            submitSize="sm"
            hidden={{ caseRecordId: record.id }}
          >
            {(state) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="Next stage"
                  htmlFor="toStageId"
                  required
                  error={state.fieldErrors?.toStageId}
                >
                  <Select
                    id="toStageId"
                    name="toStageId"
                    defaultValue={transitions[0].toStageId}
                  >
                    {transitions.map((t) => (
                      <option key={t.toStageId} value={t.toStageId}>
                        {t.toStageName}
                        {t.requiredPermission ? " (needs authorisation)" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  label="Reason"
                  htmlFor="stage-reason"
                  required
                  hint="Recorded with the before and after stage."
                  error={state.fieldErrors?.reason}
                >
                  <Input
                    id="stage-reason"
                    name="reason"
                    placeholder="Fieldwork complete, moving to analysis"
                  />
                </Field>
              </div>
            )}
          </ActionForm>
        )}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- risk */

/**
 * Risk assessment (PRD 5.3).
 *
 * Five dimensions and an overall rating with a rationale, assessor and date.
 * A critical case needs the Operations Manager to approve the assessment
 * before anybody is assigned, and that approval is the thing the assignment
 * panel reads, so it is offered here rather than buried.
 */
export function RiskPanel({
  record,
  assessments,
  canEdit,
  canApprove,
}: {
  record: Case;
  assessments: RiskAssessment[];
  canEdit: boolean;
  canApprove: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const latest = assessments[0] ?? null;

  return (
    <Card
      title="Risk assessment"
      description="The overall rating cannot be lower than its highest dimension: a critical safety risk is not an overall low risk."
      actions={
        canEdit && !adding ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden="true" />
            {latest ? "Reassess" : "Assess the risk"}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {latest === null ? (
          <Alert tone="warn" title="Not assessed">
            PRD 5.3 wants a documented assessment. The case carries its default
            rating of {record.riskLevel} until one is recorded.
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <RiskLevelBadge level={latest.overallRisk} />
              {latest.approvedAt ? (
                <Badge tone="ok">
                  <BadgeCheck className="size-3" aria-hidden="true" />
                  Approved
                </Badge>
              ) : latest.overallRisk === "critical" ? (
                <Badge tone="danger">
                  <ShieldAlert className="size-3" aria-hidden="true" />
                  Needs approval before assignment
                </Badge>
              ) : null}
              <Muted>
                assessed by {latest.assessedByName ?? "an unrecorded assessor"}{" "}
                on {onDay(latest.assessedAt)}
              </Muted>
            </div>

            <DescriptionList
              items={[
                {
                  label: RISK_DIMENSION_LABELS.operational,
                  value: RISK_LEVEL_LABELS[latest.operationalRisk],
                },
                {
                  label: RISK_DIMENSION_LABELS.legal,
                  value: RISK_LEVEL_LABELS[latest.legalRisk],
                },
                {
                  label: RISK_DIMENSION_LABELS.reputational,
                  value: RISK_LEVEL_LABELS[latest.reputationalRisk],
                },
                {
                  label: RISK_DIMENSION_LABELS.safety,
                  value: RISK_LEVEL_LABELS[latest.safetyRisk],
                },
                {
                  label: RISK_DIMENSION_LABELS.sensitivity,
                  value: RISK_LEVEL_LABELS[latest.sensitivityRisk],
                },
                {
                  label: "Overall",
                  value: RISK_LEVEL_LABELS[latest.overallRisk],
                },
              ]}
            />

            <div className="border-t border-line pt-3">
              <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                Rationale
              </p>
              <p className="mt-1 text-sm whitespace-pre-line text-body">
                {latest.rationale}
              </p>
            </div>

            {latest.approvedAt === null &&
              latest.overallRisk === "critical" &&
              canApprove && (
                <div className="border-t border-line pt-3">
                  <p className="mb-2 text-xs text-muted">
                    A critical case cannot be assigned until this assessment is
                    approved.
                  </p>
                  <ActionForm
                    action={approveRiskAssessment}
                    submitLabel={
                      <>
                        <BadgeCheck className="size-4" aria-hidden="true" />
                        Approve this assessment
                      </>
                    }
                    submitSize="sm"
                    hidden={{
                      assessmentId: latest.id,
                      caseRecordId: record.id,
                    }}
                    confirm="Approve this risk assessment? Assignment will then be possible."
                    compact
                  />
                </div>
              )}

            {latest.approvedAt && (
              <p className="text-[11px] text-muted">
                Approved by {latest.approvedByName ?? "an administrator"} on{" "}
                {onDay(latest.approvedAt)}.
              </p>
            )}
          </>
        )}

        {adding && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">
                Record an assessment
              </p>
              <Button size="sm" tone="ghost" onClick={() => setAdding(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ActionForm
              action={addRiskAssessment}
              submitLabel="Record assessment"
              submitSize="sm"
              hidden={{ caseRecordId: record.id }}
            >
              {(state) => (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    {(
                      [
                        ["operationalRisk", "operational"],
                        ["legalRisk", "legal"],
                        ["reputationalRisk", "reputational"],
                        ["safetyRisk", "safety"],
                        ["sensitivityRisk", "sensitivity"],
                        ["overallRisk", null],
                      ] as const
                    ).map(([name, dimension]) => (
                      <Field
                        key={name}
                        label={
                          dimension
                            ? RISK_DIMENSION_LABELS[dimension]
                            : "Overall rating"
                        }
                        htmlFor={name}
                        required
                        error={state.fieldErrors?.[name]}
                      >
                        <Select
                          id={name}
                          name={name}
                          defaultValue={latest ? latest[name] : "medium"}
                        >
                          {RISK_LEVELS.map((level) => (
                            <option key={level} value={level}>
                              {RISK_LEVEL_LABELS[level]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ))}
                  </div>

                  <Field
                    label="Rationale"
                    htmlFor="rationale"
                    required
                    hint="The rationale is the assessment. A rating without one cannot be defended later."
                    error={state.fieldErrors?.rationale}
                  >
                    <Textarea
                      id="rationale"
                      name="rationale"
                      rows={3}
                      placeholder="Field surveillance in an area with a history of violence; subject has political connections."
                    />
                  </Field>
                </div>
              )}
            </ActionForm>
          </div>
        )}

        {assessments.length > 1 && (
          <div className="border-t border-line pt-3">
            <p className="mb-2 text-[10.5px] font-medium tracking-wide text-faint uppercase">
              Earlier assessments
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Overall</Th>
                  <Th>Assessed</Th>
                  <Th>By</Th>
                  <Th>Rationale</Th>
                </tr>
              </thead>
              <tbody>
                {assessments.slice(1).map((assessment) => (
                  <tr key={assessment.id}>
                    <Td>
                      <RiskLevelBadge level={assessment.overallRisk} />
                    </Td>
                    <Td className="text-xs whitespace-nowrap text-muted">
                      {onDay(assessment.assessedAt)}
                    </Td>
                    <Td className="text-xs text-muted">
                      {assessment.assessedByName ?? <NotSet />}
                    </Td>
                    <Td className="max-w-sm text-xs text-muted">
                      {assessment.rationale}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- scope */

/**
 * Scope, versioned, with the original always beside the revisions (PRD 5.4).
 *
 * There is no edit control anywhere in this panel, deliberately. A scope
 * version records what was agreed at a point in time, and the only way to a
 * new one is a change request somebody else approves.
 */
export function ScopePanel({
  record,
  versions,
  changes,
  pending,
  isOwnRequest,
  canEdit,
  canApprove,
}: {
  record: Case;
  versions: ScopeVersion[];
  changes: ScopeChangeRequest[];
  pending: ScopeChangeRequest | null;
  isOwnRequest: boolean;
  canEdit: boolean;
  canApprove: boolean;
}) {
  const [requesting, setRequesting] = useState(false);
  const current = versions[0] ?? null;
  const original = versions.at(-1) ?? null;

  return (
    <Card
      title="Scope"
      description="The original is immutable and stays beside every revision. A change goes Request, Reason, Approval, Revised Scope."
      actions={
        canEdit && current && !pending && !requesting ? (
          <Button size="sm" onClick={() => setRequesting(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Request a change
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {current === null ? (
          <>
            <Alert tone="warn" title="No scope recorded">
              A case without a scope has no boundary, which is what scope creep
              grows in. Record it now: it becomes version 1 and cannot be edited
              afterwards.
            </Alert>
            {canEdit && (
              <ActionForm
                action={setOriginalScope}
                submitLabel="Record the original scope"
                submitSize="sm"
                hidden={{ caseRecordId: record.id }}
              >
                {(state) => (
                  <div className="space-y-3">
                    <Field
                      label="In scope"
                      htmlFor="scope"
                      required
                      error={state.fieldErrors?.scope}
                    >
                      <Textarea
                        id="scope"
                        name="scope"
                        rows={4}
                        placeholder="Review the three named subsidiaries, their directors and their bank statements for the period."
                      />
                    </Field>
                    <Field
                      label="Explicitly out of scope"
                      htmlFor="outOfScope"
                      hint="What PDDC is not doing. Saying so now prevents an argument later."
                      error={state.fieldErrors?.outOfScope}
                    >
                      <Textarea id="outOfScope" name="outOfScope" rows={3} />
                    </Field>
                  </div>
                )}
              </ActionForm>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="signal">Version {current.versionNo}</Badge>
              {current.changeRequestReference && (
                <Muted>
                  from <Id>{current.changeRequestReference}</Id>
                </Muted>
              )}
              <Muted>
                recorded {onDay(current.createdAt)}
                {current.createdByName ? ` by ${current.createdByName}` : ""}
              </Muted>
            </div>

            <div>
              <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                In scope
              </p>
              <p className="mt-1 text-sm whitespace-pre-line text-body">
                {current.scope}
              </p>
            </div>

            {current.outOfScope && (
              <div>
                <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                  Out of scope
                </p>
                <p className="mt-1 text-sm whitespace-pre-line text-body">
                  {current.outOfScope}
                </p>
              </div>
            )}

            {original && original.id !== current.id && (
              <div className="rounded-lg border border-line bg-surface-sunken p-3">
                <p className="mb-1 text-[10.5px] font-medium tracking-wide text-faint uppercase">
                  The original scope, version {original.versionNo}
                </p>
                <p className="text-xs whitespace-pre-line text-muted">
                  {original.scope}
                </p>
              </div>
            )}
          </>
        )}

        {pending && (
          <div className="rounded-lg border border-warn/40 bg-warn/5 p-3">
            <p className="mb-1 text-sm font-semibold text-body">
              {pending.changeId} is awaiting a decision
            </p>
            <DescriptionList
              items={[
                {
                  label: "Requested by",
                  value: pending.requestedByName ?? <NotSet />,
                },
                { label: "Requested", value: onDay(pending.requestedAt) },
                {
                  label: "Additional cost",
                  value:
                    pending.additionalCost === null ? (
                      <Muted>none</Muted>
                    ) : (
                      `${pending.additionalCostCurrency ?? ""} ${pending.additionalCost.toLocaleString()}`
                    ),
                },
                {
                  label: "Additional time",
                  value:
                    pending.additionalDays === null ? (
                      <Muted>none</Muted>
                    ) : (
                      `${pending.additionalDays} day${pending.additionalDays === 1 ? "" : "s"}`
                    ),
                },
                {
                  label: "Client approval",
                  value: pending.clientApprovalReference ?? <NotSet />,
                },
              ]}
            />

            <div className="mt-3 space-y-2">
              <div>
                <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                  Reason
                </p>
                <p className="text-xs text-body">{pending.reason}</p>
              </div>
              <div>
                <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                  Proposed scope
                </p>
                <p className="text-xs whitespace-pre-line text-body">
                  {pending.proposedScope}
                </p>
              </div>
            </div>

            {isOwnRequest ? (
              <div className="mt-3">
                <Alert tone="info">
                  You raised this request, so somebody else has to decide it. A
                  scope change usually costs the client money.
                </Alert>
                {canEdit && (
                  <div className="mt-2">
                    <ActionForm
                      action={withdrawScopeChange}
                      submitLabel="Withdraw this request"
                      submitTone="secondary"
                      submitSize="sm"
                      hidden={{
                        requestId: pending.id,
                        caseRecordId: record.id,
                        reason: "withdrawn by the requester",
                      }}
                      confirm="Withdraw this change request?"
                      compact
                    />
                  </div>
                )}
              </div>
            ) : canApprove ? (
              <div className="mt-3 border-t border-warn/30 pt-3">
                <ActionForm
                  action={decideScopeChange}
                  submitLabel={
                    <>
                      <Gavel className="size-4" aria-hidden="true" />
                      Record the decision
                    </>
                  }
                  submitSize="sm"
                  hidden={{ requestId: pending.id, caseRecordId: record.id }}
                  confirm="Record this decision on the scope change?"
                >
                  {(state) => (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field
                        label="Decision"
                        htmlFor="scope-decision"
                        required
                        error={state.fieldErrors?.decision}
                      >
                        <Select
                          id="scope-decision"
                          name="decision"
                          defaultValue="approve"
                        >
                          <option value="approve">
                            Approve, which writes the next version
                          </option>
                          <option value="reject">
                            Reject, leaving the scope as it is
                          </option>
                        </Select>
                      </Field>
                      <Field
                        label="Reason"
                        htmlFor="scope-decision-reason"
                        required
                        error={state.fieldErrors?.decisionReason}
                      >
                        <Input
                          id="scope-decision-reason"
                          name="decisionReason"
                          placeholder="Client approval received in writing; fee agreed."
                        />
                      </Field>
                    </div>
                  )}
                </ActionForm>
              </div>
            ) : (
              <Alert tone="info">
                An authorised approver has to decide this before the scope
                changes.
              </Alert>
            )}
          </div>
        )}

        {requesting && !pending && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">
                Request a scope change
              </p>
              <Button
                size="sm"
                tone="ghost"
                onClick={() => setRequesting(false)}
              >
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ActionForm
              action={requestScopeChange}
              submitLabel="Raise the request"
              submitSize="sm"
              hidden={{ caseRecordId: record.id }}
            >
              {(state) => (
                <div className="space-y-3">
                  <Field
                    label="Why the scope needs to change"
                    htmlFor="change-reason"
                    required
                    error={state.fieldErrors?.reason}
                  >
                    <Textarea
                      id="change-reason"
                      name="reason"
                      rows={2}
                      placeholder="The client has asked us to cover two more subsidiaries."
                    />
                  </Field>
                  <Field
                    label="Proposed scope"
                    htmlFor="proposedScope"
                    required
                    hint="The whole revised scope, not just the addition: this becomes the next version."
                    error={state.fieldErrors?.proposedScope}
                  >
                    <Textarea
                      id="proposedScope"
                      name="proposedScope"
                      rows={4}
                    />
                  </Field>
                  <Field
                    label="Proposed out of scope"
                    htmlFor="proposedOutOfScope"
                    error={state.fieldErrors?.proposedOutOfScope}
                  >
                    <Textarea
                      id="proposedOutOfScope"
                      name="proposedOutOfScope"
                      rows={2}
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field
                      label="Additional cost"
                      htmlFor="additionalCost"
                      error={state.fieldErrors?.additionalCost}
                    >
                      <Input
                        id="additionalCost"
                        name="additionalCost"
                        type="number"
                        min={0}
                        step="0.01"
                      />
                    </Field>
                    <Field
                      label="Currency"
                      htmlFor="additionalCostCurrency"
                      error={state.fieldErrors?.additionalCostCurrency}
                    >
                      <Input
                        id="additionalCostCurrency"
                        name="additionalCostCurrency"
                        placeholder="GHS"
                        maxLength={3}
                      />
                    </Field>
                    <Field
                      label="Additional days"
                      htmlFor="additionalDays"
                      error={state.fieldErrors?.additionalDays}
                    >
                      <Input
                        id="additionalDays"
                        name="additionalDays"
                        type="number"
                        min={0}
                      />
                    </Field>
                  </div>
                  <Field
                    label="Client approval reference"
                    htmlFor="clientApprovalReference"
                    hint="PDDC records a reference to it rather than holding it: usually an email or a signed letter."
                    error={state.fieldErrors?.clientApprovalReference}
                  >
                    <Input
                      id="clientApprovalReference"
                      name="clientApprovalReference"
                      placeholder="Email from the client of 21 October 2026"
                    />
                  </Field>
                </div>
              )}
            </ActionForm>
          </div>
        )}

        {changes.filter((c) => c.status !== "pending").length > 0 && (
          <div className="border-t border-line pt-3">
            <p className="mb-2 text-[10.5px] font-medium tracking-wide text-faint uppercase">
              Decided change requests
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Request</Th>
                  <Th>Outcome</Th>
                  <Th>Decided by</Th>
                  <Th>Reason</Th>
                </tr>
              </thead>
              <tbody>
                {changes
                  .filter((c) => c.status !== "pending")
                  .map((change) => (
                    <tr key={change.id}>
                      <Td>
                        <Id>{change.changeId}</Id>
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            change.status === "approved"
                              ? "ok"
                              : change.status === "rejected"
                                ? "danger"
                                : "neutral"
                          }
                        >
                          {change.status}
                          {change.resultingVersionNo
                            ? ` (version ${change.resultingVersionNo})`
                            : ""}
                        </Badge>
                      </Td>
                      <Td className="text-xs text-muted">
                        {change.approvingOfficerName ?? <NotSet />}
                      </Td>
                      <Td className="max-w-sm text-xs text-muted">
                        {change.decisionReason ?? <NotSet />}
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------- assignment */

/**
 * Who is on the case (PRD 5.2).
 *
 * `blocker` is the reason assignment is not currently possible, worked out on
 * the server, so the screen says why rather than offering a form that would be
 * refused. In practice it is PRD 5.3's rule that a critical case needs its
 * risk assessment approved first.
 */
export function AssignmentPanel({
  record,
  assignments,
  history,
  people,
  blocker,
  canAssign,
}: {
  record: Case;
  assignments: CaseAssignment[];
  history: CaseAssignment[];
  people: Array<{ id: string; name: string }>;
  blocker: string | null;
  canAssign: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const assigned = new Set(assignments.map((a) => a.userId));

  return (
    <Card
      title="Who is on this case"
      description="Assignment is what grants access to a case, so it is its own permission and every change is recorded."
      actions={
        canAssign && !adding && !blocker ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <UserPlus className="size-4" aria-hidden="true" />
            Assign somebody
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {blocker && (
          <Alert tone="warn" title="Assignment is blocked">
            {blocker}
          </Alert>
        )}

        {adding && !blocker && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Assign somebody</p>
              <Button size="sm" tone="ghost" onClick={() => setAdding(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ActionForm
              action={assignToCase}
              submitLabel="Assign"
              submitSize="sm"
              hidden={{ caseRecordId: record.id }}
            >
              {(state) => (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Person"
                    htmlFor="assign-user"
                    required
                    error={state.fieldErrors?.userId}
                  >
                    <Select id="assign-user" name="userId" defaultValue="">
                      <option value="" disabled>
                        Choose somebody
                      </option>
                      {people.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                          {assigned.has(person.id)
                            ? " (already on this case)"
                            : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field
                    label="Role"
                    htmlFor="assign-role"
                    required
                    hint="There can be only one lead investigator and one supervisor at a time."
                    error={state.fieldErrors?.role}
                  >
                    <Select
                      id="assign-role"
                      name="role"
                      defaultValue="supporting_investigator"
                    >
                      {ASSIGNMENT_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {ASSIGNMENT_ROLE_LABELS[role]}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <div className="sm:col-span-2">
                    <Field
                      label="Why this person"
                      htmlFor="assign-reason"
                      error={state.fieldErrors?.reason}
                    >
                      <Input
                        id="assign-reason"
                        name="reason"
                        placeholder="Available and has the sector experience"
                      />
                    </Field>
                  </div>
                </div>
              )}
            </ActionForm>
          </div>
        )}

        {assignments.length === 0 ? (
          <EmptyState
            title="Nobody is on this case"
            description="A case with no lead investigator is work nobody owns."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Role</Th>
                <Th>Assigned</Th>
                <Th>By</Th>
                {canAssign && <Th className="text-right">Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {assignments.map((assignment) => (
                <tr key={assignment.id}>
                  <Td>
                    <span className="font-medium text-body">
                      {assignment.userName}
                    </span>
                    {assignment.reason && (
                      <p className="mt-0.5 text-[11px] text-muted">
                        {assignment.reason}
                      </p>
                    )}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        assignment.role === "lead_investigator"
                          ? "signal"
                          : assignment.role === "supervisor"
                            ? "info"
                            : "neutral"
                      }
                    >
                      {ASSIGNMENT_ROLE_LABELS[assignment.role]}
                    </Badge>
                  </Td>
                  <Td className="text-xs whitespace-nowrap text-muted">
                    {onDay(assignment.assignedAt)}
                  </Td>
                  <Td className="text-xs text-muted">
                    {assignment.assignedByName ?? <NotSet />}
                  </Td>
                  {canAssign && (
                    <Td className="text-right">
                      <ActionForm
                        action={unassignFromCase}
                        submitLabel={
                          <>
                            <Trash2 className="size-3.5" aria-hidden="true" />
                            <span className="sr-only">
                              Remove this assignment
                            </span>
                          </>
                        }
                        submitTone="danger"
                        submitSize="sm"
                        hidden={{
                          assignmentId: assignment.id,
                          caseRecordId: record.id,
                          reason: "removed from the case",
                        }}
                        confirm={`Take ${assignment.userName} off this case?`}
                        compact
                      />
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        {history.length > 0 && (
          <div className="border-t border-line pt-3">
            <p className="mb-2 text-[10.5px] font-medium tracking-wide text-faint uppercase">
              Previously on this case
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Person</Th>
                  <Th>Role</Th>
                  <Th>Until</Th>
                  <Th>Why they came off</Th>
                </tr>
              </thead>
              <tbody>
                {history.map((assignment) => (
                  <tr key={assignment.id}>
                    <Td className="text-xs text-body">{assignment.userName}</Td>
                    <Td className="text-xs text-muted">
                      {ASSIGNMENT_ROLE_LABELS[assignment.role]}
                    </Td>
                    <Td className="text-xs whitespace-nowrap text-muted">
                      {onDay(assignment.unassignedAt)}
                    </Td>
                    <Td className="text-xs text-muted">
                      {assignment.unassignReason ?? <NotSet />}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------ communications */

/**
 * The case communications log (PRD 5.5).
 *
 * "Material communications only." The kind is a closed list for that reason: a
 * free-text label would turn this into an inbox, which is what PRD 5.5 is
 * explicitly not asking for.
 */
export function CommunicationsPanel({
  record,
  communications,
  levels,
  canEdit,
}: {
  record: Case;
  communications: CaseCommunication[];
  levels: Array<{ code: string; name: string }>;
  canEdit: boolean;
}) {
  const [logging, setLogging] = useState(false);

  return (
    <Card
      title="Communications"
      description="Material exchanges only: instructions, clarifications, scope and deadline changes, approvals and decisions."
      actions={
        canEdit && !logging ? (
          <Button size="sm" onClick={() => setLogging(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Log one
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {logging && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">
                Log a communication
              </p>
              <Button size="sm" tone="ghost" onClick={() => setLogging(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ActionForm
              action={logCommunication}
              submitLabel="Log it"
              submitSize="sm"
              hidden={{ caseRecordId: record.id }}
            >
              {(state) => (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field
                    label="Direction"
                    htmlFor="direction"
                    required
                    error={state.fieldErrors?.direction}
                  >
                    <Select
                      id="direction"
                      name="direction"
                      defaultValue="inbound"
                    >
                      {COMMUNICATION_DIRECTIONS.map((d) => (
                        <option key={d} value={d}>
                          {COMMUNICATION_DIRECTION_LABELS[d]}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field
                    label="Kind"
                    htmlFor="kind"
                    required
                    error={state.fieldErrors?.kind}
                  >
                    <Select id="kind" name="kind" defaultValue="instruction">
                      {COMMUNICATION_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {COMMUNICATION_KIND_LABELS[k]}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field
                    label="Channel"
                    htmlFor="channel"
                    required
                    error={state.fieldErrors?.channel}
                  >
                    <Select id="channel" name="channel" defaultValue="email">
                      {COMMUNICATION_CHANNELS.map((c) => (
                        <option key={c} value={c}>
                          {COMMUNICATION_CHANNEL_LABELS[c]}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field
                    label="From"
                    htmlFor="sender"
                    required
                    error={state.fieldErrors?.sender}
                  >
                    <Input id="sender" name="sender" />
                  </Field>

                  <Field
                    label="To"
                    htmlFor="recipient"
                    required
                    error={state.fieldErrors?.recipient}
                  >
                    <Input id="recipient" name="recipient" />
                  </Field>

                  <Field
                    label="When"
                    htmlFor="occurredAt"
                    hint="Leave empty for now."
                    error={state.fieldErrors?.occurredAt}
                  >
                    <Input
                      id="occurredAt"
                      name="occurredAt"
                      type="datetime-local"
                    />
                  </Field>

                  <div className="sm:col-span-2">
                    <Field
                      label="Subject"
                      htmlFor="comm-subject"
                      required
                      error={state.fieldErrors?.subject}
                    >
                      <Input id="comm-subject" name="subject" />
                    </Field>
                  </div>

                  <Field
                    label="Classification"
                    htmlFor="comm-classification"
                    required
                    hint="May be stricter than the case: a client instruction can be more sensitive than the file it is on."
                    error={state.fieldErrors?.classification}
                  >
                    <Select
                      id="comm-classification"
                      name="classification"
                      defaultValue={record.classification}
                    >
                      {levels.map((level) => (
                        <option key={level.code} value={level.code}>
                          {level.name}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <div className="sm:col-span-3">
                    <Field
                      label="What was said"
                      htmlFor="comm-body"
                      error={state.fieldErrors?.body}
                    >
                      <Textarea id="comm-body" name="body" rows={3} />
                    </Field>
                  </div>

                  <div className="sm:col-span-3">
                    <Field
                      label="Attachment reference"
                      htmlFor="attachmentReference"
                      hint="Where the attachment lives, if there was one."
                      error={state.fieldErrors?.attachmentReference}
                    >
                      <Input
                        id="attachmentReference"
                        name="attachmentReference"
                      />
                    </Field>
                  </div>
                </div>
              )}
            </ActionForm>
          </div>
        )}

        {communications.length === 0 ? (
          <EmptyState
            title="Nothing logged yet"
            description="Log the client's instruction, and anything later that changes what PDDC is doing."
          />
        ) : (
          <ol className="space-y-3">
            {communications.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      entry.direction === "inbound"
                        ? "info"
                        : entry.direction === "outbound"
                          ? "signal"
                          : "neutral"
                    }
                  >
                    {COMMUNICATION_DIRECTION_LABELS[entry.direction]}
                  </Badge>
                  <Badge tone="neutral">
                    {COMMUNICATION_KIND_LABELS[entry.kind]}
                  </Badge>
                  <Muted>{COMMUNICATION_CHANNEL_LABELS[entry.channel]}</Muted>
                  <span className="ml-auto text-[11px] whitespace-nowrap text-muted">
                    {when(entry.occurredAt)}
                  </span>
                </div>

                <p className="mt-2 text-sm font-medium text-body">
                  {entry.subject}
                </p>
                <p className="text-[11px] text-muted">
                  {entry.sender} to {entry.recipient}
                </p>

                {entry.body && (
                  <p className="mt-2 text-xs whitespace-pre-line text-body">
                    {entry.body}
                  </p>
                )}

                {entry.attachmentReference && (
                  <p className="mt-2 text-[11px] text-muted">
                    Attachment: {entry.attachmentReference}
                  </p>
                )}

                {canEdit && (
                  <div className="mt-2 flex justify-end">
                    <ActionForm
                      action={removeCommunication}
                      submitLabel={
                        <>
                          <Trash2 className="size-3.5" aria-hidden="true" />
                          <span className="sr-only">Remove this entry</span>
                        </>
                      }
                      submitTone="danger"
                      submitSize="sm"
                      hidden={{
                        communicationId: entry.id,
                        caseRecordId: record.id,
                        reason: "removed from the communications log",
                      }}
                      confirm="Remove this entry? It stays in the audit trail."
                      compact
                    />
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

/* ------------------------------------------------------------- removal */

export function CaseRemovalPanel({
  record,
  canRemove,
  canEdit,
}: {
  record: Case;
  canRemove: boolean;
  canEdit: boolean;
}) {
  if (record.deletedAt !== null) {
    return (
      <Card title="Case status">
        <Alert tone="warn" title="Case removed">
          This case was removed on {when(record.deletedAt)} and is in the
          recycle bin. The audit trail still refers to it.
          {canEdit && (
            <div className="mt-3">
              <ActionForm
                action={restoreCase}
                submitLabel={
                  <>
                    <RotateCcw className="size-3.5" aria-hidden="true" />
                    Restore
                  </>
                }
                submitSize="sm"
                hidden={{
                  caseRecordId: record.id,
                  reason: "restored from the recycle bin",
                }}
                confirm={`Restore ${record.caseId}?`}
                compact
              />
            </div>
          )}
        </Alert>
      </Card>
    );
  }

  if (!canRemove) return null;

  return (
    <Card title="Remove this case">
      <p className="mb-3 text-xs text-muted">
        Only possible before the work has started. Once a case has passed
        assignment it is taken to closure instead, which keeps the work
        readable.
      </p>
      <ActionForm
        action={removeCase}
        submitLabel={
          <>
            <Trash2 className="size-4" aria-hidden="true" />
            Remove this case
          </>
        }
        submitTone="danger"
        submitSize="sm"
        hidden={{ caseRecordId: record.id }}
        confirm="Remove this case? It can be restored from the recycle bin."
      >
        {(state) => (
          <Field
            label="Reason for removal"
            htmlFor="case-remove-reason"
            required
            error={state.fieldErrors?.reason}
          >
            <Input
              id="case-remove-reason"
              name="reason"
              placeholder="Opened against the wrong engagement"
            />
          </Field>
        )}
      </ActionForm>
    </Card>
  );
}

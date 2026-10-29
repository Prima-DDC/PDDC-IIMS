"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  LogIn,
  LogOut,
  MapPin,
  Phone,
  Plus,
  ShieldAlert,
  ShieldCheck,
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
  Select,
  StatTile,
  Textarea,
} from "@/components/ui";
import {
  CHECK_IN_EVENT_LABELS,
  INCIDENT_STATUS_LABELS,
  INCIDENT_TYPES,
  INCIDENT_TYPE_LABELS,
  RISK_LEVEL_LABELS,
  SITE_RISK_LEVELS,
  allowedIncidentTransitions,
  type CheckIn,
  type Incident,
  type SafetyPlan,
  type SiteRiskLevel,
} from "@/modules/casework/shared";
import {
  createSafetyPlan,
  recordCheckIn,
  reportIncident,
  setIncidentStatus,
  updateIncident,
  updateSafetyPlan,
} from "./actions";

/** The safety panels on a case page, and the controls the field screen reuses. */

const RISK_TONES: Record<SiteRiskLevel, "neutral" | "warn" | "danger"> = {
  low: "neutral",
  medium: "neutral",
  high: "warn",
  critical: "danger",
};

function when(value: string) {
  return new Date(value).toLocaleString("en-GB");
}

function time(value: string) {
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SiteRiskBadge({ level }: { level: SiteRiskLevel }) {
  return <Badge tone={RISK_TONES[level]}>{RISK_LEVEL_LABELS[level]} risk</Badge>;
}

/** How late somebody is, or that they are not. */
export function CheckInBadge({ checkIn }: { checkIn: CheckIn }) {
  if (!checkIn.isSafe) {
    return (
      <Badge tone="danger">
        <ShieldAlert className="size-3" aria-hidden="true" />
        Reported not safe
      </Badge>
    );
  }
  if (checkIn.isOverdue && checkIn.minutesLate !== null) {
    const hours = Math.floor(checkIn.minutesLate / 60);
    const minutes = checkIn.minutesLate % 60;
    return (
      <Badge tone="danger">
        <AlertTriangle className="size-3" aria-hidden="true" />
        {hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`} overdue
      </Badge>
    );
  }
  if (checkIn.event === "check_in" && checkIn.nextDueAt) {
    return <Badge tone="info">Next due {time(checkIn.nextDueAt)}</Badge>;
  }
  return null;
}

/* ------------------------------------------------------------- the plan */

export function SafetyPlanForm({
  caseRecordId,
  plan,
}: {
  caseRecordId: string;
  plan?: SafetyPlan | null;
}) {
  const [frequency, setFrequency] = useState(
    plan?.checkInFrequencyHours === null || plan?.checkInFrequencyHours === undefined
      ? ""
      : String(plan.checkInFrequencyHours),
  );

  return (
    <ActionForm
      action={plan ? updateSafetyPlan : createSafetyPlan}
      submitLabel={plan ? "Save the plan" : "Record the safety plan"}
      submitSize="sm"
      hidden={
        plan
          ? { caseRecordId, planId: plan.id, expectedVersion: plan.version }
          : { caseRecordId }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field
              label="Where the work is being done"
              htmlFor="safety-location"
              required
              hint="Specific enough that somebody could come and find you."
              error={state.fieldErrors?.location}
            >
              <Input
                id="safety-location"
                name="location"
                defaultValue={plan?.location ?? ""}
                placeholder="Tema port, gate 3 car park"
              />
            </Field>
          </div>

          <Field
            label="Site risk"
            htmlFor="safety-risk"
            required
            error={state.fieldErrors?.siteVisitRisk}
          >
            <Select
              id="safety-risk"
              name="siteVisitRisk"
              defaultValue={plan?.siteVisitRisk ?? "medium"}
            >
              {SITE_RISK_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {RISK_LEVEL_LABELS[level]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Check in every (hours)"
            htmlFor="safety-frequency"
            hint="Leave empty for desk work. A missed check-in is flagged from this."
            error={state.fieldErrors?.checkInFrequencyHours}
          >
            {/* Uncontrolled: React resets a controlled field on hydration,
                which would discard an interval typed before the JavaScript
                arrived. The state only decides whether the instructions
                field below is shown. */}
            <Input
              id="safety-frequency"
              name="checkInFrequencyHours"
              type="number"
              min={1}
              max={168}
              defaultValue={frequency}
              onChange={(e) => setFrequency(e.target.value)}
            />
          </Field>

          {frequency !== "" && (
            <div className="sm:col-span-2">
              <Field
                label="How to check in"
                htmlFor="safety-check-in-instructions"
                required
                hint="Required once there is a schedule: a schedule nobody knows how to follow is not a schedule."
                error={state.fieldErrors?.checkInInstructions}
              >
                <Input
                  id="safety-check-in-instructions"
                  name="checkInInstructions"
                  defaultValue={plan?.checkInInstructions ?? ""}
                  placeholder="Use the field screen, or ring the duty supervisor on the office line."
                />
              </Field>
            </div>
          )}

          <Field
            label="Emergency contact"
            htmlFor="safety-contact-name"
            required
            error={state.fieldErrors?.emergencyContactName}
          >
            <Input
              id="safety-contact-name"
              name="emergencyContactName"
              defaultValue={plan?.emergencyContactName ?? ""}
            />
          </Field>

          <Field
            label="Their number"
            htmlFor="safety-contact-phone"
            required
            hint="A number that will be answered out of hours."
            error={state.fieldErrors?.emergencyContactPhone}
          >
            <Input
              id="safety-contact-phone"
              name="emergencyContactPhone"
              type="tel"
              defaultValue={plan?.emergencyContactPhone ?? ""}
            />
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Known hazards"
              htmlFor="safety-hazards"
              error={state.fieldErrors?.knownHazards}
            >
              <Textarea
                id="safety-hazards"
                name="knownHazards"
                rows={2}
                defaultValue={plan?.knownHazards ?? ""}
                placeholder="The subject's security staff have turned away visitors before."
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field
              label="Safety instructions"
              htmlFor="safety-instructions"
              error={state.fieldErrors?.safetyInstructions}
            >
              <Textarea
                id="safety-instructions"
                name="safetyInstructions"
                rows={2}
                defaultValue={plan?.safetyInstructions ?? ""}
                placeholder="Two people at all times. Do not enter the yard. Withdraw if challenged."
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <label className="flex items-center gap-2 text-xs text-body">
              <input
                type="checkbox"
                name="isActive"
                defaultChecked={plan?.isActive ?? true}
                className="size-4 rounded border-line"
              />
              The field work is live, so check-ins are expected
            </label>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/* ---------------------------------------------------------- check-ins */

/**
 * The check-in control.
 *
 * Deliberately two large buttons and almost nothing else. Somebody using this
 * may be doing it quickly, on a phone, in a situation they would rather leave;
 * the position, the time and who they are all come from the server, so there
 * is nothing to fill in. The "not safe" path is separate and asks for one
 * sentence, because that sentence is the only thing that makes the alarm
 * actionable.
 */
export function CheckInControl({
  caseRecordId,
  latest,
  people,
  canLogForOthers = false,
}: {
  caseRecordId: string;
  latest: CheckIn | null;
  people?: Array<{ id: string; name: string }>;
  canLogForOthers?: boolean;
}) {
  const [trouble, setTrouble] = useState(false);
  const isOut = latest?.event === "check_in";

  return (
    <div className="space-y-3">
      {/* The durable statement of where things stand. It matters more than it
          looks: checking out removes the button that did it, and an
          ActionForm's confirmation goes with the form, so without this line
          a check-out would be acknowledged by nothing at all. */}
      {latest && (
        <p className="text-xs text-muted">
          Last event: {CHECK_IN_EVENT_LABELS[latest.event]} at {time(latest.occurredAt)}
          {latest.location ? `, ${latest.location}` : ""}.
          {latest.event === "check_out" && " Nothing further is due."}
        </p>
      )}

      {!trouble ? (
        /* Each form is its own flex item, so a confirmation appears under the
           button that produced it rather than between the two. */
        <div className="flex flex-wrap items-start gap-2">
          <ActionForm
            action={recordCheckIn}
            submitLabel={
              isOut ? (
                <>
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  I am safe, check in again
                </>
              ) : (
                <>
                  <LogIn className="size-4" aria-hidden="true" />
                  Check in
                </>
              )
            }
            hidden={{ caseRecordId, event: "check_in" }}
          />

          {isOut && (
            <ActionForm
              action={recordCheckIn}
              submitLabel={
                <>
                  <LogOut className="size-4" aria-hidden="true" />
                  Check out
                </>
              }
              submitTone="secondary"
              hidden={{ caseRecordId, event: "check_out" }}
            />
          )}

          <Button tone="danger" onClick={() => setTrouble(true)}>
            <ShieldAlert className="size-4" aria-hidden="true" />
            I am not safe
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-danger">Report that you are not safe</p>
            <Button size="sm" tone="ghost" onClick={() => setTrouble(false)}>
              <X className="size-4" aria-hidden="true" />
              Cancel
            </Button>
          </div>
          <p className="mb-3 text-[11px] text-muted">
            This records the alarm on the case. It does not ring anybody, so
            telephone the emergency contact as well.
          </p>
          <ActionForm
            action={recordCheckIn}
            submitLabel="Record it"
            submitTone="danger"
            submitSize="sm"
            hidden={{ caseRecordId, event: "check_in", isSafe: "no" }}
          >
            {(state) => (
              <div className="space-y-3">
                <Field
                  label="What is wrong"
                  htmlFor="unsafe-notes"
                  required
                  error={state.fieldErrors?.notes}
                >
                  <Textarea id="unsafe-notes" name="notes" rows={2} />
                </Field>
                <Field
                  label="Where you are"
                  htmlFor="unsafe-location"
                  error={state.fieldErrors?.location}
                >
                  <Input id="unsafe-location" name="location" />
                </Field>
              </div>
            )}
          </ActionForm>
        </div>
      )}

      {canLogForOthers && people && people.length > 0 && (
        <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer text-xs font-medium text-body">
            Log a check-in somebody relayed by telephone
          </summary>
          <div className="mt-3">
            <ActionForm
              action={recordCheckIn}
              submitLabel="Record it"
              submitSize="sm"
              hidden={{ caseRecordId }}
            >
              {(state) => (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field
                    label="Who"
                    htmlFor="relay-user"
                    required
                    error={state.fieldErrors?.userId}
                  >
                    <Select id="relay-user" name="userId" defaultValue="">
                      <option value="">Choose somebody</option>
                      {people.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label="Event"
                    htmlFor="relay-event"
                    required
                    error={state.fieldErrors?.event}
                  >
                    <Select id="relay-event" name="event" defaultValue="check_in">
                      <option value="check_in">Checked in</option>
                      <option value="check_out">Checked out</option>
                    </Select>
                  </Field>
                  <Field
                    label="Where"
                    htmlFor="relay-location"
                    error={state.fieldErrors?.location}
                  >
                    <Input id="relay-location" name="location" />
                  </Field>
                </div>
              )}
            </ActionForm>
          </div>
        </details>
      )}
    </div>
  );
}

/* --------------------------------------------------------- the panel */

export function SafetyPanel({
  caseRecordId,
  plan,
  whoIsOut,
  recentCheckIns,
  summary,
  people,
  actorId,
  canEdit,
}: {
  caseRecordId: string;
  plan: SafetyPlan | null;
  whoIsOut: CheckIn[];
  recentCheckIns: CheckIn[];
  summary: { peopleOut: number; overdueCheckIns: number; openIncidents: number };
  people: Array<{ id: string; name: string }>;
  actorId: string;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const myLatest =
    recentCheckIns.find((c) => c.userId === actorId) ?? null;
  const overdue = whoIsOut.filter((c) => c.isOverdue);
  const unsafe = whoIsOut.filter((c) => !c.isSafe);

  return (
    <Card
      title="Safety"
      description="Where people are, when they are next due to check in, and who to ring if they do not."
      actions={
        canEdit && plan && !editing ? (
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit the plan
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {unsafe.length > 0 && (
          <Alert tone="danger" title="Somebody has reported that they are not safe">
            {unsafe.map((c) => (
              <p key={c.id}>
                {c.userName ?? "Somebody"} at {time(c.occurredAt)}
                {c.location ? `, ${c.location}` : ""}: {c.notes}
              </p>
            ))}
            {plan && (
              <p className="mt-2 font-medium">
                Emergency contact: {plan.emergencyContactName} on{" "}
                {plan.emergencyContactPhone}.
              </p>
            )}
          </Alert>
        )}

        {overdue.length > 0 && (
          <Alert tone="warn" title="A check-in is overdue">
            {overdue.map((c) => (
              <p key={c.id}>
                {c.userName ?? "Somebody"} was due back at{" "}
                {c.nextDueAt ? time(c.nextDueAt) : "an earlier time"}
                {c.location ? `, last at ${c.location}` : ""}.
              </p>
            ))}
          </Alert>
        )}

        {!plan ? (
          canEdit ? (
            <>
              <p className="text-xs text-muted">
                No safety plan yet. Anybody going to site needs to know the hazards
                and who to ring, so this comes before the first visit.
              </p>
              <SafetyPlanForm caseRecordId={caseRecordId} />
            </>
          ) : (
            <EmptyState
              title="No safety plan on this case"
              description="A supervisor records the location, the hazards and the check-in schedule."
            />
          )
        ) : editing ? (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Edit the safety plan</p>
              <Button size="sm" tone="ghost" onClick={() => setEditing(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <SafetyPlanForm caseRecordId={caseRecordId} plan={plan} />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatTile label="People out" value={summary.peopleOut} />
              <StatTile
                label="Overdue check-ins"
                value={summary.overdueCheckIns}
                tone={summary.overdueCheckIns > 0 ? "danger" : "ok"}
              />
              <StatTile
                label="Open incidents"
                value={summary.openIncidents}
                tone={summary.openIncidents > 0 ? "warn" : "ok"}
              />
            </div>

            <DescriptionList
              items={[
                {
                  label: "Location",
                  value: (
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin className="size-3.5 text-faint" aria-hidden="true" />
                      {plan.location}
                    </span>
                  ),
                },
                {
                  label: "Site risk",
                  value: <SiteRiskBadge level={plan.siteVisitRisk} />,
                },
                {
                  label: "Check in every",
                  value:
                    plan.checkInFrequencyHours === null ? (
                      <Muted>no schedule</Muted>
                    ) : (
                      `${plan.checkInFrequencyHours} hours`
                    ),
                },
                {
                  label: "Emergency contact",
                  value: (
                    <span className="inline-flex items-center gap-1.5">
                      <Phone className="size-3.5 text-faint" aria-hidden="true" />
                      {plan.emergencyContactName}, {plan.emergencyContactPhone}
                    </span>
                  ),
                },
                {
                  label: "Known hazards",
                  value: plan.knownHazards ?? <Muted>none recorded</Muted>,
                },
                {
                  label: "Instructions",
                  value: plan.safetyInstructions ?? <Muted>none recorded</Muted>,
                },
                {
                  label: "Status",
                  value: plan.isActive ? (
                    <Badge tone="info">Field work live</Badge>
                  ) : (
                    <Badge tone="neutral">Stood down</Badge>
                  ),
                },
              ]}
            />

            {plan.isActive && (
              <div className="rounded-lg border border-line p-3">
                <p className="mb-2 text-xs font-semibold text-body">Your check-in</p>
                <CheckInControl
                  caseRecordId={caseRecordId}
                  latest={myLatest}
                  people={people}
                  canLogForOthers={canEdit}
                />
              </div>
            )}

            {whoIsOut.length > 0 && (
              <div>
                <p className="mb-2 text-[10.5px] font-medium tracking-wide text-faint uppercase">
                  Out at the moment
                </p>
                <ul className="space-y-1.5">
                  {whoIsOut.map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2.5"
                    >
                      <span className="text-xs font-medium text-body">
                        {c.userName ?? "Somebody"}
                      </span>
                      <Id>{c.checkInId}</Id>
                      <CheckInBadge checkIn={c} />
                      <span className="ml-auto text-[11px] text-muted">
                        since {time(c.occurredAt)}
                        {c.location ? `, ${c.location}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {recentCheckIns.length > 0 && (
              <details className="rounded-lg border border-line p-3">
                <summary className="cursor-pointer text-xs font-medium text-body">
                  Check-in history ({recentCheckIns.length})
                </summary>
                <ol className="mt-3 space-y-1.5">
                  {recentCheckIns.map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center gap-2 text-[11px] text-muted"
                    >
                      {c.isSafe ? (
                        <CheckCircle2
                          className="size-3 text-ok"
                          aria-hidden="true"
                        />
                      ) : (
                        <ShieldAlert
                          className="size-3 text-danger"
                          aria-hidden="true"
                        />
                      )}
                      <span className="font-medium text-body">
                        {c.userName ?? "Somebody"}
                      </span>
                      {CHECK_IN_EVENT_LABELS[c.event].toLowerCase()} at{" "}
                      {when(c.occurredAt)}
                      {c.location ? `, ${c.location}` : ""}
                      {c.notes ? ` (${c.notes})` : ""}
                      {c.recordedByName && c.recordedBy !== c.userId
                        ? `, logged by ${c.recordedByName}`
                        : ""}
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

/* ---------------------------------------------------------- incidents */

export function IncidentsPanel({
  caseRecordId,
  incidents,
  levels,
  people,
  caseClassification,
  actorId,
  canEdit,
}: {
  caseRecordId: string;
  incidents: Incident[];
  levels: Array<{ code: string; name: string }>;
  people: Array<{ id: string; name: string }>;
  caseClassification: string;
  actorId: string;
  canEdit: boolean;
}) {
  const [reporting, setReporting] = useState(false);
  const [deciding, setDeciding] = useState<Incident | null>(null);

  return (
    <Card
      title="Incidents"
      description="Anything that happened to somebody doing this work. Recording it here is not the same as raising the alarm."
      actions={
        canEdit && !reporting ? (
          <Button size="sm" tone="danger" onClick={() => setReporting(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Report an incident
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {reporting && (
          <div className="rounded-lg border border-danger/40 bg-danger/5 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold text-body">Report an incident</p>
              <Button size="sm" tone="ghost" onClick={() => setReporting(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <IncidentFields
              caseRecordId={caseRecordId}
              levels={levels}
              people={people}
              caseClassification={caseClassification}
            />
          </div>
        )}

        {deciding && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">
                Move {deciding.incidentId}
              </p>
              <Button size="sm" tone="ghost" onClick={() => setDeciding(null)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <IncidentStatusForm caseRecordId={caseRecordId} incident={deciding} />
          </div>
        )}

        {incidents.length === 0 ? (
          <EmptyState
            title="No incidents on this case"
            description="Which is how it should stay."
          />
        ) : (
          <ol className="space-y-3">
            {incidents.map((incident) => (
              <li
                key={incident.id}
                className={`rounded-lg border p-3 ${
                  incident.status === "closed"
                    ? "border-line bg-surface-sunken/60"
                    : incident.severity === "critical"
                      ? "border-danger/40 bg-danger/5"
                      : "border-line"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={RISK_TONES[incident.severity]}>
                    {RISK_LEVEL_LABELS[incident.severity]}
                  </Badge>
                  <Badge tone="neutral">
                    {INCIDENT_TYPE_LABELS[incident.incidentType]}
                  </Badge>
                  <Id>{incident.incidentId}</Id>
                  <Badge
                    tone={
                      incident.status === "closed"
                        ? "ok"
                        : incident.status === "under_review"
                          ? "info"
                          : "warn"
                    }
                  >
                    {INCIDENT_STATUS_LABELS[incident.status]}
                  </Badge>
                  <span className="ml-auto text-[11px] whitespace-nowrap text-muted">
                    {when(incident.occurredAt)}
                  </span>
                </div>

                <p className="mt-2 text-xs whitespace-pre-line text-body">
                  {incident.description}
                </p>

                {incident.immediateAction && (
                  <p className="mt-1.5 text-[11px] text-muted">
                    Action taken: {incident.immediateAction}
                  </p>
                )}

                <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
                  {incident.affectedUserName && (
                    <span>Affected: {incident.affectedUserName}</span>
                  )}
                  {incident.location && <span>At: {incident.location}</span>}
                  {incident.injuries && (
                    <span className="text-danger">
                      Injuries: {incident.injuryDetail}
                    </span>
                  )}
                  {incident.policeNotified && (
                    <span>
                      Police notified
                      {incident.policeReference ? ` (${incident.policeReference})` : ""}
                    </span>
                  )}
                  <span>
                    Reported {when(incident.reportedAt)}
                    {incident.reportedByName ? ` by ${incident.reportedByName}` : ""}
                  </span>
                </p>

                {incident.resolution && (
                  <p className="mt-2 rounded-md bg-ok/10 p-2 text-[11px] text-body">
                    Resolved: {incident.resolution}
                    {incident.resolvedByName ? ` (${incident.resolvedByName})` : ""}
                  </p>
                )}

                {canEdit && allowedIncidentTransitions(incident.status).length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                    {/* Said here rather than discovered on submitting: PRD 16
                        keeps the person it happened to, and whoever reported
                        it, out of the decision that it is dealt with. */}
                    {(incident.affectedUserId === actorId ||
                      incident.reportedBy === actorId) && (
                      <Muted>
                        You are involved in this one, so somebody else has to close it.
                      </Muted>
                    )}
                    <Button size="sm" tone="ghost" onClick={() => setDeciding(incident)}>
                      Move it on
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

function IncidentFields({
  caseRecordId,
  levels,
  people,
  caseClassification,
  incident,
}: {
  caseRecordId: string;
  levels: Array<{ code: string; name: string }>;
  people: Array<{ id: string; name: string }>;
  caseClassification: string;
  incident?: Incident;
}) {
  const [injuries, setInjuries] = useState(incident?.injuries ?? false);
  const [police, setPolice] = useState(incident?.policeNotified ?? false);

  return (
    <ActionForm
      action={incident ? updateIncident : reportIncident}
      submitLabel={incident ? "Save the report" : "Record the incident"}
      submitTone={incident ? "primary" : "danger"}
      submitSize="sm"
      hidden={
        incident
          ? {
              caseRecordId,
              incidentId: incident.id,
              expectedVersion: incident.version,
            }
          : { caseRecordId }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="What happened"
            htmlFor="incident-type"
            required
            error={state.fieldErrors?.incidentType}
          >
            <Select
              id="incident-type"
              name="incidentType"
              defaultValue={incident?.incidentType ?? "threat"}
            >
              {INCIDENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {INCIDENT_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="How serious"
            htmlFor="incident-severity"
            required
            error={state.fieldErrors?.severity}
          >
            <Select
              id="incident-severity"
              name="severity"
              defaultValue={incident?.severity ?? "medium"}
            >
              {SITE_RISK_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {RISK_LEVEL_LABELS[level]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="When"
            htmlFor="incident-occurred"
            required
            error={state.fieldErrors?.occurredAt}
          >
            <Input
              id="incident-occurred"
              name="occurredAt"
              type="datetime-local"
              defaultValue={incident ? incident.occurredAt.slice(0, 16) : ""}
            />
          </Field>

          <Field
            label="Where"
            htmlFor="incident-location"
            error={state.fieldErrors?.location}
          >
            <Input
              id="incident-location"
              name="location"
              defaultValue={incident?.location ?? ""}
            />
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="What happened, in full"
              htmlFor="incident-description"
              required
              hint="Write it as it happened, while it is fresh. This may end up being read by somebody outside PDDC."
              error={state.fieldErrors?.description}
            >
              <Textarea
                id="incident-description"
                name="description"
                rows={4}
                defaultValue={incident?.description ?? ""}
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field
              label="What was done about it"
              htmlFor="incident-action"
              error={state.fieldErrors?.immediateAction}
            >
              <Textarea
                id="incident-action"
                name="immediateAction"
                rows={2}
                defaultValue={incident?.immediateAction ?? ""}
              />
            </Field>
          </div>

          <Field
            label="Who it happened to"
            htmlFor="incident-affected"
            error={state.fieldErrors?.affectedUserId}
          >
            <Select
              id="incident-affected"
              name="affectedUserId"
              defaultValue={incident?.affectedUserId ?? ""}
            >
              <option value="">Not one particular person</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Classification"
            htmlFor="incident-classification"
            required
            hint="An incident can be more sensitive than the case it happened on."
            error={state.fieldErrors?.classification}
          >
            <Select
              id="incident-classification"
              name="classification"
              defaultValue={incident?.classification ?? caseClassification}
            >
              {levels.map((level) => (
                <option key={level.code} value={level.code}>
                  {level.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="space-y-2 sm:col-span-2">
            <label className="flex items-center gap-2 text-xs text-body">
              <input
                type="checkbox"
                name="injuries"
                defaultChecked={injuries}
                onChange={(e) => setInjuries(e.target.checked)}
                className="size-4 rounded border-line"
              />
              Somebody was hurt
            </label>

            {injuries && (
              <Field
                label="The injuries"
                htmlFor="incident-injury-detail"
                required
                error={state.fieldErrors?.injuryDetail}
              >
                <Input
                  id="incident-injury-detail"
                  name="injuryDetail"
                  defaultValue={incident?.injuryDetail ?? ""}
                />
              </Field>
            )}

            <label className="flex items-center gap-2 text-xs text-body">
              <input
                type="checkbox"
                name="policeNotified"
                defaultChecked={police}
                onChange={(e) => setPolice(e.target.checked)}
                className="size-4 rounded border-line"
              />
              The police were notified
            </label>

            {police && (
              <Field
                label="Police reference"
                htmlFor="incident-police-reference"
                error={state.fieldErrors?.policeReference}
              >
                <Input
                  id="incident-police-reference"
                  name="policeReference"
                  defaultValue={incident?.policeReference ?? ""}
                />
              </Field>
            )}
          </div>
        </div>
      )}
    </ActionForm>
  );
}

function IncidentStatusForm({
  caseRecordId,
  incident,
}: {
  caseRecordId: string;
  incident: Incident;
}) {
  const transitions = allowedIncidentTransitions(incident.status);
  const [target, setTarget] = useState<string>(transitions[0] ?? "");

  return (
    <ActionForm
      action={setIncidentStatus}
      submitLabel="Move the incident"
      submitSize="sm"
      hidden={{ caseRecordId, incidentId: incident.id }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="New status"
            htmlFor="incident-status"
            required
            error={state.fieldErrors?.status}
          >
            <Select
              id="incident-status"
              name="status"
              defaultValue={transitions[0] ?? ""}
              onChange={(e) => setTarget(e.target.value)}
            >
              {transitions.map((status) => (
                <option key={status} value={status}>
                  {INCIDENT_STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="How it was resolved"
            htmlFor="incident-resolution"
            required={target === "closed"}
            hint={
              target === "closed"
                ? "Required. Neither the person it happened to nor whoever reported it can close an incident."
                : undefined
            }
            error={state.fieldErrors?.resolution}
          >
            <Input
              id="incident-resolution"
              name="resolution"
              defaultValue={incident.resolution ?? ""}
            />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

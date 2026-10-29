import { AppLink } from "@/components/AppLink";
import { AlertTriangle, MapPin, Phone, ShieldAlert } from "lucide-react";
import { Alert, Badge, Card, EmptyState, Id, Muted } from "@/components/ui";
import {
  INCIDENT_TYPE_LABELS,
  RISK_LEVEL_LABELS,
  type CheckIn,
  type Incident,
  type SafetyPlan,
} from "@/modules/casework/shared";
import { CheckInBadge, CheckInControl, SiteRiskBadge } from "./SafetyPanels";

/**
 * The field screen (PRD screen 25).
 *
 * Mobile first in the literal sense: this is the one screen somebody uses
 * standing outside a building rather than sitting at a desk, so it is a short
 * vertical list of large controls, it shows only the cases that person is
 * actually assigned to, and the hazards and the telephone number are above
 * the fold rather than behind a tab.
 *
 * The emergency number is a `tel:` link, because on a phone that is one tap
 * instead of reading a number aloud to yourself while dialling.
 */

export interface FieldCase {
  id: string;
  caseId: string;
  title: string;
  clientName: string;
  classification: string;
  plan: SafetyPlan | null;
  latest: CheckIn | null;
}

export function FieldMode({
  cases,
  myOpenIncidents,
}: {
  cases: FieldCase[];
  myOpenIncidents: Incident[];
}) {
  const live = cases.filter((c) => c.plan !== null && c.plan.isActive);
  const overdue = live.filter((c) => c.latest?.isOverdue);

  return (
    <div className="space-y-4">
      {overdue.length > 0 && (
        <Alert tone="danger" title="You are overdue to check in">
          {overdue.map((c) => (
            <p key={c.id}>
              {c.caseId}: due back at{" "}
              {c.latest?.nextDueAt
                ? new Date(c.latest.nextDueAt).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "an earlier time"}
              . Check in below, or ring the emergency contact.
            </p>
          ))}
        </Alert>
      )}

      {myOpenIncidents.length > 0 && (
        <Alert tone="warn" title="Open incidents involving you">
          {myOpenIncidents.map((incident) => (
            <p key={incident.id}>
              {incident.incidentId}: {INCIDENT_TYPE_LABELS[incident.incidentType]} on{" "}
              {new Date(incident.occurredAt).toLocaleDateString("en-GB")}, still{" "}
              {incident.status.replace(/_/g, " ")}.
            </p>
          ))}
        </Alert>
      )}

      {cases.length === 0 ? (
        <EmptyState
          title="You are not assigned to any open case"
          description="The field screen shows the cases you are on, so there is nothing here until you are assigned to one."
        />
      ) : (
        cases.map((record) => (
          <Card key={record.id}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <AppLink
                    href={`/cases/${record.id}`}
                    className="text-sm font-semibold text-body hover:text-signal-dark hover:underline"
                  >
                    {record.title}
                  </AppLink>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <Id>{record.caseId}</Id>
                    <span className="text-[11px] text-faint">{record.clientName}</span>
                  </p>
                </div>
                {record.plan && <SiteRiskBadge level={record.plan.siteVisitRisk} />}
              </div>

              {!record.plan ? (
                <p className="text-xs text-muted">
                  No safety plan on this case. If you are going to site, ask your
                  supervisor to record one first.
                </p>
              ) : !record.plan.isActive ? (
                <p className="text-xs text-muted">
                  The field work on this case has been stood down, so no check-ins
                  are expected.
                </p>
              ) : (
                <>
                  <div className="space-y-2 rounded-lg border border-line bg-surface-sunken p-3">
                    <p className="flex items-start gap-2 text-xs text-body">
                      <MapPin
                        className="mt-0.5 size-3.5 shrink-0 text-faint"
                        aria-hidden="true"
                      />
                      {record.plan.location}
                    </p>

                    <a
                      href={`tel:${record.plan.emergencyContactPhone.replace(/\s+/g, "")}`}
                      className="flex items-center gap-2 text-xs font-medium text-signal-dark hover:underline"
                    >
                      <Phone className="size-3.5 shrink-0" aria-hidden="true" />
                      {record.plan.emergencyContactName}:{" "}
                      {record.plan.emergencyContactPhone}
                    </a>

                    {record.plan.knownHazards && (
                      <p className="flex items-start gap-2 text-xs text-warn">
                        <AlertTriangle
                          className="mt-0.5 size-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        {record.plan.knownHazards}
                      </p>
                    )}

                    {record.plan.safetyInstructions && (
                      <p className="flex items-start gap-2 text-xs text-body">
                        <ShieldAlert
                          className="mt-0.5 size-3.5 shrink-0 text-faint"
                          aria-hidden="true"
                        />
                        {record.plan.safetyInstructions}
                      </p>
                    )}

                    {record.plan.checkInFrequencyHours !== null && (
                      <p className="text-[11px] text-muted">
                        Check in every {record.plan.checkInFrequencyHours} hours.
                        {record.plan.checkInInstructions
                          ? ` ${record.plan.checkInInstructions}`
                          : ""}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {record.latest ? (
                      <CheckInBadge checkIn={record.latest} />
                    ) : (
                      <Badge tone="neutral">Not checked in yet</Badge>
                    )}
                    <Muted>
                      {RISK_LEVEL_LABELS[record.plan.siteVisitRisk]} risk site
                    </Muted>
                  </div>

                  <CheckInControl caseRecordId={record.id} latest={record.latest} />
                </>
              )}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { Gavel } from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import { Alert, Card, Field, Select, Textarea } from "@/components/ui";
import {
  CONFLICT_DECISION_LABELS,
  CONFLICT_DECISIONS,
  type ConflictCheck,
} from "@/modules/crm/shared";
import { decideCheck } from "./actions";

/**
 * Recording the decision on a conflict check (PRD 8.3).
 *
 * Three things about this screen are deliberate:
 *
 *   It is the only way a decision is recorded, and there is no way to change
 *   one. A decided check shows what was decided and by whom, and nothing else.
 *
 *   The wording of each option explains what it does to the work, because
 *   "further review" and "declined" are easy to confuse and one of them stops
 *   the engagement.
 *
 *   The reason is a textarea with a floor of ten characters, not a tick box.
 *   It is the record relied on later, when somebody asks why PDDC took work
 *   that looked like a conflict.
 */

const CONSEQUENCE: Record<(typeof CONFLICT_DECISIONS)[number], string> = {
  cleared: "The work can proceed. An engagement may be approved.",
  further_review:
    "A conflict exists and has been considered. The work can proceed, and the position is on the record.",
  declined: "The work stops. No engagement can be approved against this check.",
};

export function ConflictDecisionPanel({
  check,
  canDecide,
}: {
  check: ConflictCheck;
  canDecide: boolean;
}) {
  const [decision, setDecision] = useState<string>("cleared");

  if (check.decision !== null) {
    return (
      <Card title="Decision">
        <Alert
          tone={
            check.decision === "declined"
              ? "danger"
              : check.decision === "further_review"
                ? "warn"
                : "ok"
          }
          title={CONFLICT_DECISION_LABELS[check.decision]}
        >
          <p>{check.decisionReason}</p>
          <p className="mt-2 text-[11px]">
            Recorded by {check.decidedByName ?? "an administrator"} on{" "}
            {check.decidedAt
              ? new Date(check.decidedAt).toLocaleString("en-GB")
              : "an unrecorded date"}
            . A recorded decision cannot be changed: if the position has changed, raise
            a new check.
          </p>
        </Alert>
      </Card>
    );
  }

  if (!canDecide) {
    return (
      <Card title="Decision">
        <Alert tone="warn" title="Awaiting a decision">
          This check has not been decided. Only an authorised manager can clear or
          decline a conflict, and no engagement can be approved until one has.
        </Alert>
      </Card>
    );
  }

  return (
    <Card
      title="Record the decision"
      description="Once recorded this cannot be changed. A mistaken decision is corrected by raising a new check, not by editing this one."
    >
      <ActionForm
        action={decideCheck}
        submitLabel={
          <>
            <Gavel className="size-4" aria-hidden="true" />
            Record this decision
          </>
        }
        submitTone={decision === "declined" ? "danger" : "primary"}
        hidden={{ checkId: check.id }}
        confirm="Record this decision? It cannot be changed afterwards."
      >
        {(state) => (
          <div className="space-y-3">
            <Field
              label="Decision"
              htmlFor="decision"
              required
              error={state.fieldErrors?.decision}
            >
              <Select
                id="decision"
                name="decision"
                value={decision}
                onChange={(e) => setDecision(e.target.value)}
              >
                {CONFLICT_DECISIONS.map((option) => (
                  <option key={option} value={option}>
                    {CONFLICT_DECISION_LABELS[option]}
                  </option>
                ))}
              </Select>
            </Field>

            <Alert tone={decision === "declined" ? "danger" : "info"}>
              {CONSEQUENCE[decision as (typeof CONFLICT_DECISIONS)[number]]}
            </Alert>

            <Field
              label="Reason"
              htmlFor="decision-reason"
              required
              hint="What was checked, what the matches turned out to be, and why this is the right call. At least 10 characters."
              error={state.fieldErrors?.reason}
            >
              <Textarea
                id="decision-reason"
                name="reason"
                rows={4}
                placeholder="ABC Holdings Ltd on file is a different entity: different registration number, confirmed against the Registrar-General's search of 21 October 2026."
              />
            </Field>
          </div>
        )}
      </ActionForm>
    </Card>
  );
}

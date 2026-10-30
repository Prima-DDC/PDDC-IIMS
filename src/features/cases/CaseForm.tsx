"use client";

import { useState } from "react";
import { Briefcase, Save } from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import { Alert, Field, Input, ListField, Select, Textarea } from "@/components/ui";
import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  type Case,
  type CaseType,
} from "@/modules/casework/shared";
import { createCase, setObjective, updateCase } from "./actions";

interface Reference {
  caseTypes: CaseType[];
  offices: Array<{ id: string; name: string }>;
  countries: Array<{ code: string; name: string }>;
  levels: Array<{ code: string; name: string }>;
}

/** A datetime-local input wants "yyyy-mm-ddThh:mm", with no zone or seconds. */
function forDateTimeInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/**
 * The case form, used both to open a case and to edit one.
 *
 * On creation it asks for the engagement rather than the client, and derives
 * the client from it. A case belongs to an engagement (PRD 8.2), the
 * engagement already names its client, and asking for both would let somebody
 * pick a mismatched pair that the action would then have to refuse.
 */
export function CaseForm({
  record,
  reference,
  engagements,
  defaultEngagementId,
  idempotencyKey,
}: {
  record?: Case;
  reference: Reference;
  /** Only engagements a case can actually be opened against. */
  engagements?: Array<{ id: string; clientId: string; name: string }>;
  defaultEngagementId?: string;
  /**
   * A token from the server component rendering this form (PRD 21.7).
   *
   * Only the "new" pages pass one, because only creating mints a record: an
   * edit carries `expectedVersion`, so a duplicate gets a 409 rather than a
   * second row.
   */
  idempotencyKey?: string;
}) {
  const editing = record !== undefined;
  const [engagementId, setEngagementId] = useState(
    defaultEngagementId ?? engagements?.[0]?.id ?? "",
  );

  const chosen = engagements?.find((e) => e.id === engagementId);

  return (
    <ActionForm
      action={editing ? updateCase : createCase}
      idempotencyKey={idempotencyKey}
      submitLabel={
        editing ? (
          <>
            <Save className="size-4" aria-hidden="true" />
            Save changes
          </>
        ) : (
          <>
            <Briefcase className="size-4" aria-hidden="true" />
            Open the case
          </>
        )
      }
      hidden={
        editing
          ? { caseRecordId: record.id, expectedVersion: record.version }
          : // The client comes from the engagement, which is the only pairing
            // that can be right.
            { engagementId, clientId: chosen?.clientId ?? "" }
      }
    >
      {(state) => (
        <div className="grid gap-4 sm:grid-cols-2">
          {!editing && (
            <div className="sm:col-span-2">
              <Field
                label="Engagement"
                htmlFor="engagement"
                required
                hint="Only approved and active engagements are listed: a case cannot be opened before PDDC has committed to the work."
                error={state.fieldErrors?.engagementId ?? state.fieldErrors?.clientId}
              >
                <Select
                  id="engagement"
                  value={engagementId}
                  onChange={(e) => setEngagementId(e.target.value)}
                >
                  <option value="" disabled>
                    Choose an engagement
                  </option>
                  {(engagements ?? []).map((engagement) => (
                    <option key={engagement.id} value={engagement.id}>
                      {engagement.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}

          <div className="sm:col-span-2">
            <Field
              label="Title"
              htmlFor="title"
              required
              hint="What this case is, in a line. It appears on every screen that mentions the case."
              error={state.fieldErrors?.title}
            >
              <Input id="title" name="title" defaultValue={record?.title ?? ""} />
            </Field>
          </div>

          <Field
            label="Case type"
            htmlFor="caseType"
            required
            error={state.fieldErrors?.caseType}
          >
            <Select
              id="caseType"
              name="caseType"
              defaultValue={record?.caseType ?? reference.caseTypes[0]?.key ?? ""}
            >
              {reference.caseTypes.map((type) => (
                <option key={type.key} value={type.key}>
                  {type.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Priority"
            htmlFor="priority"
            required
            error={state.fieldErrors?.priority}
          >
            <Select
              id="priority"
              name="priority"
              defaultValue={record?.priority ?? "medium"}
            >
              {CASE_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {CASE_PRIORITY_LABELS[priority]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Jurisdiction"
            htmlFor="jurisdictionCountry"
            hint="Where the work is done, which decides which rules apply."
            error={state.fieldErrors?.jurisdictionCountry}
          >
            <Select
              id="jurisdictionCountry"
              name="jurisdictionCountry"
              defaultValue={record?.jurisdictionCountry ?? ""}
            >
              <option value="">Not recorded</option>
              {reference.countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Region"
            htmlFor="jurisdictionRegion"
            error={state.fieldErrors?.jurisdictionRegion}
          >
            <Input
              id="jurisdictionRegion"
              name="jurisdictionRegion"
              placeholder="Greater Accra"
              defaultValue={record?.jurisdictionRegion ?? ""}
            />
          </Field>

          <Field
            label="PDDC office"
            htmlFor="case-office"
            error={state.fieldErrors?.officeId}
          >
            <Select
              id="case-office"
              name="officeId"
              defaultValue={record?.officeId ?? ""}
            >
              <option value="">Not assigned</option>
              {reference.offices.map((office) => (
                <option key={office.id} value={office.id}>
                  {office.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Classification"
            htmlFor="case-classification"
            required
            hint="Who may open this case at all. You cannot set it above your own clearance."
            error={state.fieldErrors?.classification}
          >
            <Select
              id="case-classification"
              name="classification"
              defaultValue={record?.classification ?? "CONFIDENTIAL"}
            >
              {reference.levels.map((level) => (
                <option key={level.code} value={level.code}>
                  {level.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Opened"
            htmlFor="openedAt"
            hint="Leave empty for now. Set it back for work that started before it was entered here."
            error={state.fieldErrors?.openedAt}
          >
            <Input
              id="openedAt"
              name="openedAt"
              type="datetime-local"
              defaultValue={forDateTimeInput(record?.openedAt)}
            />
          </Field>

          <Field
            label="Target completion"
            htmlFor="targetCompletionAt"
            error={state.fieldErrors?.targetCompletionAt}
          >
            <Input
              id="targetCompletionAt"
              name="targetCompletionAt"
              type="datetime-local"
              defaultValue={forDateTimeInput(record?.targetCompletionAt)}
            />
          </Field>

          {!editing && (
            <div className="sm:col-span-2">
              <Alert tone="info" title="What happens after this">
                The case opens at the first lifecycle stage. It needs an objective and
                a scope before it can move on, and a risk assessment before anybody is
                assigned to it: a case rated critical needs the Operations Manager to
                approve that assessment first.
              </Alert>
            </div>
          )}
        </div>
      )}
    </ActionForm>
  );
}

/**
 * The objective, its questions and its deliverables (PRD 5.2).
 *
 * Questions and deliverables are lists, so the form grows rows rather than
 * asking somebody to type a delimiter and hope the parser agrees.
 */
export function ObjectiveForm({
  caseRecordId,
  objective,
}: {
  caseRecordId: string;
  objective?: {
    id: string;
    clientInstruction: string | null;
    objective: string;
    questions: string[];
    deliverables: string[];
    deadline: string | null;
    version: number;
  } | null;
}) {
  const [questions, setQuestions] = useState<string[]>(
    objective?.questions.length ? objective.questions : [""],
  );
  const [deliverables, setDeliverables] = useState<string[]>(
    objective?.deliverables.length ? objective.deliverables : [""],
  );

  return (
    <ActionForm
      action={setObjective}
      submitLabel={
        <>
          <Save className="size-4" aria-hidden="true" />
          Save objective
        </>
      }
      hidden={{
        caseRecordId,
        ...(objective ? { expectedVersion: objective.version } : {}),
      }}
    >
      {(state) => (
        <div className="space-y-4">
          <Field
            label="The client's instruction"
            htmlFor="clientInstruction"
            hint="In their words. A report defends the objective, so what it came from matters."
            error={state.fieldErrors?.clientInstruction}
          >
            <Textarea
              id="clientInstruction"
              name="clientInstruction"
              rows={3}
              defaultValue={objective?.clientInstruction ?? ""}
            />
          </Field>

          <Field
            label="Objective"
            htmlFor="objective"
            required
            hint="What this investigation is for. A case cannot move on without one, unless an authorised user records an override."
            error={state.fieldErrors?.objective}
          >
            <Textarea
              id="objective"
              name="objective"
              rows={3}
              defaultValue={objective?.objective ?? ""}
            />
          </Field>

          <ListField
            label="Questions to answer"
            name="question"
            values={questions}
            onChange={setQuestions}
            placeholder="Who authorised the payments?"
            hint="Findings are traced back to these, so each one is worth stating separately."
            error={state.fieldErrors?.questions}
          />

          <ListField
            label="Deliverables"
            name="deliverable"
            values={deliverables}
            onChange={setDeliverables}
            placeholder="Written report with an evidence schedule"
            error={state.fieldErrors?.deliverables}
          />

          <Field
            label="Deadline"
            htmlFor="objective-deadline"
            error={state.fieldErrors?.deadline}
          >
            <Input
              id="objective-deadline"
              name="deadline"
              type="datetime-local"
              defaultValue={forDateTimeInput(objective?.deadline)}
            />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}


"use client";

import { useState } from "react";
import { ArrowRight, Plus, Save, Send, UserCheck, X } from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui";
import {
  ENQUIRY_CHANNEL_LABELS,
  ENQUIRY_CHANNELS,
  ENQUIRY_STATUS_LABELS,
  URGENCY_LABELS,
  URGENCY_LEVELS,
  type Enquiry,
  type EnquiryStatus,
} from "@/modules/crm/shared";
import {
  assignEnquiry,
  createEnquiry,
  setEnquiryStage,
  updateEnquiry,
} from "./actions";

interface Reference {
  offices: Array<{ id: string; name: string }>;
  countries: Array<{ code: string; name: string }>;
  levels: Array<{ code: string; name: string }>;
  people: Array<{ id: string; name: string }>;
  clients: Array<{ id: string; name: string }>;
}

/**
 * The enquiry form, used both to log a new enquiry and to edit one.
 *
 * The party is either an existing client or a prospect's name, and the form
 * says so rather than offering both as if they were independent: one of the
 * two is required, and zod reports it against the prospect field.
 */
export function EnquiryForm({
  enquiry,
  reference,
}: {
  enquiry?: Enquiry;
  reference: Reference;
}) {
  const editing = enquiry !== undefined;

  return (
    <ActionForm
      action={editing ? updateEnquiry : createEnquiry}
      submitLabel={
        editing ? (
          <>
            <Save className="size-4" aria-hidden="true" />
            Save changes
          </>
        ) : (
          <>
            <Send className="size-4" aria-hidden="true" />
            Log enquiry
          </>
        )
      }
      hidden={
        editing
          ? { enquiryId: enquiry.id, expectedVersion: enquiry.version }
          : undefined
      }
    >
      {(state) => (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field
              label="Subject"
              htmlFor="subject"
              required
              hint="What is being asked for, in a line."
              error={state.fieldErrors?.subject}
            >
              <Input id="subject" name="subject" defaultValue={enquiry?.subject ?? ""} />
            </Field>
          </div>

          <Field
            label="Received by"
            htmlFor="receivedVia"
            required
            error={state.fieldErrors?.receivedVia}
          >
            <Select
              id="receivedVia"
              name="receivedVia"
              defaultValue={enquiry?.receivedVia ?? "email"}
            >
              {ENQUIRY_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {ENQUIRY_CHANNEL_LABELS[channel]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Urgency"
            htmlFor="urgency"
            required
            error={state.fieldErrors?.urgency}
          >
            <Select id="urgency" name="urgency" defaultValue={enquiry?.urgency ?? "normal"}>
              {URGENCY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {URGENCY_LABELS[level]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Existing client"
            htmlFor="clientId"
            hint="Leave empty if this is a new prospect."
            error={state.fieldErrors?.clientId}
          >
            <Select id="clientId" name="clientId" defaultValue={enquiry?.clientId ?? ""}>
              <option value="">Not an existing client</option>
              {reference.clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Prospect name"
            htmlFor="prospectName"
            hint="Required unless an existing client is picked."
            error={state.fieldErrors?.prospectName}
          >
            <Input
              id="prospectName"
              name="prospectName"
              defaultValue={enquiry?.prospectName ?? ""}
            />
          </Field>

          <Field
            label="Who got in touch"
            htmlFor="contactName"
            error={state.fieldErrors?.contactName}
          >
            <Input
              id="contactName"
              name="contactName"
              defaultValue={enquiry?.contactName ?? ""}
            />
          </Field>

          <Field
            label="Their email"
            htmlFor="contactEmail"
            error={state.fieldErrors?.contactEmail}
          >
            <Input
              id="contactEmail"
              name="contactEmail"
              type="email"
              defaultValue={enquiry?.contactEmail ?? ""}
            />
          </Field>

          <Field
            label="Their telephone"
            htmlFor="contactPhone"
            error={state.fieldErrors?.contactPhone}
          >
            <Input
              id="contactPhone"
              name="contactPhone"
              type="tel"
              defaultValue={enquiry?.contactPhone ?? ""}
            />
          </Field>

          <Field
            label="Service requested"
            htmlFor="requestedService"
            error={state.fieldErrors?.requestedService}
          >
            <Input
              id="requestedService"
              name="requestedService"
              placeholder="Corporate fraud investigation"
              defaultValue={enquiry?.requestedService ?? ""}
            />
          </Field>

          <Field
            label="Assigned to"
            htmlFor="assignedTo"
            error={state.fieldErrors?.assignedTo}
          >
            <Select
              id="assignedTo"
              name="assignedTo"
              defaultValue={enquiry?.assignedTo ?? ""}
            >
              <option value="">Unassigned</option>
              {reference.people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Country"
            htmlFor="enq-country"
            error={state.fieldErrors?.countryCode}
          >
            <Select
              id="enq-country"
              name="countryCode"
              defaultValue={enquiry?.countryCode ?? ""}
            >
              <option value="">Not recorded</option>
              {reference.countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="PDDC office" htmlFor="enq-office" error={state.fieldErrors?.officeId}>
            <Select id="enq-office" name="officeId" defaultValue={enquiry?.officeId ?? ""}>
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
            htmlFor="enq-classification"
            required
            error={state.fieldErrors?.classification}
          >
            <Select
              id="enq-classification"
              name="classification"
              defaultValue={enquiry?.classification ?? "CONFIDENTIAL"}
            >
              {reference.levels.map((level) => (
                <option key={level.code} value={level.code}>
                  {level.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="What they told us"
              htmlFor="enq-summary"
              error={state.fieldErrors?.summary}
            >
              <Textarea
                id="enq-summary"
                name="summary"
                rows={4}
                defaultValue={enquiry?.summary ?? ""}
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/**
 * Stage and assignment.
 *
 * The dropdown offers only the stages this enquiry can actually reach, which
 * come from the domain state machine on the server. The reason field appears
 * when declining, because a declined enquiry is kept permanently and the
 * reason is the useful part of it.
 */
export function EnquiryStagePanel({
  enquiry,
  transitions,
  people,
  canEdit,
}: {
  enquiry: Enquiry;
  transitions: readonly EnquiryStatus[];
  people: Array<{ id: string; name: string }>;
  canEdit: boolean;
}) {
  const [target, setTarget] = useState<string>(transitions[0] ?? "");

  return (
    <Card
      title="Stage and assignment"
      description="Enquiry, assessment, conflict check, quotation, acceptance. The order is enforced."
    >
      <div className="space-y-4">
        {!canEdit ? (
          <Alert tone="info">You do not have permission to move this enquiry on.</Alert>
        ) : transitions.length === 0 ? (
          <Alert tone="info">
            {ENQUIRY_STATUS_LABELS[enquiry.status]} is a closed stage. A fresh approach
            from the same party is logged as a new enquiry, so this one stays readable
            as it was.
          </Alert>
        ) : (
          <ActionForm
            action={setEnquiryStage}
            submitLabel={
              <>
                <ArrowRight className="size-4" aria-hidden="true" />
                Move to this stage
              </>
            }
            submitSize="sm"
            hidden={{ enquiryId: enquiry.id }}
          >
            {(state) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="Next stage"
                  htmlFor="enquiry-stage"
                  required
                  error={state.fieldErrors?.status}
                >
                  <Select
                    id="enquiry-stage"
                    name="status"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    {transitions.map((status) => (
                      <option key={status} value={status}>
                        {ENQUIRY_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  label={target === "declined" ? "Why it was declined" : "Note"}
                  htmlFor="enquiry-stage-reason"
                  required={target === "declined"}
                  hint="Recorded in the audit trail."
                  error={state.fieldErrors?.reason}
                >
                  <Input
                    id="enquiry-stage-reason"
                    name="reason"
                    placeholder={
                      target === "declined"
                        ? "Outside our remit"
                        : "Anything worth recording"
                    }
                  />
                </Field>
              </div>
            )}
          </ActionForm>
        )}

        {canEdit && (
          <div className="border-t border-line pt-4">
            <ActionForm
              action={assignEnquiry}
              submitLabel={
                <>
                  <UserCheck className="size-4" aria-hidden="true" />
                  Assign
                </>
              }
              submitSize="sm"
              hidden={{ enquiryId: enquiry.id }}
            >
              {(state) => (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Assigned to"
                    htmlFor="enquiry-assignee"
                    error={state.fieldErrors?.assignedTo}
                  >
                    <Select
                      id="enquiry-assignee"
                      name="assignedTo"
                      defaultValue={enquiry.assignedTo ?? ""}
                    >
                      <option value="">Unassigned</option>
                      {people.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field
                    label="Reason"
                    htmlFor="enquiry-assign-reason"
                    required
                    error={state.fieldErrors?.reason}
                  >
                    <Input
                      id="enquiry-assign-reason"
                      name="reason"
                      placeholder="Why this person"
                    />
                  </Field>
                </div>
              )}
            </ActionForm>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * The names to screen.
 *
 * PRD 8.3 wants the client, subjects, companies, directors, shareholders,
 * beneficial owners and related entities all searched, so the form takes a
 * list rather than one field, and it pre-fills what is already known.
 */
export function ScreeningTermsForm({
  initialTerms,
  enquiryId,
  engagementId,
  clientId,
  clients,
  action,
}: {
  initialTerms: string[];
  enquiryId?: string;
  engagementId?: string;
  clientId?: string;
  /**
   * Offered as a subject picker when the caller fixed no subject.
   *
   * A check has to belong to an enquiry, an engagement or a client: one that
   * belongs to nothing could never be acted on, and the database refuses it.
   * Reaching this form from the conflict list rather than from a record is
   * therefore the one case that has to ask.
   */
  clients?: Array<{ id: string; name: string }>;
  action: Parameters<typeof ActionForm>[0]["action"];
}) {
  // One empty row to type into when nothing is known yet.
  const [terms, setTerms] = useState<string[]>(
    initialTerms.length > 0 ? initialTerms : [""],
  );

  const subjectFixed = Boolean(enquiryId || engagementId || clientId);

  return (
    <ActionForm
      action={action}
      submitLabel="Run the check"
      pendingLabel="Searching"
      hidden={
        subjectFixed
          ? {
              enquiryId: enquiryId ?? "",
              engagementId: engagementId ?? "",
              clientId: clientId ?? "",
            }
          : { enquiryId: "", engagementId: "" }
      }
    >
      {(state) => (
        <div className="space-y-3">
          {!subjectFixed && (
            <Field
              label="This check is about"
              htmlFor="subject-client"
              required
              hint="Which client the work would be for. A check has to belong to a record so it can be found again."
              error={state.fieldErrors?.clientId}
            >
              <Select id="subject-client" name="clientId" defaultValue="">
                <option value="" disabled>
                  Choose a client
                </option>
                {(clients ?? []).map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <div className="space-y-2">
            {terms.map((term, index) => (
              <div key={index} className="flex gap-2">
                <div className="flex-1">
                  <label htmlFor={`term-${index}`} className="sr-only">
                    Name to screen {index + 1}
                  </label>
                  <Input
                    id={`term-${index}`}
                    name="term"
                    defaultValue={term}
                    placeholder={
                      index === 0
                        ? "ABC Holdings Ltd"
                        : "A director, shareholder or related company"
                    }
                  />
                </div>
                {terms.length > 1 && (
                  <Button
                    type="button"
                    tone="ghost"
                    onClick={() => setTerms(terms.filter((_, i) => i !== index))}
                    aria-label={`Remove name ${index + 1}`}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                )}
              </div>
            ))}
          </div>

          {state.fieldErrors?.terms && (
            <p role="alert" className="text-[11px] font-medium text-danger">
              {state.fieldErrors.terms}
            </p>
          )}

          <Button type="button" size="sm" onClick={() => setTerms([...terms, ""])}>
            <Plus className="size-4" aria-hidden="true" />
            Add another name
          </Button>

          <Field
            label="Sensitivity"
            htmlFor="threshold"
            hint="Lower catches more, including weaker matches. 0.3 catches a middle initial or an extra country word."
            error={state.fieldErrors?.threshold}
          >
            <Select id="threshold" name="threshold" defaultValue="0.3">
              <option value="0.2">Wide (0.2)</option>
              <option value="0.3">Standard (0.3)</option>
              <option value="0.5">Narrow (0.5)</option>
            </Select>
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

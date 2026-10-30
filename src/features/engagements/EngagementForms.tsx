"use client";

import {
  ArrowRight,
  BadgeCheck,
  Briefcase,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import { Alert, Card, Field, Input, Select, Textarea } from "@/components/ui";
import {
  ENGAGEMENT_STATUS_LABELS,
  ENGAGEMENT_TYPE_LABELS,
  ENGAGEMENT_TYPES,
  type ConflictStatus,
  type Engagement,
  type EngagementStatus,
} from "@/modules/crm/shared";
import {
  changeEngagementStatus,
  createEngagement,
  removeEngagement,
  restoreEngagement,
  updateEngagement,
} from "./actions";

interface Reference {
  offices: Array<{ id: string; name: string }>;
  countries: Array<{ code: string; name: string }>;
  levels: Array<{ code: string; name: string }>;
  people: Array<{ id: string; name: string }>;
  clients: Array<{ id: string; name: string }>;
  enquiries?: Array<{ id: string; name: string }>;
}

/**
 * The engagement form, used both to create and to edit.
 *
 * Scope and commercial terms are the fields that get frozen on approval: the
 * repository refuses to change them once the engagement is past
 * pending_approval, because they are what was signed off. The form says so
 * rather than letting somebody type into a field that will be rejected.
 */
export function EngagementForm({
  engagement,
  reference,
  defaultClientId,
  defaultEnquiryId,
  idempotencyKey,
}: {
  engagement?: Engagement;
  reference: Reference;
  defaultClientId?: string;
  defaultEnquiryId?: string;
  /**
   * A token from the server component rendering this form (PRD 21.7).
   *
   * Only the "new" pages pass one, because only creating mints a record: an
   * edit carries `expectedVersion`, so a duplicate gets a 409 rather than a
   * second row.
   */
  idempotencyKey?: string;
}) {
  const editing = engagement !== undefined;
  const frozen =
    editing &&
    engagement.status !== "draft" &&
    engagement.status !== "pending_approval";

  return (
    <ActionForm
      action={editing ? updateEngagement : createEngagement}
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
            Create engagement
          </>
        )
      }
      hidden={
        editing
          ? { engagementId: engagement.id, expectedVersion: engagement.version }
          : undefined
      }
    >
      {(state) => (
        <div className="grid gap-4 sm:grid-cols-2">
          {!editing && (
            <Field
              label="Client"
              htmlFor="clientId"
              required
              error={state.fieldErrors?.clientId}
            >
              <Select
                id="clientId"
                name="clientId"
                defaultValue={defaultClientId ?? ""}
              >
                <option value="" disabled>
                  Choose a client
                </option>
                {reference.clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label="Arising from"
            htmlFor="enquiryId"
            hint="The accepted enquiry this instruction came from, if there was one."
            error={state.fieldErrors?.enquiryId}
          >
            <Select
              id="enquiryId"
              name="enquiryId"
              defaultValue={engagement?.enquiryId ?? defaultEnquiryId ?? ""}
            >
              <option value="">Not from an enquiry</option>
              {(reference.enquiries ?? []).map((enquiry) => (
                <option key={enquiry.id} value={enquiry.id}>
                  {enquiry.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Title"
              htmlFor="title"
              required
              hint="What PDDC has been instructed to do, in a line."
              error={state.fieldErrors?.title}
            >
              <Input id="title" name="title" defaultValue={engagement?.title ?? ""} />
            </Field>
          </div>

          <Field
            label="Type of work"
            htmlFor="engagementType"
            required
            error={state.fieldErrors?.engagementType}
          >
            <Select
              id="engagementType"
              name="engagementType"
              defaultValue={engagement?.engagementType ?? "due_diligence"}
            >
              {ENGAGEMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ENGAGEMENT_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Responsible manager"
            htmlFor="responsibleManagerId"
            error={state.fieldErrors?.responsibleManagerId}
          >
            <Select
              id="responsibleManagerId"
              name="responsibleManagerId"
              defaultValue={engagement?.responsibleManagerId ?? ""}
            >
              <option value="">Not assigned</option>
              {reference.people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Starts" htmlFor="startDate" error={state.fieldErrors?.startDate}>
            <Input
              id="startDate"
              name="startDate"
              type="date"
              defaultValue={engagement?.startDate?.slice(0, 10) ?? ""}
            />
          </Field>

          <Field label="Ends" htmlFor="endDate" error={state.fieldErrors?.endDate}>
            <Input
              id="endDate"
              name="endDate"
              type="date"
              defaultValue={engagement?.endDate?.slice(0, 10) ?? ""}
            />
          </Field>

          <Field
            label="Contract reference"
            htmlFor="contractReference"
            error={state.fieldErrors?.contractReference}
          >
            <Input
              id="contractReference"
              name="contractReference"
              defaultValue={engagement?.contractReference ?? ""}
            />
          </Field>

          <Field
            label="NDA reference"
            htmlFor="ndaReference"
            error={state.fieldErrors?.ndaReference}
          >
            <Input
              id="ndaReference"
              name="ndaReference"
              defaultValue={engagement?.ndaReference ?? ""}
            />
          </Field>

          <Field
            label="Country"
            htmlFor="eng-country"
            error={state.fieldErrors?.countryCode}
          >
            <Select
              id="eng-country"
              name="countryCode"
              defaultValue={engagement?.countryCode ?? ""}
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
            label="PDDC office"
            htmlFor="eng-office"
            error={state.fieldErrors?.officeId}
          >
            <Select
              id="eng-office"
              name="officeId"
              defaultValue={engagement?.officeId ?? ""}
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
            htmlFor="eng-classification"
            required
            error={state.fieldErrors?.classification}
          >
            <Select
              id="eng-classification"
              name="classification"
              defaultValue={engagement?.classification ?? "CONFIDENTIAL"}
            >
              {reference.levels.map((level) => (
                <option key={level.code} value={level.code}>
                  {level.name}
                </option>
              ))}
            </Select>
          </Field>

          {frozen ? (
            <div className="sm:col-span-2">
              <Alert tone="info" title="Scope and terms are settled">
                This engagement has been approved, so its scope of services and
                commercial terms are what was signed off and cannot be edited here.
                Changing them is a scope change, which is a controlled process of its
                own.
              </Alert>
            </div>
          ) : (
            <>
              <div className="sm:col-span-2">
                <Field
                  label="Scope of services"
                  htmlFor="scopeOfServices"
                  hint="What is in scope, and anything explicitly out of it."
                  error={state.fieldErrors?.scopeOfServices}
                >
                  <Textarea
                    id="scopeOfServices"
                    name="scopeOfServices"
                    rows={5}
                    defaultValue={engagement?.scopeOfServices ?? ""}
                  />
                </Field>
              </div>

              <div className="sm:col-span-2">
                <Field
                  label="Commercial terms"
                  htmlFor="commercialTerms"
                  error={state.fieldErrors?.commercialTerms}
                >
                  <Textarea
                    id="commercialTerms"
                    name="commercialTerms"
                    rows={4}
                    defaultValue={engagement?.commercialTerms ?? ""}
                  />
                </Field>
              </div>
            </>
          )}
        </div>
      )}
    </ActionForm>
  );
}

/**
 * Status, approval and removal.
 *
 * Approval is deliberately not a plain transition in the dropdown: it has its
 * own button, its own explanation of what is blocking it, and it is hidden
 * from the person who raised the engagement. The server applies the same three
 * rules regardless, so the interface is a convenience rather than the control.
 */
export function EngagementStatusPanel({
  engagement,
  transitions,
  isAuthor,
  canEdit,
  canApprove,
  canRemove,
}: {
  engagement: Engagement;
  transitions: readonly EngagementStatus[];
  isAuthor: boolean;
  canEdit: boolean;
  canApprove: boolean;
  canRemove: boolean;
}) {
  // Approval is handled by its own form, so it is not offered twice.
  const plainTransitions = transitions.filter((s) => s !== "approved");

  if (engagement.deletedAt !== null) {
    return (
      <Card title="Engagement status">
        <Alert tone="warn" title="Engagement removed">
          This engagement was removed on{" "}
          {new Date(engagement.deletedAt).toLocaleString("en-GB")} and is in the recycle
          bin.
          {canEdit && (
            <div className="mt-3">
              <ActionForm
                action={restoreEngagement}
                submitLabel={
                  <>
                    <RotateCcw className="size-3.5" aria-hidden="true" />
                    Restore
                  </>
                }
                submitSize="sm"
                hidden={{
                  engagementId: engagement.id,
                  reason: "restored from the recycle bin",
                }}
                confirm={`Restore ${engagement.engagementId}?`}
                compact
              />
            </div>
          )}
        </Alert>
      </Card>
    );
  }

  return (
    <Card
      title="Engagement status"
      description="Draft, submitted, approved, active. An engagement cannot become active without being approved."
    >
      <div className="space-y-4">
        {engagement.status === "pending_approval" && (
          <ApprovalGate
            engagement={engagement}
            isAuthor={isAuthor}
            canApprove={canApprove}
          />
        )}

        {/* The approval's own success banner lives inside ApprovalGate, which
            a successful approval removes: the status is no longer
            pending_approval, so the block unmounts and takes the confirmation
            with it. Somebody who had just clicked Approve therefore saw
            nothing at all. This says so durably instead, which is also the
            right thing for anybody arriving later. */}
        {engagement.approvedAt !== null && (
          <Alert tone="ok" title="Approved">
            Approved by {engagement.approvedByName ?? "an administrator"} on{" "}
            {new Date(engagement.approvedAt).toLocaleString("en-GB")}. Cases can now be
            opened against this engagement.
          </Alert>
        )}

        {canEdit && plainTransitions.length > 0 && (
          <ActionForm
            action={changeEngagementStatus}
            submitLabel={
              <>
                <ArrowRight className="size-4" aria-hidden="true" />
                Apply status change
              </>
            }
            submitSize="sm"
            hidden={{ engagementId: engagement.id }}
          >
            {(state) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="New status"
                  htmlFor="engagement-status"
                  required
                  error={state.fieldErrors?.status}
                >
                  <Select
                    id="engagement-status"
                    name="status"
                    defaultValue={plainTransitions[0]}
                  >
                    {plainTransitions.map((status) => (
                      <option key={status} value={status}>
                        {ENGAGEMENT_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  label="Reason for the status change"
                  htmlFor="engagement-status-reason"
                  required
                  hint="Recorded in the audit trail."
                  error={state.fieldErrors?.reason}
                >
                  <Input
                    id="engagement-status-reason"
                    name="reason"
                    placeholder="Why is this changing?"
                  />
                </Field>
              </div>
            )}
          </ActionForm>
        )}

        {transitions.length === 0 && (
          <Alert tone="info">
            {ENGAGEMENT_STATUS_LABELS[engagement.status]} is final. The engagement and
            everything under it stay readable.
          </Alert>
        )}

        {canRemove && (
          <div className="border-t border-line pt-4">
            <p className="mb-2 text-xs font-medium text-body">Remove this engagement</p>
            <p className="mb-3 text-xs text-muted">
              Only possible while no cases have been opened against it. Once there are
              cases, cancel it instead, which keeps them readable.
            </p>
            <ActionForm
              action={removeEngagement}
              submitLabel={
                <>
                  <Trash2 className="size-4" aria-hidden="true" />
                  Remove this engagement
                </>
              }
              submitTone="danger"
              submitSize="sm"
              hidden={{ engagementId: engagement.id }}
              confirm="Remove this engagement? It can be restored from the recycle bin."
            >
              {(state) => (
                <Field
                  label="Reason for removal"
                  htmlFor="engagement-remove-reason"
                  required
                  error={state.fieldErrors?.reason}
                >
                  <Input
                    id="engagement-remove-reason"
                    name="reason"
                    placeholder="Raised in error"
                  />
                </Field>
              )}
            </ActionForm>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * What stands between a submitted engagement and approval.
 *
 * Says which of the three conditions is unmet rather than disabling a button
 * silently, because "why can I not approve this" is the question somebody will
 * otherwise ask a colleague.
 */
function ApprovalGate({
  engagement,
  isAuthor,
  canApprove,
}: {
  engagement: Engagement;
  isAuthor: boolean;
  canApprove: boolean;
}) {
  const blocker = approvalBlocker(engagement.conflictStatus, isAuthor);

  if (!canApprove) {
    return (
      <Alert tone="info" title="Awaiting approval">
        This engagement has been submitted. Somebody with approval rights has to sign it
        off before work can start.
      </Alert>
    );
  }

  if (blocker) {
    return (
      <Alert tone="warn" title="Cannot be approved yet">
        {blocker}
      </Alert>
    );
  }

  return (
    <div className="rounded-lg border border-signal/35 bg-signal/5 p-3">
      <p className="mb-1 text-sm font-semibold text-body">Ready for approval</p>
      <p className="mb-3 text-xs text-muted">
        The conflict check has been decided and you did not raise this engagement.
        Approving it commits PDDC to the work and lets cases be opened against it.
      </p>
      <ActionForm
        action={changeEngagementStatus}
        submitLabel={
          <>
            <BadgeCheck className="size-4" aria-hidden="true" />
            Approve this engagement
          </>
        }
        submitSize="sm"
        hidden={{ engagementId: engagement.id, status: "approved" }}
        confirm="Approve this engagement?"
      >
        {(state) => (
          <Field
            label="Approval note"
            htmlFor="approval-reason"
            required
            hint="Recorded against the approval in the audit trail."
            error={state.fieldErrors?.reason}
          >
            <Input
              id="approval-reason"
              name="reason"
              placeholder="Scope and terms reviewed, conflict cleared"
            />
          </Field>
        )}
      </ActionForm>
    </div>
  );
}

/** The first unmet approval condition, in the order the server checks them. */
function approvalBlocker(
  conflictStatus: ConflictStatus | null,
  isAuthor: boolean,
): string | null {
  if (conflictStatus === null) {
    return "No conflict check has been run. Run one and have it decided before approving.";
  }
  if (conflictStatus === "open") {
    return "The conflict check has not been decided. An undecided check is not a clearance.";
  }
  if (conflictStatus === "declined") {
    return "The conflict check was declined, so this engagement cannot be approved. Raise a new check if the position has changed.";
  }
  if (isAuthor) {
    return "You raised this engagement, so somebody else has to approve it.";
  }
  return null;
}

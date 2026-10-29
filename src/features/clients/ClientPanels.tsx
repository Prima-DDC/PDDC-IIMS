"use client";

import { AppLink } from "@/components/AppLink";
import { useState } from "react";
import {
  CheckCircle2,
  FilePlus2,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import {
  Alert,
  Badge,
  Button,
  Card,
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
  CLIENT_STATUS_LABELS,
  CLIENT_STATUSES,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPES,
  KYC_CHECK_LABELS,
  KYC_CHECK_TYPES,
  KYC_OUTCOME_LABELS,
  KYC_OUTCOMES,
  type Client,
  type ClientContact,
  type ClientDocument,
  type KycAssessment,
  type KycRecord,
} from "@/modules/crm/shared";
import {
  addContact,
  addDocument,
  addKycRecord,
  changeClientStatus,
  removeClient,
  removeContact,
  removeDocument,
  restoreClient,
  updateContact,
  updateKycRecord,
} from "./actions";
import { KycBadge } from "./ClientBadges";

/** A short date, with a placeholder rather than an empty cell. */
function when(value: string | null) {
  if (!value) return <NotSet />;
  return <>{new Date(value).toLocaleDateString("en-GB")}</>;
}

/* ------------------------------------------------------------------ KYC */

/**
 * Know-your-customer (PRD 8.1).
 *
 * The heading is the derived position, not a stored field: `assessment` comes
 * from assessKyc over the records below it, so what the badge says and what
 * the table shows can never disagree. The outstanding checks are listed by
 * name, because "in progress" on its own tells somebody nothing about what to
 * do next.
 */
export function KycPanel({
  client,
  records,
  assessment,
  documents,
  canEdit,
}: {
  client: Client;
  records: KycRecord[];
  assessment: KycAssessment;
  documents: ClientDocument[];
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);

  const outstanding = [
    ...assessment.missing.map((c) => ({ check: c, why: "not recorded" })),
    ...assessment.unresolved.map((c) => ({ check: c, why: "awaiting an outcome" })),
    ...assessment.expired.map((c) => ({ check: c, why: "expired" })),
    ...assessment.failed.map((c) => ({ check: c, why: "failed" })),
  ];

  return (
    <Card
      title="Know your customer"
      description="The status is worked out from the checks on file, so it cannot be set by hand."
      actions={
        canEdit && !adding ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Record a check
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <KycBadge status={assessment.status} />
          <Muted>
            {assessment.required.length} check
            {assessment.required.length === 1 ? "" : "s"} required at{" "}
            {client.riskRating} risk
          </Muted>
        </div>

        {outstanding.length > 0 ? (
          <Alert
            tone={
              assessment.failed.length > 0 || assessment.expired.length > 0
                ? "danger"
                : "warn"
            }
            title="Outstanding"
          >
            <ul className="mt-1 space-y-0.5">
              {outstanding.map((item) => (
                <li key={item.check}>
                  {KYC_CHECK_LABELS[item.check]}: {item.why}
                </li>
              ))}
            </ul>
          </Alert>
        ) : (
          <Alert tone="ok" title="Complete">
            Every check required at {client.riskRating} risk has passed and none has
            expired.
          </Alert>
        )}

        {adding && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Record a check</p>
              <Button size="sm" tone="ghost" onClick={() => setAdding(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ActionForm
              action={addKycRecord}
              submitLabel={
                <>
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  Record check
                </>
              }
              submitSize="sm"
              hidden={{ clientId: client.id }}
            >
              {(state) => (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Check"
                    htmlFor="checkType"
                    required
                    error={state.fieldErrors?.checkType}
                  >
                    <Select id="checkType" name="checkType" defaultValue="identity">
                      {KYC_CHECK_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {KYC_CHECK_LABELS[type]}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field
                    label="Outcome"
                    htmlFor="outcome"
                    required
                    error={state.fieldErrors?.outcome}
                  >
                    <Select id="outcome" name="outcome" defaultValue="pass">
                      {KYC_OUTCOMES.map((outcome) => (
                        <option key={outcome} value={outcome}>
                          {KYC_OUTCOME_LABELS[outcome]}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field
                    label="Valid until"
                    htmlFor="kyc-expires"
                    hint="Leave empty if the check does not lapse."
                    error={state.fieldErrors?.expiresAt}
                  >
                    <Input id="kyc-expires" name="expiresAt" type="date" />
                  </Field>

                  <Field
                    label="Evidence document"
                    htmlFor="evidenceDocumentId"
                    error={state.fieldErrors?.evidenceDocumentId}
                  >
                    <Select id="evidenceDocumentId" name="evidenceDocumentId" defaultValue="">
                      <option value="">None attached</option>
                      {documents.map((doc) => (
                        <option key={doc.id} value={doc.id}>
                          {doc.title}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <div className="sm:col-span-2">
                    <Field
                      label="What was checked, and against what"
                      htmlFor="kyc-summary"
                      error={state.fieldErrors?.summary}
                    >
                      <Textarea
                        id="kyc-summary"
                        name="summary"
                        rows={2}
                        placeholder="Registrar-General search, certificate 12345, confirmed 2026-10-21"
                      />
                    </Field>
                  </div>
                </div>
              )}
            </ActionForm>
          </div>
        )}

        {records.length === 0 ? (
          <EmptyState
            title="No checks recorded"
            description="Record identity, registration and beneficial ownership at a minimum."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Check</Th>
                <Th>Outcome</Th>
                <Th>Performed</Th>
                <Th>Valid until</Th>
                <Th>By</Th>
                {canEdit && <Th className="text-right">Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <KycRow
                  key={record.id}
                  record={record}
                  canEdit={canEdit}
                />
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Card>
  );
}

function KycRow({ record, canEdit }: { record: KycRecord; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);

  const tone =
    record.outcome === "pass"
      ? "ok"
      : record.outcome === "fail"
        ? "danger"
        : record.outcome === "inconclusive"
          ? "warn"
          : "neutral";

  if (editing) {
    return (
      <tr>
        <Td className="font-medium">{KYC_CHECK_LABELS[record.checkType]}</Td>
        <Td className="align-top" >
          <div className="min-w-64">
            <ActionForm
              action={updateKycRecord}
              submitLabel="Save"
              submitSize="sm"
              hidden={{ kycId: record.id, expectedVersion: record.version }}
            >
              {(state) => (
                <div className="space-y-2">
                  <Field label="Outcome" htmlFor={`outcome-${record.id}`} required>
                    <Select
                      id={`outcome-${record.id}`}
                      name="outcome"
                      defaultValue={record.outcome}
                    >
                      {KYC_OUTCOMES.map((outcome) => (
                        <option key={outcome} value={outcome}>
                          {KYC_OUTCOME_LABELS[outcome]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Valid until" htmlFor={`expires-${record.id}`}>
                    <Input
                      id={`expires-${record.id}`}
                      name="expiresAt"
                      type="date"
                      defaultValue={record.expiresAt?.slice(0, 10) ?? ""}
                    />
                  </Field>
                  <Field
                    label="Summary"
                    htmlFor={`summary-${record.id}`}
                    error={state.fieldErrors?.summary}
                  >
                    <Textarea
                      id={`summary-${record.id}`}
                      name="summary"
                      rows={2}
                      defaultValue={record.summary ?? ""}
                    />
                  </Field>
                </div>
              )}
            </ActionForm>
          </div>
        </Td>
        <Td colSpan={canEdit ? 4 : 3} className="align-top">
          <Button size="sm" tone="ghost" onClick={() => setEditing(false)}>
            <X className="size-4" aria-hidden="true" />
            Cancel
          </Button>
        </Td>
      </tr>
    );
  }

  return (
    <tr>
      <Td className="font-medium">{KYC_CHECK_LABELS[record.checkType]}</Td>
      <Td>
        <Badge tone={tone}>{KYC_OUTCOME_LABELS[record.outcome]}</Badge>
        {record.summary && (
          <p className="mt-1 max-w-sm text-[11px] text-muted">{record.summary}</p>
        )}
      </Td>
      <Td>{when(record.performedAt)}</Td>
      <Td>{when(record.expiresAt)}</Td>
      <Td>{record.performedByName ?? <NotSet />}</Td>
      {canEdit && (
        <Td className="text-right">
          <Button size="sm" tone="ghost" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" aria-hidden="true" />
            Edit
          </Button>
        </Td>
      )}
    </tr>
  );
}

/* -------------------------------------------------------------- contacts */

export function ContactsPanel({
  clientId,
  contacts,
  canEdit,
}: {
  clientId: string;
  contacts: ClientContact[];
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <Card
      title="Contacts"
      description="One contact can be marked primary; naming another moves it."
      actions={
        canEdit && !adding ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Add contact
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {adding && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">New contact</p>
              <Button size="sm" tone="ghost" onClick={() => setAdding(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ContactFields
              action={addContact}
              hidden={{ clientId }}
              submitLabel="Add contact"
            />
          </div>
        )}

        {contacts.length === 0 ? (
          <EmptyState
            title="No contacts yet"
            description="Add the people PDDC deals with at this organisation."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Position</Th>
                <Th>Email</Th>
                <Th>Telephone</Th>
                {canEdit && <Th className="text-right">Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) =>
                editingId === contact.id ? (
                  <tr key={contact.id}>
                    <Td colSpan={canEdit ? 5 : 4}>
                      <div className="max-w-2xl">
                        <ContactFields
                          action={updateContact}
                          hidden={{
                            contactId: contact.id,
                            expectedVersion: contact.version,
                          }}
                          contact={contact}
                          submitLabel="Save contact"
                        />
                        <div className="mt-2">
                          <Button
                            size="sm"
                            tone="ghost"
                            onClick={() => setEditingId(null)}
                          >
                            <X className="size-4" aria-hidden="true" />
                            Cancel
                          </Button>
                        </div>
                      </div>
                    </Td>
                  </tr>
                ) : (
                  <tr key={contact.id}>
                    <Td>
                      <span className="font-medium text-body">{contact.fullName}</span>
                      {contact.isPrimary && (
                        <span className="ml-2">
                          <Badge tone="signal">
                            <Star className="size-3" aria-hidden="true" />
                            Primary
                          </Badge>
                        </span>
                      )}
                      {contact.notes && (
                        <p className="mt-0.5 text-[11px] text-muted">{contact.notes}</p>
                      )}
                    </Td>
                    <Td>{contact.position ?? <NotSet />}</Td>
                    <Td>
                      {contact.email ? (
                        <a
                          href={`mailto:${contact.email}`}
                          className="text-signal-dark hover:underline"
                        >
                          {contact.email}
                        </a>
                      ) : (
                        <NotSet />
                      )}
                    </Td>
                    <Td>{contact.telephone ?? <NotSet />}</Td>
                    {canEdit && (
                      <Td className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            tone="ghost"
                            onClick={() => setEditingId(contact.id)}
                          >
                            <Pencil className="size-3.5" aria-hidden="true" />
                            Edit
                          </Button>
                          <ActionForm
                            action={removeContact}
                            submitLabel={
                              <Trash2 className="size-3.5" aria-hidden="true" />
                            }
                            submitTone="danger"
                            submitSize="sm"
                            hidden={{
                              contactId: contact.id,
                              reason: "removed from the client record",
                            }}
                            confirm={`Remove ${contact.fullName}?`}
                            compact
                          />
                        </div>
                      </Td>
                    )}
                  </tr>
                ),
              )}
            </tbody>
          </Table>
        )}
      </div>
    </Card>
  );
}

/** The contact fields, shared by the add and edit forms. */
function ContactFields({
  action,
  hidden,
  contact,
  submitLabel,
}: {
  action: Parameters<typeof ActionForm>[0]["action"];
  hidden: Record<string, string | number>;
  contact?: ClientContact;
  submitLabel: string;
}) {
  return (
    <ActionForm action={action} submitLabel={submitLabel} submitSize="sm" hidden={hidden}>
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Full name"
            htmlFor={`fullName-${contact?.id ?? "new"}`}
            required
            error={state.fieldErrors?.fullName}
          >
            <Input
              id={`fullName-${contact?.id ?? "new"}`}
              name="fullName"
              defaultValue={contact?.fullName ?? ""}
            />
          </Field>

          <Field
            label="Position"
            htmlFor={`position-${contact?.id ?? "new"}`}
            error={state.fieldErrors?.position}
          >
            <Input
              id={`position-${contact?.id ?? "new"}`}
              name="position"
              defaultValue={contact?.position ?? ""}
            />
          </Field>

          <Field
            label="Email"
            htmlFor={`email-${contact?.id ?? "new"}`}
            error={state.fieldErrors?.email}
          >
            <Input
              id={`email-${contact?.id ?? "new"}`}
              name="email"
              type="email"
              defaultValue={contact?.email ?? ""}
            />
          </Field>

          <Field
            label="Telephone"
            htmlFor={`telephone-${contact?.id ?? "new"}`}
            error={state.fieldErrors?.telephone}
          >
            <Input
              id={`telephone-${contact?.id ?? "new"}`}
              name="telephone"
              type="tel"
              defaultValue={contact?.telephone ?? ""}
            />
          </Field>

          <div className="sm:col-span-2">
            <label className="flex items-center gap-2 text-xs text-body">
              <input
                type="checkbox"
                name="isPrimary"
                defaultChecked={contact?.isPrimary ?? false}
                className="size-4 rounded border-line text-signal focus:ring-signal/25"
              />
              This is the primary contact
            </label>
          </div>

          <div className="sm:col-span-2">
            <Field
              label="Notes"
              htmlFor={`notes-${contact?.id ?? "new"}`}
              error={state.fieldErrors?.notes}
            >
              <Textarea
                id={`notes-${contact?.id ?? "new"}`}
                name="notes"
                rows={2}
                defaultValue={contact?.notes ?? ""}
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/* ------------------------------------------------------------- documents */

export function DocumentsPanel({
  clientId,
  documents,
  levels,
  canEdit,
}: {
  clientId: string;
  documents: ClientDocument[];
  levels: Array<{ code: string; name: string }>;
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Card
      title="Documents"
      description="Registration certificates, NDAs, engagement letters and KYC evidence."
      actions={
        canEdit && !adding ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <FilePlus2 className="size-4" aria-hidden="true" />
            Register a document
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {adding && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Register a document</p>
              <Button size="sm" tone="ghost" onClick={() => setAdding(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <Alert tone="info">
              This records what the document is and where it lives. Uploading the file
              itself, with its hash verified server-side, arrives with the evidence
              module.
            </Alert>
            <div className="mt-3">
              <ActionForm
                action={addDocument}
                submitLabel="Register document"
                submitSize="sm"
                hidden={{ clientId }}
              >
                {(state) => (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field
                      label="Type"
                      htmlFor="documentType"
                      required
                      error={state.fieldErrors?.documentType}
                    >
                      <Select
                        id="documentType"
                        name="documentType"
                        defaultValue="registration"
                      >
                        {DOCUMENT_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {DOCUMENT_TYPE_LABELS[type]}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field
                      label="Title"
                      htmlFor="doc-title"
                      required
                      error={state.fieldErrors?.title}
                    >
                      <Input id="doc-title" name="title" />
                    </Field>

                    <Field
                      label="File name"
                      htmlFor="fileName"
                      error={state.fieldErrors?.fileName}
                    >
                      <Input id="fileName" name="fileName" />
                    </Field>

                    <Field
                      label="Classification"
                      htmlFor="doc-classification"
                      required
                      error={state.fieldErrors?.classification}
                    >
                      <Select
                        id="doc-classification"
                        name="classification"
                        defaultValue="CONFIDENTIAL"
                      >
                        {levels.map((level) => (
                          <option key={level.code} value={level.code}>
                            {level.name}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field
                      label="Expires"
                      htmlFor="doc-expires"
                      hint="For a document with a validity period, such as a certificate."
                      error={state.fieldErrors?.expiresAt}
                    >
                      <Input id="doc-expires" name="expiresAt" type="date" />
                    </Field>

                    <Field
                      label="SHA-256 hash"
                      htmlFor="sha256Hash"
                      hint="Optional. 64 hexadecimal characters."
                      error={state.fieldErrors?.sha256Hash}
                    >
                      <Input id="sha256Hash" name="sha256Hash" className="font-id" />
                    </Field>

                    <div className="sm:col-span-2">
                      <Field
                        label="Storage key"
                        htmlFor="storageKey"
                        hint="Where the file lives, if it has already been uploaded."
                        error={state.fieldErrors?.storageKey}
                      >
                        <Input id="storageKey" name="storageKey" className="font-id" />
                      </Field>
                    </div>
                  </div>
                )}
              </ActionForm>
            </div>
          </div>
        )}

        {documents.length === 0 ? (
          <EmptyState
            title="No documents registered"
            description="Register the certificate of registration and the signed engagement letter."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Document</Th>
                <Th>Type</Th>
                <Th>Classification</Th>
                <Th>Expires</Th>
                <Th>Registered</Th>
                {canEdit && <Th className="text-right">Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => {
                const expired = doc.expiresAt !== null && doc.expiresAt < today;
                return (
                  <tr key={doc.id}>
                    <Td>
                      <span className="font-medium text-body">{doc.title}</span>
                      {doc.fileName && (
                        <p className="mt-0.5 text-[11px] text-muted">{doc.fileName}</p>
                      )}
                      {doc.sha256Hash && (
                        <p className="mt-0.5 truncate text-[10px] text-faint">
                          <Id>{doc.sha256Hash.slice(0, 16)}</Id>
                        </p>
                      )}
                    </Td>
                    <Td>{DOCUMENT_TYPE_LABELS[doc.documentType]}</Td>
                    <Td>
                      <Badge tone="neutral">
                        {doc.classification.replace(/_/g, " ")}
                      </Badge>
                    </Td>
                    <Td>
                      {doc.expiresAt === null ? (
                        <Muted>does not lapse</Muted>
                      ) : expired ? (
                        <Badge tone="danger">expired {when(doc.expiresAt)}</Badge>
                      ) : (
                        when(doc.expiresAt)
                      )}
                    </Td>
                    <Td>
                      {when(doc.uploadedAt)}
                      {doc.uploadedByName && (
                        <p className="text-[11px] text-muted">{doc.uploadedByName}</p>
                      )}
                    </Td>
                    {canEdit && (
                      <Td className="text-right">
                        <ActionForm
                          action={removeDocument}
                          submitLabel={<Trash2 className="size-3.5" aria-hidden="true" />}
                          submitTone="danger"
                          submitSize="sm"
                          hidden={{
                            documentId: doc.id,
                            reason: "removed from the client record",
                          }}
                          confirm={`Remove ${doc.title}?`}
                          compact
                        />
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- status */

/**
 * Status and removal.
 *
 * A removed client keeps its page, and the page says so and offers the way
 * back, rather than hiding the controls and leaving somebody wondering whether
 * the removal worked.
 */
export function ClientStatusPanel({
  client,
  canEdit,
  canRemove,
}: {
  client: Client;
  canEdit: boolean;
  canRemove: boolean;
}) {
  if (client.deletedAt !== null) {
    return (
      <Card title="Client status">
        <Alert tone="warn" title="Client removed">
          This client was removed on{" "}
          {new Date(client.deletedAt).toLocaleString("en-GB")} and is in the recycle
          bin. Its engagements and the audit trail still refer to it.
          {canEdit && (
            <div className="mt-3">
              <ActionForm
                action={restoreClient}
                submitLabel={
                  <>
                    <RotateCcw className="size-3.5" aria-hidden="true" />
                    Restore
                  </>
                }
                submitSize="sm"
                hidden={{
                  clientId: client.id,
                  reason: "restored from the recycle bin",
                }}
                confirm={`Restore ${client.organisationName}?`}
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
      title="Client status"
      description="Dormant and suspended clients stay readable and stop appearing as options for new work."
    >
      <div className="space-y-4">
        {canEdit ? (
          <ActionForm
            action={changeClientStatus}
            submitLabel={
              <>
                <CheckCircle2 className="size-4" aria-hidden="true" />
                Apply status change
              </>
            }
            submitSize="sm"
            hidden={{ clientId: client.id }}
          >
            {(state) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="New status"
                  htmlFor="client-status"
                  required
                  error={state.fieldErrors?.status}
                >
                  <Select id="client-status" name="status" defaultValue={client.status}>
                    {CLIENT_STATUSES.filter((s) => s !== client.status).map((status) => (
                      <option key={status} value={status}>
                        {CLIENT_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  label="Reason for the status change"
                  htmlFor="client-status-reason"
                  required
                  hint="Recorded in the audit trail."
                  error={state.fieldErrors?.reason}
                >
                  <Input
                    id="client-status-reason"
                    name="reason"
                    placeholder="Why is this changing?"
                  />
                </Field>
              </div>
            )}
          </ActionForm>
        ) : (
          <Alert tone="info">You do not have permission to change this client.</Alert>
        )}

        {canRemove && (
          <div className="border-t border-line pt-4">
            <p className="mb-2 text-xs font-medium text-body">Remove this client</p>
            <p className="mb-3 text-xs text-muted">
              A recoverable removal: the record moves to the recycle bin and the audit
              trail keeps it for accountability. Engagements that are not closed have to
              be completed or cancelled first.
            </p>
            <ActionForm
              action={removeClient}
              submitLabel={
                <>
                  <Trash2 className="size-4" aria-hidden="true" />
                  Remove this client
                </>
              }
              submitTone="danger"
              submitSize="sm"
              hidden={{ clientId: client.id }}
              confirm="Remove this client? It can be restored from the recycle bin."
            >
              {(state) => (
                <Field
                  label="Reason for removal"
                  htmlFor="client-remove-reason"
                  required
                  error={state.fieldErrors?.reason}
                >
                  <Input
                    id="client-remove-reason"
                    name="reason"
                    placeholder="Duplicate of CLI-2026-000123"
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

/* ----------------------------------------------------------- engagements */

export function ClientEngagementsPanel({
  clientId,
  engagements,
  canCreate,
}: {
  clientId: string;
  engagements: Array<{
    id: string;
    engagementId: string;
    title: string;
    status: string;
    startDate: string | null;
  }>;
  canCreate: boolean;
}) {
  return (
    <Card
      title="Engagements"
      description="The work PDDC has been instructed to do for this client. Cases hang off an engagement."
      actions={
        canCreate ? (
          <AppLink
            href={`/engagements/new?clientId=${clientId}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-signal px-2.5 text-xs font-medium text-white hover:bg-signal-dark"
          >
            <Plus className="size-4" aria-hidden="true" />
            New engagement
          </AppLink>
        ) : undefined
      }
    >
      {engagements.length === 0 ? (
        <EmptyState
          title="No engagements yet"
          description="An engagement records the instruction, its scope and its commercial terms."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Reference</Th>
              <Th>Title</Th>
              <Th>Status</Th>
              <Th>Started</Th>
            </tr>
          </thead>
          <tbody>
            {engagements.map((engagement) => (
              <tr key={engagement.id}>
                <Td>
                  <AppLink
                    href={`/engagements/${engagement.id}`}
                    className="hover:underline"
                  >
                    <Id>{engagement.engagementId}</Id>
                  </AppLink>
                </Td>
                <Td className="font-medium text-body">{engagement.title}</Td>
                <Td>{engagement.status.replace(/_/g, " ")}</Td>
                <Td>{when(engagement.startDate)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

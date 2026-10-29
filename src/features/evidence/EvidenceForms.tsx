"use client";

import { useState } from "react";
import { ArrowRight, Copy, Plus, ShieldAlert, Trash2, X } from "lucide-react";
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
  CUSTODY_EVENT_LABELS,
  CUSTODY_EVENT_TYPES,
  CUSTODY_MOVEMENTS,
  EVIDENCE_TYPES,
  EVIDENCE_TYPE_LABELS,
  allowedEvidenceTransitions,
  type CustodyEvent,
  type EvidenceItem,
} from "@/modules/evidence/shared";
import {
  correctCustodyEvent,
  recordCustodyEvent,
  registerEvidence,
  removeEvidence,
  restoreEvidence,
  setEvidenceStatus,
  takeWorkingCopy,
  updateEvidence,
} from "./actions";

/** The forms that write to the evidence register (PRD 6). */

type Person = { id: string; name: string };
type Level = { code: string; name: string };

/** Registering an item, or editing one that is already registered. */
export function EvidenceForm({
  caseRecordId,
  item,
  people,
  levels,
  defaultClassification,
  actorId,
}: {
  caseRecordId: string;
  item?: EvidenceItem;
  people: Person[];
  levels: Level[];
  defaultClassification: string;
  actorId: string;
}) {
  const editing = item !== undefined;

  return (
    <ActionForm
      action={editing ? updateEvidence : registerEvidence}
      submitLabel={editing ? "Save the item" : "Register the item"}
      submitSize="sm"
      hidden={
        editing
          ? {
              caseRecordId,
              evidenceRecordId: item.id,
              expectedVersion: item.version,
            }
          : { caseRecordId }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="What it is"
            htmlFor="ev-type"
            required
            error={state.fieldErrors?.evidenceType}
          >
            <Select
              id="ev-type"
              name="evidenceType"
              defaultValue={item?.evidenceType ?? "document"}
            >
              {EVIDENCE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {EVIDENCE_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Exhibit number"
            htmlFor="ev-exhibit"
            hint="Optional, and usually allocated when the item is first cited."
            error={state.fieldErrors?.exhibitNo}
          >
            <Input
              id="ev-exhibit"
              name="exhibitNo"
              defaultValue={item?.exhibitNo ?? ""}
              placeholder="A-14"
            />
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Description"
              htmlFor="ev-description"
              required
              hint="What it is, in enough detail that somebody who has never seen it could identify it."
              error={state.fieldErrors?.description}
            >
              <Textarea
                id="ev-description"
                name="description"
                rows={3}
                defaultValue={item?.description ?? ""}
                placeholder="Bank statement for account 1234567, January to June, 14 pages, handed over by the finance director."
              />
            </Field>
          </div>

          {!editing && (
            <>
              <Field
                label="Collected by"
                htmlFor="ev-collected-by"
                required
                hint="Who physically took it. PRD 6.1 makes this mandatory."
                error={state.fieldErrors?.collectedBy}
              >
                <Select id="ev-collected-by" name="collectedBy" defaultValue={actorId}>
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Collected at"
                htmlFor="ev-collected-at"
                required
                error={state.fieldErrors?.collectedAt}
              >
                <Input id="ev-collected-at" name="collectedAt" type="datetime-local" />
              </Field>
            </>
          )}

          <Field
            label="Where it was collected"
            htmlFor="ev-location"
            required
            error={state.fieldErrors?.collectionLocation}
          >
            <Input
              id="ev-location"
              name="collectionLocation"
              defaultValue={item?.collectionLocation ?? ""}
              placeholder="The client's registry office, Accra"
            />
          </Field>

          <Field
            label="How it was collected"
            htmlFor="ev-method"
            required
            error={state.fieldErrors?.collectionMethod}
          >
            <Input
              id="ev-method"
              name="collectionMethod"
              defaultValue={item?.collectionMethod ?? ""}
              placeholder="Handed over by the finance director and bagged on site"
            />
          </Field>

          <Field
            label="Classification"
            htmlFor="ev-classification"
            required
            hint="An item can be more sensitive than the case it belongs to."
            error={state.fieldErrors?.classification}
          >
            <Select
              id="ev-classification"
              name="classification"
              defaultValue={item?.classification ?? defaultClassification}
            >
              {levels.map((level) => (
                <option key={level.code} value={level.code}>
                  {level.name}
                </option>
              ))}
            </Select>
          </Field>

          {!editing && (
            <Field
              label="Who holds it now"
              htmlFor="ev-custodian"
              hint="Left empty, whoever collected it."
              error={state.fieldErrors?.currentCustodian}
            >
              <Select id="ev-custodian" name="currentCustodian" defaultValue="">
                <option value="">Whoever collected it</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      )}
    </ActionForm>
  );
}

/** Taking a working copy, so the original is never worked on (PRD 6.3). */
export function WorkingCopyForm({
  caseRecordId,
  original,
  people,
}: {
  caseRecordId: string;
  original: EvidenceItem;
  people: Person[];
}) {
  return (
    <ActionForm
      action={takeWorkingCopy}
      submitLabel={
        <>
          <Copy className="size-4" aria-hidden="true" />
          Take a working copy
        </>
      }
      submitSize="sm"
      hidden={{ caseRecordId, originalEvidenceId: original.id }}
    >
      {(state) => (
        <div className="space-y-3">
          <Muted>
            The copy carries {original.evidenceId}&apos;s classification, because a
            copy of a restricted item is restricted.
          </Muted>

          <Field
            label="What the copy is for"
            htmlFor="copy-description"
            required
            error={state.fieldErrors?.description}
          >
            <Textarea
              id="copy-description"
              name="description"
              rows={2}
              placeholder="Working copy for the forensic accountant's reconciliation."
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="How the copy was made"
              htmlFor="copy-method"
              required
              error={state.fieldErrors?.collectionMethod}
            >
              <Input
                id="copy-method"
                name="collectionMethod"
                placeholder="Imaged with write-blocker, verified against the original hash"
              />
            </Field>

            <Field
              label="Who holds the copy"
              htmlFor="copy-custodian"
              error={state.fieldErrors?.custodian}
            >
              <Select id="copy-custodian" name="custodian" defaultValue="">
                <option value="">Me</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/**
 * Moving an item's status.
 *
 * Releasing or returning is a movement, so the form asks for the custody
 * details then: a status that says released with nobody holding it is exactly
 * the gap the ledger exists to close, and the rule refuses it.
 */
export function EvidenceStatusForm({
  caseRecordId,
  item,
  people,
}: {
  caseRecordId: string;
  item: EvidenceItem;
  people: Person[];
}) {
  const transitions = allowedEvidenceTransitions(item.status);
  const [target, setTarget] = useState<string>(transitions[0] ?? "");
  const [shown, setShown] = useState(item.status);

  // Adjusted in place rather than by keying the component, so the
  // confirmation of the move that caused it survives.
  if (shown !== item.status) {
    setShown(item.status);
    setTarget(transitions[0] ?? "");
  }

  const isMovement = target === "released" || target === "returned";

  if (transitions.length === 0) {
    return (
      <Alert tone="info">
        An archived item stays archived. It is still readable, and its custody
        record is complete.
      </Alert>
    );
  }

  return (
    <ActionForm
      action={setEvidenceStatus}
      submitLabel={
        <>
          <ArrowRight className="size-4" aria-hidden="true" />
          Move the item
        </>
      }
      submitSize="sm"
      hidden={{ caseRecordId, evidenceRecordId: item.id }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="New status"
            htmlFor="ev-status"
            required
            error={state.fieldErrors?.status}
          >
            <Select
              key={item.status}
              id="ev-status"
              name="status"
              defaultValue={transitions[0] ?? ""}
              onChange={(event) => setTarget(event.target.value)}
            >
              {transitions.map((status) => (
                <option key={status} value={status}>
                  {status.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={isMovement ? "Who takes it" : "Who holds it"}
            htmlFor="ev-status-custodian"
            required={isMovement}
            hint={
              isMovement
                ? "Required. A movement has two ends, and this is the receiving one."
                : undefined
            }
            error={state.fieldErrors?.custodian}
          >
            <Select
              id="ev-status-custodian"
              name="custodian"
              defaultValue={item.currentCustodian ?? ""}
            >
              <option value="">Unchanged</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          {isMovement && (
            <>
              <div className="sm:col-span-2">
                <Field
                  label="What for"
                  htmlFor="ev-status-purpose"
                  required
                  hint="Goes into the custody ledger, which is append-only."
                  error={state.fieldErrors?.purpose}
                >
                  <Input
                    id="ev-status-purpose"
                    name="purpose"
                    placeholder="Forensic imaging at the laboratory"
                  />
                </Field>
              </div>

              <Field
                label="Where"
                htmlFor="ev-status-location"
                error={state.fieldErrors?.location}
              >
                <Input id="ev-status-location" name="location" />
              </Field>

              <Field
                label="Condition"
                htmlFor="ev-status-condition"
                error={state.fieldErrors?.condition}
              >
                <Input
                  id="ev-status-condition"
                  name="condition"
                  placeholder="Sealed, seal intact"
                />
              </Field>
            </>
          )}
        </div>
      )}
    </ActionForm>
  );
}

/** Recording a custody event, or correcting one. */
export function CustodyForm({
  caseRecordId,
  item,
  people,
  correcting,
}: {
  caseRecordId: string;
  item: EvidenceItem;
  people: Person[];
  correcting?: CustodyEvent;
}) {
  const [eventType, setEventType] = useState<string>(
    correcting?.eventType ?? "examined",
  );
  const isMovement = CUSTODY_MOVEMENTS.includes(eventType as never);

  return (
    <ActionForm
      action={correcting ? correctCustodyEvent : recordCustodyEvent}
      submitLabel={correcting ? "Record the correction" : "Record the event"}
      submitSize="sm"
      hidden={
        correcting
          ? {
              caseRecordId,
              evidenceRecordId: item.id,
              correctsEventId: correcting.id,
            }
          : { caseRecordId, evidenceRecordId: item.id }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          {correcting && (
            <div className="sm:col-span-2">
              <Field
                label="What was wrong with the original entry"
                htmlFor="custody-correction-reason"
                required
                error={state.fieldErrors?.correctionReason}
              >
                <Input
                  id="custody-correction-reason"
                  name="correctionReason"
                  placeholder="The receiving officer was recorded wrongly"
                />
              </Field>
            </div>
          )}

          <Field
            label="What happened"
            htmlFor="custody-type"
            required
            error={state.fieldErrors?.eventType}
          >
            <Select
              id="custody-type"
              name="eventType"
              defaultValue={correcting?.eventType ?? "examined"}
              onChange={(event) => setEventType(event.target.value)}
            >
              {CUSTODY_EVENT_TYPES.filter((type) => type !== "correction").map(
                (type) => (
                  <option key={type} value={type}>
                    {CUSTODY_EVENT_LABELS[type]}
                  </option>
                ),
              )}
            </Select>
          </Field>

          <Field
            label="When"
            htmlFor="custody-occurred"
            hint="Leave empty for now."
            error={state.fieldErrors?.occurredAt}
          >
            <Input
              id="custody-occurred"
              name="occurredAt"
              type="datetime-local"
              defaultValue={correcting ? correcting.occurredAt.slice(0, 16) : ""}
            />
          </Field>

          <Field
            label="Released by"
            htmlFor="custody-released"
            required={isMovement}
            hint={isMovement ? "Required: a movement has two ends." : undefined}
            error={state.fieldErrors?.releasedBy}
          >
            <Select
              id="custody-released"
              name="releasedBy"
              defaultValue={correcting?.releasedBy ?? item.currentCustodian ?? ""}
            >
              <option value="">Nobody</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Received by"
            htmlFor="custody-received"
            required={isMovement}
            error={state.fieldErrors?.receivedBy}
          >
            <Select
              id="custody-received"
              name="receivedBy"
              defaultValue={correcting?.receivedBy ?? ""}
            >
              <option value="">Nobody</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="What for"
              htmlFor="custody-purpose"
              required
              error={state.fieldErrors?.purpose}
            >
              <Input
                id="custody-purpose"
                name="purpose"
                defaultValue={correcting?.purpose ?? ""}
                placeholder="Examined for alterations under magnification"
              />
            </Field>
          </div>

          <Field
            label="Where"
            htmlFor="custody-location"
            error={state.fieldErrors?.location}
          >
            <Input
              id="custody-location"
              name="location"
              defaultValue={correcting?.location ?? ""}
            />
          </Field>

          <Field
            label="Condition"
            htmlFor="custody-condition"
            error={state.fieldErrors?.condition}
          >
            <Input
              id="custody-condition"
              name="condition"
              defaultValue={correcting?.condition ?? ""}
              placeholder="Sealed, seal intact"
            />
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Confirmation"
              htmlFor="custody-confirmation"
              hint="What the receiving person confirmed, in their words."
              error={state.fieldErrors?.confirmation}
            >
              <Input
                id="custody-confirmation"
                name="confirmation"
                defaultValue={correcting?.confirmation ?? ""}
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/** Removal and restoration, which only the Administrator can reach (PRD 16). */
export function EvidenceRemovalPanel({
  caseRecordId,
  item,
  canRemove,
}: {
  caseRecordId: string;
  item: EvidenceItem;
  canRemove: boolean;
}) {
  if (item.deletedAt !== null) {
    return (
      <Card title="Evidence status">
        <Alert tone="warn" title="Item removed">
          Removed on {new Date(item.deletedAt).toLocaleString("en-GB")} and now in
          the recycle bin. Its custody ledger and audit entries are exactly as
          they were: removing the record does not remove the history.
          {canRemove && (
            <div className="mt-3">
              <ActionForm
                action={restoreEvidence}
                submitLabel="Restore"
                submitSize="sm"
                hidden={{
                  caseRecordId,
                  evidenceRecordId: item.id,
                  reason: "restored from the recycle bin",
                }}
                confirm={`Restore ${item.evidenceId}?`}
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
    <Card
      title="Remove this item"
      description="PRD 16 gives this to the Administrator alone, as a recoverable soft delete with a reason, and never while the item is out on release."
    >
      <ActionForm
        action={removeEvidence}
        submitLabel={
          <>
            <Trash2 className="size-4" aria-hidden="true" />
            Remove this item
          </>
        }
        submitTone="danger"
        submitSize="sm"
        hidden={{ caseRecordId, evidenceRecordId: item.id }}
        confirm={`Remove ${item.evidenceId}? It stays in the recycle bin, and its custody ledger is untouched.`}
      >
        {(state) => (
          <Field
            label="Reason for removal"
            htmlFor="ev-remove-reason"
            required
            hint="At least 10 characters. It goes into the audit trail and may be read years later."
            error={state.fieldErrors?.reason}
          >
            <Input
              id="ev-remove-reason"
              name="reason"
              placeholder="Registered against the wrong case in error"
            />
          </Field>
        )}
      </ActionForm>
    </Card>
  );
}

/** The case file's evidence tab. */
export function CaseEvidencePanel({
  caseRecordId,
  caseClassification,
  items,
  summary,
  people,
  levels,
  actorId,
  canCreate,
}: {
  caseRecordId: string;
  caseClassification: string;
  items: EvidenceItem[];
  summary: {
    total: number;
    originals: number;
    workingCopies: number;
    awaitingVerification: number;
    mismatched: number;
    released: number;
  };
  people: Person[];
  levels: Level[];
  actorId: string;
  canCreate: boolean;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <Card
      title="Evidence"
      description="What has been collected, who holds it, and whether its file still matches what was collected."
      actions={
        canCreate && !adding ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Register an item
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {summary.mismatched > 0 && (
          <Alert tone="danger" title="An item failed its integrity check">
            <span className="inline-flex items-center gap-1.5">
              <ShieldAlert className="size-3.5" aria-hidden="true" />
              {summary.mismatched}{" "}
              {summary.mismatched === 1 ? "item's file does" : "items' files do"} not
              match the hash recorded when it was collected. It cannot be cited
              until that is resolved.
            </span>
          </Alert>
        )}

        {adding && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Register an item</p>
              <Button size="sm" tone="ghost" onClick={() => setAdding(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <EvidenceForm
              caseRecordId={caseRecordId}
              people={people}
              levels={levels}
              defaultClassification={caseClassification}
              actorId={actorId}
            />
          </div>
        )}

        <EvidenceSummaryTiles summary={summary} />
        <EvidenceList items={items} />
      </div>
    </Card>
  );
}

/* These two are split out only so the panel above reads as one screen. */

function EvidenceSummaryTiles({
  summary,
}: {
  summary: {
    total: number;
    originals: number;
    workingCopies: number;
    awaitingVerification: number;
    mismatched: number;
    released: number;
  };
}) {
  const tiles = [
    { label: "Items", value: summary.total, tone: "neutral" as const },
    { label: "Originals", value: summary.originals, tone: "neutral" as const },
    {
      label: "Working copies",
      value: summary.workingCopies,
      tone: "neutral" as const,
    },
    {
      label: "Awaiting verification",
      value: summary.awaitingVerification,
      tone: summary.awaitingVerification > 0 ? ("warn" as const) : ("ok" as const),
    },
    {
      label: "Mismatched",
      value: summary.mismatched,
      tone: summary.mismatched > 0 ? ("danger" as const) : ("ok" as const),
    },
    {
      label: "Out on release",
      value: summary.released,
      tone: summary.released > 0 ? ("warn" as const) : ("neutral" as const),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((tile) => (
        <div key={tile.label} className="card rounded-xl p-3.5">
          <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
            {tile.label}
          </p>
          <p
            className={`mt-1 text-2xl font-semibold tabular-nums ${
              tile.tone === "danger"
                ? "text-danger"
                : tile.tone === "warn"
                  ? "text-warn"
                  : tile.tone === "ok"
                    ? "text-ok"
                    : "text-body"
            }`}
          >
            {tile.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function EvidenceList({ items }: { items: EvidenceItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-xs text-muted">
        Nothing registered yet. Evidence is registered as it is collected, with
        who collected it, when, where and how.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id} className="rounded-lg border border-line p-3">
          <a
            href={`/evidence/${item.id}`}
            className="text-xs font-medium text-body hover:text-signal-dark hover:underline"
          >
            {item.evidenceId}: {item.description.slice(0, 120)}
            {item.description.length > 120 ? "..." : ""}
          </a>
          <p className="mt-1 text-[11px] text-muted">
            {item.currentCustodianName
              ? `Held by ${item.currentCustodianName}`
              : "Nobody holds it"}
            , {item.custodyEventCount}{" "}
            {item.custodyEventCount === 1 ? "custody entry" : "custody entries"}
          </p>
        </li>
      ))}
    </ul>
  );
}

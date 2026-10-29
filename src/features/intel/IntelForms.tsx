"use client";

import { useState } from "react";
import { Eye, Gavel, Link2, Merge, Plus, Send, Trash2, X } from "lucide-react";
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
  ALIAS_TYPES,
  ALIAS_TYPE_LABELS,
  CONFIDENCE_LABELS,
  CONFIDENCE_LEVELS,
  ENTITY_TYPES,
  ENTITY_TYPE_LABELS,
  INFORMATION_CREDIBILITIES,
  INFORMATION_CREDIBILITY_LABELS,
  INFORMATION_VERIFICATION_LABELS,
  INFORMATION_VERIFICATION_STATUSES,
  RELATIONSHIP_TYPES,
  RELATIONSHIP_TYPE_LABELS,
  SOURCE_RELIABILITIES,
  SOURCE_RELIABILITY_LABELS,
  SOURCE_TYPES,
  SOURCE_TYPE_LABELS,
  SUBJECT_ROLES,
  SUBJECT_ROLE_LABELS,
  VERIFICATION_STATUSES,
  VERIFICATION_STATUS_LABELS,
  allowedFindingTransitions,
  type ConfidenceLevel,
  type Entity,
  type Finding,
  type Information,
  type MatchFlag,
  type Relationship,
  type Source,
} from "@/modules/intel/shared";
import { FINDING_STATUS_LABELS } from "@/modules/intel/shared";
import {
  addAlias,
  addCorroboration,
  addSubject,
  createEntity,
  createFinding,
  createInformation,
  createRelationship,
  createSource,
  decideMatch,
  flagMatch,
  linkFinding,
  linkInformationEvidence,
  mergeEntities,
  removeAlias,
  removeEntity,
  removeFinding,
  removeInformation,
  removeRelationship,
  removeSource,
  removeSubject,
  restoreEntity,
  revealIdReference,
  reverseMerge,
  setFindingStatus,
  updateEntity,
  updateFinding,
  updateInformation,
  updateRelationship,
  updateSource,
} from "./actions";

/** The forms that write to the intelligence register (PRD 6.4, 8.4, 15). */

type Person = { id: string; name: string };
type Level = { code: string; name: string };
type Option = { id: string; label: string };

const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------- entities */

export function EntityForm({
  entity,
  levels,
  defaultClassification,
  caseRecordId,
}: {
  entity?: Entity;
  levels: Level[];
  defaultClassification: string;
  /** Present when the subject is being registered from a case file. */
  caseRecordId?: string;
}) {
  const editing = entity !== undefined;
  const [entityType, setEntityType] = useState(entity?.entityType ?? "person");

  return (
    <ActionForm
      action={editing ? updateEntity : createEntity}
      submitLabel={editing ? "Save" : "Register the subject"}
      submitSize="sm"
      hidden={
        editing
          ? { entityRecordId: entity.id, expectedVersion: entity.version }
          : caseRecordId
            ? { caseRecordId }
            : {}
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="What it is"
            htmlFor="ent-type"
            required
            error={state.fieldErrors?.entityType}
          >
            <Select
              id="ent-type"
              name="entityType"
              value={entityType}
              onChange={(event) =>
                setEntityType(event.target.value as typeof entityType)
              }
            >
              {ENTITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ENTITY_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Name"
            htmlFor="ent-name"
            required
            hint="As it appears on the record you took it from. Other spellings go in as aliases."
            error={state.fieldErrors?.name}
          >
            <Input
              id="ent-name"
              name="name"
              defaultValue={entity?.name ?? ""}
              placeholder="ABC Holdings Ltd"
            />
          </Field>

          {entityType === "person" ? (
            <Field
              label="Date of birth"
              htmlFor="ent-dob"
              error={state.fieldErrors?.dateOfBirth}
            >
              <Input
                id="ent-dob"
                name="dateOfBirth"
                type="date"
                defaultValue={entity?.dateOfBirth?.slice(0, 10) ?? ""}
              />
            </Field>
          ) : (
            <Field
              label="Incorporated on"
              htmlFor="ent-inc"
              error={state.fieldErrors?.incorporatedOn}
            >
              <Input
                id="ent-inc"
                name="incorporatedOn"
                type="date"
                defaultValue={entity?.incorporatedOn?.slice(0, 10) ?? ""}
              />
            </Field>
          )}

          <Field
            label="Registration number"
            htmlFor="ent-reg"
            error={state.fieldErrors?.registrationNo}
          >
            <Input
              id="ent-reg"
              name="registrationNo"
              defaultValue={entity?.registrationNo ?? ""}
              placeholder="CS123456789"
            />
          </Field>

          <Field
            label="Identity reference"
            htmlFor="ent-idref"
            hint="A passport or national identity number. Encrypted, and every reading of it is recorded."
            error={state.fieldErrors?.idReference}
          >
            <Input
              id="ent-idref"
              name="idReference"
              placeholder={
                entity?.idReferenceHint
                  ? `ending ${entity.idReferenceHint}, leave empty to keep`
                  : "G1234567"
              }
            />
          </Field>

          <Field
            label="Classification"
            htmlFor="ent-classification"
            required
            hint="Decides who can open this record at all."
            error={state.fieldErrors?.classification}
          >
            <Select
              id="ent-classification"
              name="classification"
              defaultValue={entity?.classification ?? defaultClassification}
            >
              {levels.map((level) => (
                <option key={level.code} value={level.code}>
                  {level.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Address"
              htmlFor="ent-address"
              error={state.fieldErrors?.address}
            >
              <Input
                id="ent-address"
                name="address"
                defaultValue={entity?.address ?? ""}
                placeholder="12 Independence Avenue, Accra"
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field
              label="Notes"
              htmlFor="ent-notes"
              error={state.fieldErrors?.notes}
            >
              <Textarea
                id="ent-notes"
                name="notes"
                rows={2}
                defaultValue={entity?.notes ?? ""}
              />
            </Field>
          </div>

          {!editing && caseRecordId && (
            <>
              <Field
                label="Part in this case"
                htmlFor="ent-role"
                required
                error={state.fieldErrors?.subjectRole}
              >
                <Select
                  id="ent-role"
                  name="subjectRole"
                  defaultValue="person_of_interest"
                >
                  {SUBJECT_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {SUBJECT_ROLE_LABELS[role]}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="How they relate to the case"
                htmlFor="ent-relation"
                error={state.fieldErrors?.relationshipToCase}
              >
                <Input
                  id="ent-relation"
                  name="relationshipToCase"
                  placeholder="Approved the three invoices under investigation"
                />
              </Field>
            </>
          )}
        </div>
      )}
    </ActionForm>
  );
}

export function AliasForm({ entity }: { entity: Entity }) {
  return (
    <ActionForm
      action={addAlias}
      submitLabel="Record the alias"
      submitSize="sm"
      hidden={{ entityRecordId: entity.id }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="The other name"
            htmlFor="alias-name"
            required
            error={state.fieldErrors?.alias}
          >
            <Input
              id="alias-name"
              name="alias"
              placeholder="ABC Holdings Ghana"
            />
          </Field>

          <Field
            label="What kind"
            htmlFor="alias-type"
            required
            error={state.fieldErrors?.aliasType}
          >
            <Select
              id="alias-type"
              name="aliasType"
              defaultValue="also_known_as"
            >
              {ALIAS_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ALIAS_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Where it was seen"
              htmlFor="alias-note"
              hint="Which record used this name, so a reader can check."
              error={state.fieldErrors?.sourceNote}
            >
              <Input
                id="alias-note"
                name="sourceNote"
                placeholder="The 2024 annual return"
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

export function AliasRemovalForm({
  entity,
  aliasId,
  alias,
}: {
  entity: Entity;
  aliasId: string;
  alias: string;
}) {
  return (
    <ActionForm
      action={removeAlias}
      submitLabel="Remove"
      submitTone="ghost"
      submitSize="sm"
      hidden={{ entityRecordId: entity.id, aliasId }}
      confirm={`Remove the alias "${alias}"?`}
      compact
    />
  );
}

/**
 * Revealing the identity reference (PRD 15).
 *
 * A button rather than a value on the page: the number is on screen only
 * because somebody asked for it, and reading it is written to the audit
 * trail by the database function that decrypts it.
 */
export function RevealIdReferenceForm({ entity }: { entity: Entity }) {
  if (!entity.hasIdReference) {
    return <Muted>No identity reference is held.</Muted>;
  }

  return (
    <ActionForm
      action={revealIdReference}
      submitLabel={
        <>
          <Eye className="size-3.5" aria-hidden="true" />
          Show it
        </>
      }
      submitTone="ghost"
      submitSize="sm"
      hidden={{ entityRecordId: entity.id }}
      confirm="Reading this is recorded in the audit trail. Continue?"
      compact
    />
  );
}

/* --------------------------------------------------------- case subjects */

export function AddSubjectForm({
  caseRecordId,
  candidates,
}: {
  caseRecordId: string;
  candidates: Option[];
}) {
  if (candidates.length === 0) {
    return (
      <Muted>
        Every subject in the register is already on this case. Register a new
        one instead.
      </Muted>
    );
  }

  return (
    <ActionForm
      action={addSubject}
      submitLabel="Add to the case"
      submitSize="sm"
      hidden={{ caseRecordId }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="From the register"
            htmlFor="subject-entity"
            required
            hint="The same company appearing on two cases is exactly what the register is for."
            error={state.fieldErrors?.entityRecordId}
          >
            <Select id="subject-entity" name="entityRecordId">
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Part in this case"
            htmlFor="subject-role"
            required
            error={state.fieldErrors?.subjectRole}
          >
            <Select
              id="subject-role"
              name="subjectRole"
              defaultValue="person_of_interest"
            >
              {SUBJECT_ROLES.map((role) => (
                <option key={role} value={role}>
                  {SUBJECT_ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="How they relate to the case"
              htmlFor="subject-relation"
              error={state.fieldErrors?.relationshipToCase}
            >
              <Input
                id="subject-relation"
                name="relationshipToCase"
                placeholder="Named in the client's instruction"
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

export function RemoveSubjectForm({
  caseRecordId,
  subjectId,
  name,
}: {
  caseRecordId: string;
  subjectId: string;
  name: string;
}) {
  return (
    <ActionForm
      action={removeSubject}
      submitLabel="Take off the case"
      submitTone="ghost"
      submitSize="sm"
      hidden={{ caseRecordId, subjectId }}
      confirm={`Take ${name} off this case? They stay on the record with the reason.`}
    >
      {(state) => (
        <Field
          label="Why"
          htmlFor={`subject-remove-${subjectId}`}
          required
          hint="Ruling somebody out is part of what the investigation did."
          error={state.fieldErrors?.reason}
        >
          <Input
            id={`subject-remove-${subjectId}`}
            name="reason"
            placeholder="A different person of the same name"
          />
        </Field>
      )}
    </ActionForm>
  );
}

/* --------------------------------------------------------- relationships */

export function RelationshipForm({
  entity,
  relationship,
  candidates,
  sources,
  evidenceItems,
}: {
  entity: Entity;
  relationship?: Relationship;
  candidates: Option[];
  sources: Option[];
  evidenceItems: Option[];
}) {
  const editing = relationship !== undefined;
  const [relationshipType, setRelationshipType] = useState(
    relationship?.relationshipType ?? "director_of",
  );
  const isHolding =
    relationshipType === "shareholder_of" ||
    relationshipType === "beneficial_owner_of" ||
    relationshipType === "owns";

  if (!editing && candidates.length === 0) {
    return (
      <Muted>
        Nothing else is in the register to relate this to yet. Register the
        other party first.
      </Muted>
    );
  }

  return (
    <ActionForm
      action={editing ? updateRelationship : createRelationship}
      submitLabel={editing ? "Save" : "Record the relationship"}
      submitSize="sm"
      hidden={
        editing
          ? {
              entityRecordId: entity.id,
              relationshipId: relationship.id,
              expectedVersion: relationship.version,
            }
          : { fromEntityId: entity.id }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="This subject is"
            htmlFor="rel-type"
            required
            error={state.fieldErrors?.relationshipType}
          >
            <Select
              id="rel-type"
              name="relationshipType"
              value={relationshipType}
              onChange={(event) =>
                setRelationshipType(
                  event.target.value as typeof relationshipType,
                )
              }
            >
              {RELATIONSHIP_TYPES.map((type) => (
                <option key={type} value={type}>
                  {RELATIONSHIP_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>

          {!editing && (
            <Field
              label="This other subject"
              htmlFor="rel-to"
              required
              error={state.fieldErrors?.toEntityId}
            >
              <Select id="rel-to" name="toEntityId">
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {isHolding && (
            <Field
              label="Percentage"
              htmlFor="rel-percentage"
              hint="Leave empty if the size of the holding is not known. That is different from zero."
              error={state.fieldErrors?.percentage}
            >
              <Input
                id="rel-percentage"
                name="percentage"
                type="number"
                step="0.01"
                min="0"
                max="100"
                defaultValue={relationship?.percentage ?? ""}
              />
            </Field>
          )}

          <Field
            label="From"
            htmlFor="rel-from-date"
            error={state.fieldErrors?.heldFrom}
          >
            <Input
              id="rel-from-date"
              name="heldFrom"
              type="date"
              defaultValue={relationship?.heldFrom?.slice(0, 10) ?? ""}
            />
          </Field>

          <Field
            label="To"
            htmlFor="rel-to-date"
            error={state.fieldErrors?.heldTo}
          >
            <Input
              id="rel-to-date"
              name="heldTo"
              type="date"
              defaultValue={relationship?.heldTo?.slice(0, 10) ?? ""}
            />
          </Field>

          <Field
            label="The source for this"
            htmlFor="rel-source"
            hint="A relationship nobody can trace is a rumour, so high confidence needs one of these."
            error={state.fieldErrors?.sourceId}
          >
            <Select
              id="rel-source"
              name="sourceId"
              defaultValue={relationship?.sourceId ?? ""}
            >
              <option value="">Not cited</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Or the evidence"
            htmlFor="rel-evidence"
            error={state.fieldErrors?.evidenceItemId}
          >
            <Select
              id="rel-evidence"
              name="evidenceItemId"
              defaultValue={relationship?.evidenceItemId ?? ""}
            >
              <option value="">Not cited</option>
              {evidenceItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Confidence"
            htmlFor="rel-confidence"
            required
            error={state.fieldErrors?.confidence}
          >
            <Select
              id="rel-confidence"
              name="confidence"
              defaultValue={relationship?.confidence ?? "moderate"}
            >
              {CONFIDENCE_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {CONFIDENCE_LABELS[level]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Detail"
              htmlFor="rel-description"
              error={state.fieldErrors?.description}
            >
              <Input
                id="rel-description"
                name="description"
                defaultValue={relationship?.description ?? ""}
                placeholder="Appointed at the 2024 annual general meeting"
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

export function RemoveRelationshipForm({
  entity,
  relationship,
}: {
  entity: Entity;
  relationship: Relationship;
}) {
  return (
    <ActionForm
      action={removeRelationship}
      submitLabel="Remove"
      submitTone="ghost"
      submitSize="sm"
      hidden={{ entityRecordId: entity.id, relationshipId: relationship.id }}
      confirm="Remove this relationship? It stays in the audit trail."
    >
      {(state) => (
        <Field
          label="Why"
          htmlFor={`rel-remove-${relationship.id}`}
          required
          error={state.fieldErrors?.reason}
        >
          <Input
            id={`rel-remove-${relationship.id}`}
            name="reason"
            placeholder="Recorded against the wrong company"
          />
        </Field>
      )}
    </ActionForm>
  );
}

/* ------------------------------------------- entity resolution (PRD 8.4) */

export function FlagMatchForm({
  entity,
  candidates,
}: {
  entity: Entity;
  candidates: Option[];
}) {
  if (candidates.length === 0) {
    return <Muted>Nothing else in the register looks like this record.</Muted>;
  }

  return (
    <ActionForm
      action={flagMatch}
      submitLabel="Flag for a decision"
      submitSize="sm"
      hidden={{ entityRecordId: entity.id }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Against"
            htmlFor="flag-other"
            required
            error={state.fieldErrors?.otherEntityId}
          >
            <Select id="flag-other" name="otherEntityId">
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="What kind"
            htmlFor="flag-type"
            required
            hint="A duplicate is the same thing recorded twice. A match is two records that may be the same thing."
            error={state.fieldErrors?.flagType}
          >
            <Select
              id="flag-type"
              name="flagType"
              defaultValue="potential_duplicate"
            >
              <option value="potential_duplicate">Potential duplicate</option>
              <option value="potential_match">Potential match</option>
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Notes"
              htmlFor="flag-notes"
              error={state.fieldErrors?.notes}
            >
              <Input
                id="flag-notes"
                name="notes"
                placeholder="Same registered address and the same two directors"
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/**
 * Deciding a flag, and then merging (PRD 8.4).
 *
 * Two steps on purpose. Deciding records the reasoning; merging acts on it.
 * A single button would leave the merge log saying only that somebody pressed
 * a button.
 */
export function MatchDecisionForm({
  entity,
  flag,
  canMerge,
}: {
  entity: Entity;
  flag: MatchFlag;
  canMerge: boolean;
}) {
  const other =
    flag.entityAId === entity.id
      ? {
          id: flag.entityBId,
          name: flag.entityBName,
          reference: flag.entityBReference,
        }
      : {
          id: flag.entityAId,
          name: flag.entityAName,
          reference: flag.entityAReference,
        };

  if (flag.status === "open") {
    return (
      <div className="mt-2 border-t border-line pt-2">
        <ActionForm
          action={decideMatch}
          submitLabel={
            <>
              <Gavel className="size-3.5" aria-hidden="true" />
              Record the decision
            </>
          }
          submitSize="sm"
          hidden={{ entityRecordId: entity.id, flagId: flag.id }}
        >
          {(state) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Decision"
                htmlFor={`match-decision-${flag.id}`}
                required
                error={state.fieldErrors?.status}
              >
                <Select
                  id={`match-decision-${flag.id}`}
                  name="status"
                  defaultValue="same_entity"
                >
                  <option value="same_entity">The same thing</option>
                  <option value="different_entities">Different things</option>
                  <option value="undecided">Cannot be decided yet</option>
                </Select>
              </Field>

              <Field
                label="Why"
                htmlFor={`match-reason-${flag.id}`}
                required
                hint="At least ten characters. Somebody reading this in two years has only what you write."
                error={state.fieldErrors?.reason}
              >
                <Input
                  id={`match-reason-${flag.id}`}
                  name="reason"
                  placeholder="Same registration number and the same registered address"
                />
              </Field>
            </div>
          )}
        </ActionForm>
      </div>
    );
  }

  if (flag.status !== "same_entity") return null;

  if (!canMerge) {
    return (
      <p className="mt-2 border-t border-line pt-2 text-[11px] text-muted">
        Decided as the same thing. Merging them needs the separate authority PRD
        8.4 asks for, which you do not hold.
      </p>
    );
  }

  return (
    <div className="mt-2 border-t border-line pt-2">
      <Alert tone="info">
        Decided as the same thing. Merging keeps {entity.entityId} and moves
        everything from {other.reference} onto it. Nothing is deleted, and this
        can be reversed.
      </Alert>
      <div className="mt-2">
        <ActionForm
          action={mergeEntities}
          submitLabel={
            <>
              <Merge className="size-3.5" aria-hidden="true" />
              Merge {other.reference} into this record
            </>
          }
          submitSize="sm"
          hidden={{ survivingEntityId: entity.id, mergedEntityId: other.id }}
          confirm={`Merge ${other.reference} into ${entity.entityId}? Reversible, and nothing is deleted.`}
        >
          {(state) => (
            <Field
              label="Why these are one thing"
              htmlFor={`merge-reason-${flag.id}`}
              required
              error={state.fieldErrors?.reason}
            >
              <Input
                id={`merge-reason-${flag.id}`}
                name="reason"
                placeholder="One company recorded twice, under its trading name"
              />
            </Field>
          )}
        </ActionForm>
      </div>
    </div>
  );
}

export function ReverseMergeForm({
  entity,
  mergeId,
  mergedReference,
}: {
  entity: Entity;
  mergeId: string;
  mergedReference: string;
}) {
  return (
    <ActionForm
      action={reverseMerge}
      submitLabel="Reverse this merge"
      submitTone="ghost"
      submitSize="sm"
      hidden={{ entityRecordId: entity.id, mergeId }}
      confirm={`Reverse the merge of ${mergedReference}? It stands on its own again, marked disputed.`}
    >
      {(state) => (
        <Field
          label="Why"
          htmlFor={`reverse-${mergeId}`}
          required
          hint="At least ten characters, because this undoes a decision somebody made."
          error={state.fieldErrors?.reason}
        >
          <Input
            id={`reverse-${mergeId}`}
            name="reason"
            placeholder="The registration numbers differ; they are two companies"
          />
        </Field>
      )}
    </ActionForm>
  );
}

export function EntityRemovalPanel({
  entity,
  canRemove,
}: {
  entity: Entity;
  canRemove: boolean;
}) {
  if (entity.deletedAt !== null) {
    return (
      <Card title="Record status">
        <Alert tone="warn" title="Record removed">
          Removed on {new Date(entity.deletedAt).toLocaleString("en-GB")} and
          now in the recycle bin. Nothing it was linked to was touched.
          {canRemove && (
            <div className="mt-3">
              <ActionForm
                action={restoreEntity}
                submitLabel="Restore"
                submitSize="sm"
                hidden={{
                  entityRecordId: entity.id,
                  reason: "restored from the recycle bin",
                }}
                confirm={`Restore ${entity.entityId}?`}
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
      title="Remove this record"
      description="Only possible once it is on no case. A subject who was looked at and ruled out belongs on the case record, not in the bin."
    >
      <ActionForm
        action={removeEntity}
        submitLabel={
          <>
            <Trash2 className="size-4" aria-hidden="true" />
            Remove this record
          </>
        }
        submitTone="danger"
        submitSize="sm"
        hidden={{ entityRecordId: entity.id }}
        confirm={`Remove ${entity.entityId}? It stays in the recycle bin.`}
      >
        {(state) => (
          <Field
            label="Reason for removal"
            htmlFor="ent-remove-reason"
            required
            error={state.fieldErrors?.reason}
          >
            <Input
              id="ent-remove-reason"
              name="reason"
              placeholder="Created in error by a duplicate submission"
            />
          </Field>
        )}
      </ActionForm>
    </Card>
  );
}

/* -------------------------------------------------------------- sources */

export function SourceForm({
  caseRecordId,
  source,
  people,
  levels,
  defaultClassification,
  actorId,
}: {
  caseRecordId: string;
  source?: Source;
  people: Person[];
  levels: Level[];
  defaultClassification: string;
  actorId: string;
}) {
  const editing = source !== undefined;
  const [sourceType, setSourceType] = useState(
    source?.sourceType ?? "public_registry",
  );
  const human = sourceType === "human_source";

  return (
    <ActionForm
      action={editing ? updateSource : createSource}
      submitLabel={editing ? "Save" : "Record the source"}
      submitSize="sm"
      hidden={
        editing
          ? {
              caseRecordId,
              sourceRecordId: source.id,
              expectedVersion: source.version,
            }
          : { caseRecordId }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="What kind of source"
            htmlFor="src-type"
            required
            error={state.fieldErrors?.sourceType}
          >
            <Select
              id="src-type"
              name="sourceType"
              value={sourceType}
              onChange={(event) =>
                setSourceType(event.target.value as typeof sourceType)
              }
            >
              {SOURCE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SOURCE_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="How reliable the source is"
            htmlFor="src-reliability"
            required
            hint="About the source in general, not about any one thing it said."
            error={state.fieldErrors?.sourceReliability}
          >
            <Select
              id="src-reliability"
              name="sourceReliability"
              defaultValue={source?.sourceReliability ?? "unknown"}
            >
              {SOURCE_RELIABILITIES.map((level) => (
                <option key={level} value={level}>
                  {SOURCE_RELIABILITY_LABELS[level]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="What it is"
              htmlFor="src-description"
              required
              hint="A particular acquisition, so a reader can go back to it: which search, on what day, by whom."
              error={state.fieldErrors?.description}
            >
              <Textarea
                id="src-description"
                name="description"
                rows={2}
                defaultValue={source?.description ?? ""}
                placeholder="Companies registry search for ABC Holdings Ltd, including directors and filings since 2020."
              />
            </Field>
          </div>

          {!editing && (
            <>
              <Field
                label="When it was obtained"
                htmlFor="src-date"
                required
                error={state.fieldErrors?.dateObtained}
              >
                <Input
                  id="src-date"
                  name="dateObtained"
                  type="date"
                  defaultValue={today()}
                />
              </Field>

              <Field
                label="Who obtained it"
                htmlFor="src-obtained-by"
                required
                error={state.fieldErrors?.obtainedBy}
              >
                <Select
                  id="src-obtained-by"
                  name="obtainedBy"
                  defaultValue={actorId}
                >
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}

          {editing && (
            <Field
              label="Verification"
              htmlFor="src-verification"
              required
              error={state.fieldErrors?.verificationStatus}
            >
              <Select
                id="src-verification"
                name="verificationStatus"
                defaultValue={source.verificationStatus}
              >
                {VERIFICATION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {VERIFICATION_STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label="Classification"
            htmlFor="src-classification"
            required
            hint={
              human
                ? "A human source is made strictly restricted whatever is chosen here."
                : "Decides who can open this source at all."
            }
            error={state.fieldErrors?.classification}
          >
            <Select
              id="src-classification"
              name="classification"
              defaultValue={source?.classification ?? defaultClassification}
            >
              {levels.map((level) => (
                <option key={level.code} value={level.code}>
                  {level.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Access restrictions"
              htmlFor="src-access"
              error={state.fieldErrors?.accessRestrictions}
            >
              <Input
                id="src-access"
                name="accessRestrictions"
                defaultValue={source?.accessRestrictions ?? ""}
                placeholder="Named-user access only; do not cite verbatim"
              />
            </Field>
          </div>

          {human && (
            <div className="space-y-3 rounded-lg border border-warn/40 bg-warn/5 p-3 sm:col-span-2">
              <p className="text-[11px] text-body">
                A human source is recorded strictly restricted with its identity
                need-to-know (PRD 6.4). What the source said stays readable to
                the case team; who they are does not.
              </p>

              {source?.identityWithheld ? (
                <Alert tone="warn">
                  This source&apos;s identity is withheld from you, so it cannot
                  be changed here. That is the control working, not a fault.
                </Alert>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Who the source is"
                    htmlFor="src-identity-name"
                    error={state.fieldErrors?.identityName}
                  >
                    <Input
                      id="src-identity-name"
                      name="identityName"
                      defaultValue={source?.identityName ?? ""}
                    />
                  </Field>

                  <Field
                    label="How to reach them"
                    htmlFor="src-identity-contact"
                    error={state.fieldErrors?.identityContact}
                  >
                    <Input
                      id="src-identity-contact"
                      name="identityContact"
                      defaultValue={source?.identityContact ?? ""}
                    />
                  </Field>

                  <div className="sm:col-span-2">
                    <Field
                      label="Handling notes"
                      htmlFor="src-identity-notes"
                      error={state.fieldErrors?.identityNotes}
                    >
                      <Textarea
                        id="src-identity-notes"
                        name="identityNotes"
                        rows={2}
                        defaultValue={source?.identityNotes ?? ""}
                      />
                    </Field>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </ActionForm>
  );
}

export function RemoveSourceForm({
  caseRecordId,
  source,
}: {
  caseRecordId: string;
  source: Source;
}) {
  return (
    <ActionForm
      action={removeSource}
      submitLabel={
        <>
          <Trash2 className="size-4" aria-hidden="true" />
          Remove this source
        </>
      }
      submitTone="danger"
      submitSize="sm"
      hidden={{ caseRecordId, sourceRecordId: source.id }}
      confirm={`Remove ${source.sourceId}? It stays in the recycle bin.`}
    >
      {(state) => (
        <Field
          label="Reason for removal"
          htmlFor="src-remove-reason"
          required
          error={state.fieldErrors?.reason}
        >
          <Input
            id="src-remove-reason"
            name="reason"
            placeholder="Recorded against the wrong case"
          />
        </Field>
      )}
    </ActionForm>
  );
}

/* ---------------------------------------------------------- information */

export function InformationForm({
  caseRecordId,
  information,
  sources,
  subjects,
  levels,
  defaultClassification,
}: {
  caseRecordId: string;
  information?: Information;
  sources: Option[];
  subjects: Option[];
  levels: Level[];
  defaultClassification: string;
}) {
  const editing = information !== undefined;
  const corroborated =
    (information?.corroborationCount ?? 0) + (information?.evidenceCount ?? 0) >
    0;

  if (!editing && sources.length === 0) {
    return (
      <Muted>
        Record the source first. A piece of information is something a source
        said, so it cannot exist without one.
      </Muted>
    );
  }

  return (
    <ActionForm
      action={editing ? updateInformation : createInformation}
      submitLabel={editing ? "Save" : "Record the information"}
      submitSize="sm"
      hidden={
        editing
          ? {
              caseRecordId,
              informationRecordId: information.id,
              expectedVersion: information.version,
            }
          : { caseRecordId }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          {!editing && (
            <>
              <Field
                label="Which source said it"
                htmlFor="inf-source"
                required
                error={state.fieldErrors?.sourceRecordId}
              >
                <Select id="inf-source" name="sourceRecordId">
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="When it was obtained"
                htmlFor="inf-date"
                required
                error={state.fieldErrors?.dateObtained}
              >
                <Input
                  id="inf-date"
                  name="dateObtained"
                  type="date"
                  defaultValue={today()}
                />
              </Field>
            </>
          )}

          <div className="sm:col-span-2">
            <Field
              label="What the source said"
              htmlFor="inf-description"
              required
              hint="The statement itself, as close to how it was given as you can."
              error={state.fieldErrors?.description}
            >
              <Textarea
                id="inf-description"
                name="description"
                rows={3}
                defaultValue={information?.description ?? ""}
                placeholder="Three payments of GHS 45,000 were made to the same account in April."
              />
            </Field>
          </div>

          <Field
            label="How far it is borne out"
            htmlFor="inf-credibility"
            required
            hint={
              corroborated
                ? 'Something corroborates this, so "confirmed" is available.'
                : 'Nothing corroborates this yet, so "confirmed" will be refused until something does.'
            }
            error={state.fieldErrors?.informationCredibility}
          >
            <Select
              id="inf-credibility"
              name="informationCredibility"
              defaultValue={information?.informationCredibility ?? "unverified"}
            >
              {INFORMATION_CREDIBILITIES.filter(
                (level) => level !== "confirmed" || corroborated,
              ).map((level) => (
                <option key={level} value={level}>
                  {INFORMATION_CREDIBILITY_LABELS[level]}
                </option>
              ))}
            </Select>
          </Field>

          {editing && (
            <Field
              label="Verification"
              htmlFor="inf-verification"
              required
              error={state.fieldErrors?.verificationStatus}
            >
              <Select
                id="inf-verification"
                name="verificationStatus"
                defaultValue={information.verificationStatus}
              >
                {INFORMATION_VERIFICATION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {INFORMATION_VERIFICATION_LABELS[status]}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label="Your confidence in it"
            htmlFor="inf-confidence"
            required
            hint="Your judgement given everything else known, which is not the same as how borne out it is."
            error={state.fieldErrors?.confidence}
          >
            <Select
              id="inf-confidence"
              name="confidence"
              defaultValue={information?.confidence ?? "unverified"}
            >
              {CONFIDENCE_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {CONFIDENCE_LABELS[level]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Who it is about"
            htmlFor="inf-entity"
            error={state.fieldErrors?.entityRecordId}
          >
            <Select
              id="inf-entity"
              name="entityRecordId"
              defaultValue={information?.entityId ?? ""}
            >
              <option value="">Nobody in particular</option>
              {subjects.map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Classification"
            htmlFor="inf-classification"
            required
            error={state.fieldErrors?.classification}
          >
            <Select
              id="inf-classification"
              name="classification"
              defaultValue={
                information?.classification ?? defaultClassification
              }
            >
              {levels.map((level) => (
                <option key={level.code} value={level.code}>
                  {level.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function CorroborationForm({
  caseRecordId,
  information,
  candidates,
}: {
  caseRecordId: string;
  information: Information;
  candidates: Option[];
}) {
  if (candidates.length === 0) {
    return (
      <Muted>
        Nothing on this case from a different source could corroborate this yet.
        Two statements from the same source are one source saying something
        twice.
      </Muted>
    );
  }

  return (
    <ActionForm
      action={addCorroboration}
      submitLabel="Record the corroboration"
      submitSize="sm"
      hidden={{ caseRecordId, informationRecordId: information.id }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Borne out by"
            htmlFor="corr-other"
            required
            hint="Only material from a different source is offered here."
            error={state.fieldErrors?.corroboratingInformationId}
          >
            <Select id="corr-other" name="corroboratingInformationId">
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Note"
            htmlFor="corr-note"
            error={state.fieldErrors?.note}
          >
            <Input
              id="corr-note"
              name="note"
              placeholder="The filing bears out the registry search"
            />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function LinkEvidenceForm({
  caseRecordId,
  information,
  candidates,
}: {
  caseRecordId: string;
  information: Information;
  candidates: Option[];
}) {
  if (candidates.length === 0) {
    return (
      <Muted>
        Nothing in the case&apos;s evidence register is unlinked from this yet.
      </Muted>
    );
  }

  return (
    <ActionForm
      action={linkInformationEvidence}
      submitLabel={
        <>
          <Link2 className="size-3.5" aria-hidden="true" />
          Link the evidence
        </>
      }
      submitSize="sm"
      hidden={{ caseRecordId, informationRecordId: information.id }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="The exhibit"
            htmlFor="link-ev"
            required
            error={state.fieldErrors?.evidenceItemId}
          >
            <Select id="link-ev" name="evidenceItemId">
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Note"
            htmlFor="link-ev-note"
            error={state.fieldErrors?.note}
          >
            <Input
              id="link-ev-note"
              name="note"
              placeholder="Page 4 shows the three payments"
            />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function RemoveInformationForm({
  caseRecordId,
  information,
}: {
  caseRecordId: string;
  information: Information;
}) {
  return (
    <ActionForm
      action={removeInformation}
      submitLabel={
        <>
          <Trash2 className="size-4" aria-hidden="true" />
          Remove this
        </>
      }
      submitTone="danger"
      submitSize="sm"
      hidden={{ caseRecordId, informationRecordId: information.id }}
      confirm={`Remove ${information.informationId}? It stays in the recycle bin.`}
    >
      {(state) => (
        <Field
          label="Reason for removal"
          htmlFor="inf-remove-reason"
          required
          error={state.fieldErrors?.reason}
        >
          <Input
            id="inf-remove-reason"
            name="reason"
            placeholder="Recorded twice by mistake"
          />
        </Field>
      )}
    </ActionForm>
  );
}

/* ------------------------------------------------------------- findings */

export function FindingForm({
  caseRecordId,
  finding,
  people,
  levels,
  defaultClassification,
  actorId,
  ceiling,
}: {
  caseRecordId: string;
  finding?: Finding;
  people: Person[];
  levels: Level[];
  defaultClassification: string;
  actorId: string;
  /** The most the support will carry, so the form says so before anybody picks. */
  ceiling?: ConfidenceLevel;
}) {
  const editing = finding !== undefined;
  const rank: Record<ConfidenceLevel, number> = {
    unverified: 0,
    low: 1,
    moderate: 2,
    high: 3,
  };
  const offered = ceiling
    ? CONFIDENCE_LEVELS.filter((level) => rank[level] <= rank[ceiling])
    : CONFIDENCE_LEVELS;

  return (
    <ActionForm
      action={editing ? updateFinding : createFinding}
      submitLabel={editing ? "Save" : "Draft the finding"}
      submitSize="sm"
      hidden={
        editing
          ? {
              caseRecordId,
              findingRecordId: finding.id,
              expectedVersion: finding.version,
            }
          : { caseRecordId }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field
              label="The finding"
              htmlFor="fnd-statement"
              required
              hint="One conclusion, stated so a reader who knows nothing about the case can understand it."
              error={state.fieldErrors?.statement}
            >
              <Textarea
                id="fnd-statement"
                name="statement"
                rows={3}
                defaultValue={finding?.statement ?? ""}
                placeholder="The three payments to Supplier X in April 2026 were authorised by the finance director without a purchase order."
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field
              label="The reasoning"
              htmlFor="fnd-detail"
              hint="How the evidence and the information below lead to the statement above."
              error={state.fieldErrors?.detail}
            >
              <Textarea
                id="fnd-detail"
                name="detail"
                rows={3}
                defaultValue={finding?.detail ?? ""}
              />
            </Field>
          </div>

          {!editing && (
            <Field
              label="Analyst"
              htmlFor="fnd-analyst"
              required
              hint="Whoever reaches the conclusion. They cannot then review it."
              error={state.fieldErrors?.analyst}
            >
              <Select id="fnd-analyst" name="analyst" defaultValue={actorId}>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label="Confidence"
            htmlFor="fnd-confidence"
            required
            hint={
              ceiling
                ? `What is linked to this carries ${CONFIDENCE_LABELS[ceiling].toLowerCase()} at most. Link more of what it rests on to go higher.`
                : "A conclusion is no better supported than the least of what it rests on."
            }
            error={state.fieldErrors?.confidence}
          >
            <Select
              id="fnd-confidence"
              name="confidence"
              defaultValue={
                finding && offered.includes(finding.confidence)
                  ? finding.confidence
                  : offered[offered.length - 1]
              }
            >
              {offered.map((level) => (
                <option key={level} value={level}>
                  {CONFIDENCE_LABELS[level]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Date"
            htmlFor="fnd-date"
            error={state.fieldErrors?.findingDate}
          >
            <Input
              id="fnd-date"
              name="findingDate"
              type="date"
              defaultValue={finding?.findingDate?.slice(0, 10) ?? today()}
            />
          </Field>

          <Field
            label="Classification"
            htmlFor="fnd-classification"
            required
            error={state.fieldErrors?.classification}
          >
            <Select
              id="fnd-classification"
              name="classification"
              defaultValue={finding?.classification ?? defaultClassification}
            >
              {levels.map((level) => (
                <option key={level.code} value={level.code}>
                  {level.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function LinkFindingForm({
  caseRecordId,
  finding,
  informationCandidates,
  evidenceCandidates,
}: {
  caseRecordId: string;
  finding: Finding;
  informationCandidates: Option[];
  evidenceCandidates: Option[];
}) {
  const [linkType, setLinkType] = useState<"information" | "evidence">(
    informationCandidates.length > 0 ? "information" : "evidence",
  );
  const candidates =
    linkType === "information" ? informationCandidates : evidenceCandidates;

  if (informationCandidates.length === 0 && evidenceCandidates.length === 0) {
    return (
      <Muted>
        Everything on this case is already linked to this finding. Record the
        information or register the evidence first.
      </Muted>
    );
  }

  return (
    <ActionForm
      action={linkFinding}
      submitLabel={
        <>
          <Link2 className="size-3.5" aria-hidden="true" />
          Link it
        </>
      }
      submitSize="sm"
      hidden={{ caseRecordId, findingRecordId: finding.id }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="What kind" htmlFor="fl-type" required>
            <Select
              id="fl-type"
              name="linkType"
              value={linkType}
              onChange={(event) =>
                setLinkType(event.target.value as "information" | "evidence")
              }
            >
              {informationCandidates.length > 0 && (
                <option value="information">Information</option>
              )}
              {evidenceCandidates.length > 0 && (
                <option value="evidence">Evidence</option>
              )}
            </Select>
          </Field>

          <Field
            label="Which one"
            htmlFor="fl-target"
            required
            error={state.fieldErrors?.targetId}
          >
            <Select id="fl-target" name="targetId">
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Why it is relevant"
              htmlFor="fl-relevance"
              error={state.fieldErrors?.relevance}
            >
              <Input
                id="fl-relevance"
                name="relevance"
                placeholder="Page 4 shows the three payments with no purchase order reference"
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/**
 * Moving a finding through its states (PRD 15, PRD 16).
 *
 * The select offers only the moves the machine permits, so an accepted
 * finding cannot be dragged back to a draft by picking a status out of a
 * list. Reviewing is offered to somebody other than the analyst, and the
 * screen says why when it is not.
 */
export function FindingStatusForm({
  caseRecordId,
  finding,
  isOwnFinding,
  canApprove,
  canEdit,
}: {
  caseRecordId: string;
  finding: Finding;
  isOwnFinding: boolean;
  canApprove: boolean;
  canEdit: boolean;
}) {
  const all = allowedFindingTransitions(finding.status);
  const deciding = (status: string) =>
    status === "accepted" || status === "returned";

  // Only the moves this person can actually make. Offering "accept" to the
  // analyst would be offering something the server refuses.
  const offered = all.filter((status) =>
    deciding(status) ? canApprove && !isOwnFinding : canEdit,
  );

  const [target, setTarget] = useState(offered[0] ?? "");

  // Said whenever it is true, not only when there is nothing else to offer.
  //
  // The author of a submitted finding can still withdraw it, so `offered` is
  // not empty and this used to go unsaid: they saw a status control holding
  // "withdrawn" alone, with no indication that accepting and returning exist
  // and are deliberately not theirs. "The screen says why rather than
  // offering a form the server would refuse" is the rule everywhere else in
  // this platform, and a control silently missing its two main options is
  // the same failure in a quieter form.
  const ownSubmitted = finding.status === "submitted" && isOwnFinding;
  const whoReviews = ownSubmitted ? (
    <Alert tone="info">
      You are the analyst on this finding, so you cannot review it. A supervisor
      other than you has to, which is the only thing that makes the review worth
      having.
    </Alert>
  ) : null;

  if (offered.length === 0) {
    if (ownSubmitted) return whoReviews;
    if (finding.status === "accepted") {
      return (
        <Muted>
          Accepted and citable. Changing it now means withdrawing it and putting
          a new finding in its place, so a report that cites this one still
          reads true.
        </Muted>
      );
    }
    return (
      <Muted>Nothing for you to do with this finding at the moment.</Muted>
    );
  }

  return (
    <div className="space-y-3">
      {whoReviews}
      <ActionForm
        action={setFindingStatus}
        submitLabel={
          <>
            <Send className="size-4" aria-hidden="true" />
            {deciding(target) ? "Record the decision" : "Apply"}
          </>
        }
        submitSize="sm"
        hidden={{ caseRecordId, findingRecordId: finding.id }}
      >
        {(state) => (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Move it to"
              htmlFor="fnd-status"
              required
              error={state.fieldErrors?.status}
            >
              <Select
                id="fnd-status"
                name="status"
                value={target}
                onChange={(event) =>
                  setTarget(event.target.value as typeof target)
                }
              >
                {offered.map((status) => (
                  <option key={status} value={status}>
                    {FINDING_STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </Field>

            {deciding(target) && (
              <div className="sm:col-span-2">
                <Field
                  label="Your note"
                  htmlFor="fnd-review-notes"
                  required={target === "returned"}
                  hint={
                    target === "returned"
                      ? "Say what needs doing. A finding returned with no note is one nobody can act on."
                      : "Optional, and read by whoever cites this finding later."
                  }
                  error={state.fieldErrors?.reviewNotes}
                >
                  <Textarea id="fnd-review-notes" name="reviewNotes" rows={2} />
                </Field>
              </div>
            )}
          </div>
        )}
      </ActionForm>
    </div>
  );
}

export function RemoveFindingForm({
  caseRecordId,
  finding,
}: {
  caseRecordId: string;
  finding: Finding;
}) {
  return (
    <ActionForm
      action={removeFinding}
      submitLabel={
        <>
          <Trash2 className="size-4" aria-hidden="true" />
          Remove this finding
        </>
      }
      submitTone="danger"
      submitSize="sm"
      hidden={{ caseRecordId, findingRecordId: finding.id }}
      confirm={`Remove ${finding.findingId}? Withdrawing it is usually the better record.`}
    >
      {(state) => (
        <Field
          label="Reason for removal"
          htmlFor="fnd-remove-reason"
          required
          error={state.fieldErrors?.reason}
        >
          <Input
            id="fnd-remove-reason"
            name="reason"
            placeholder="Drafted against the wrong case"
          />
        </Field>
      )}
    </ActionForm>
  );
}

/* ------------------------------------------------- small open/close shells */

/**
 * A panel whose form opens on a button.
 *
 * Shared because six panels in this feature want it, and because of two rules
 * it has to encode.
 *
 * The form is NOT unmounted when it succeeds, since the success banner lives
 * inside it. That one was learned the hard way.
 *
 * And `canOpen` decides whether the button exists at all, rather than the
 * form inside it saying "you cannot". Offering a control that cannot work is
 * the thing this platform does not do anywhere else, and the first version of
 * this component did it on four tabs: an end-to-end step asserting that the
 * Operations Manager is offered no create control is what found it.
 */
export function Expandable({
  title,
  description,
  openLabel,
  canOpen = true,
  children,
  summary,
}: {
  title: string;
  description?: string;
  openLabel: string;
  /** False renders the panel with no way to open the form. */
  canOpen?: boolean;
  children: React.ReactNode;
  summary?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card
      title={title}
      description={description}
      actions={
        canOpen ? (
          <Button
            size="sm"
            tone={open ? "ghost" : "primary"}
            onClick={() => setOpen(!open)}
            // The button controls a region it shows and hides, so it has to
            // say which state that region is in. A screen reader otherwise
            // announces "Draft a finding" whether the form is open or not.
            aria-expanded={open}
          >
            {open ? (
              <>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </>
            ) : (
              <>
                <Plus className="size-4" aria-hidden="true" />
                {openLabel}
              </>
            )}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {canOpen && open && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            {children}
          </div>
        )}
        {summary}
      </div>
    </Card>
  );
}

"use server";

import { refreshPath } from "@/lib/revalidate";
import {
  EMPTY_FORM_STATE,
  invalidForm,
  unexpectedFailure,
  type FormState,
} from "@/lib/forms";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import {
  assertConfidenceIsSupported,
  assertConfidenceWithinCeiling,
  assertConfirmedIsCorroborated,
  assertCorroborationIsIndependent,
  assertCredibilityAndVerificationAgree,
  assertEntityRemovable,
  assertFindingIsSupported,
  assertFindingTransition,
  assertHoldingPeriodInOrder,
  assertIdentityIsProtected,
  assertInformationObtainedInThePast,
  assertInformationRemovable,
  assertMatchDecisionHasAReason,
  assertMergeable,
  assertNotReviewingOwnFinding,
  assertPercentageBelongsToAHolding,
  assertRelationshipEndsDiffer,
  assertReturnHasNotes,
  assertSourceObtainedInThePast,
  assertSourceRemovable,
  confidenceCeiling,
  intel,
  isIntelError,
  orderedPair,
} from "@/modules/intel";
import { isIamError } from "@/modules/iam";
import {
  addAliasSchema,
  addCorroborationSchema,
  addSubjectSchema,
  createEntitySchema,
  createFindingSchema,
  createInformationSchema,
  createRelationshipSchema,
  createSourceSchema,
  decideMatchSchema,
  entityReasonSchema,
  findingReasonSchema,
  findingStatusSchema,
  flagMatchSchema,
  informationReasonSchema,
  linkFindingSchema,
  linkInformationEvidenceSchema,
  mergeEntitiesSchema,
  removeAliasSchema,
  revealIdReferenceSchema,
  removeRelationshipSchema,
  removeSubjectSchema,
  reverseMergeSchema,
  sourceReasonSchema,
  unlinkFindingSchema,
  unlinkSchema,
  updateEntitySchema,
  updateFindingSchema,
  updateInformationSchema,
  updateRelationshipSchema,
  updateSourceSchema,
  updateSubjectSchema,
} from "./schema";

/**
 * Entity, source, information and finding actions (PRD 6.4, 8.4, 15).
 *
 * Thin, as the convention requires: parse, check the rule, call the use case,
 * revalidate. The rules themselves are in `@/modules/intel`, which is what
 * lets them be tested without a database and reused by the report builder in
 * M6.
 *
 * Two of them are worth naming here because they are the module's point. A
 * finding cannot be put forward for review with nothing linked to it, and a
 * finding's confidence cannot exceed what its support will carry. Both are
 * refusals a user will meet, and both are phrased to say what to do next.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isIntelError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("intel action failed", error);
    return unexpectedFailure(error, "saving that");
  }
}

function revalidateEntity(entityRecordId?: string, caseRecordId?: string) {
  refreshPath("/entities");
  if (entityRecordId) refreshPath(`/entities/${entityRecordId}`);
  if (caseRecordId) refreshPath(`/cases/${caseRecordId}`);
}

function revalidateSource(caseRecordId: string, sourceRecordId?: string) {
  refreshPath("/sources");
  refreshPath(`/cases/${caseRecordId}`);
  if (sourceRecordId) refreshPath(`/sources/${sourceRecordId}`);
}

function revalidateInformation(caseRecordId: string, informationRecordId?: string) {
  refreshPath("/information");
  refreshPath(`/cases/${caseRecordId}`);
  if (informationRecordId) refreshPath(`/information/${informationRecordId}`);
}

function revalidateFinding(caseRecordId: string, findingRecordId?: string) {
  refreshPath("/findings");
  refreshPath(`/cases/${caseRecordId}`);
  if (findingRecordId) refreshPath(`/findings/${findingRecordId}`);
}

/* ------------------------------------------------------------- entities */

export async function createEntity(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "create");

    const parsed = createEntitySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "entities", "create", parsed.data.classification);

    const { caseRecordId, subjectRole, relationshipToCase, ...input } = parsed.data;
    const api = intel(actor);

    const created = await api.entities.create(input);

    // Added to the case in the same step when the form came from a case
    // file, because registering a subject you then have to go and attach is
    // two jobs for what a person thinks of as one.
    if (caseRecordId) {
      await api.subjects.add({
        caseId: caseRecordId,
        entityId: created.id,
        subjectRole: subjectRole ?? "person_of_interest",
        relationshipToCase,
      });
    }

    // Looked for straight away, so a duplicate is caught at the moment it is
    // created rather than found months later (PRD 8.4).
    const similar = await api.entities.findSimilar({
      entityId: created.id,
      name: created.name,
      entityType: created.entityType,
    });

    revalidateEntity(created.id, caseRecordId ?? undefined);

    return {
      ...EMPTY_FORM_STATE,
      success:
        similar.length > 0
          ? `${created.entityId} registered. ${similar.length} existing ${
              similar.length === 1 ? "record looks" : "records look"
            } like it, which somebody should decide on before the register has two of the same thing.`
          : `${created.entityId} registered.`,
    };
  });
}

export async function updateEntity(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "edit");

    const parsed = updateEntitySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "entities", "edit", parsed.data.classification);

    const { entityRecordId, expectedVersion, ...input } = parsed.data;
    await intel(actor).entities.update(entityRecordId, input, expectedVersion);

    revalidateEntity(entityRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

export async function removeEntity(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "delete");

    const parsed = entityReasonSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = intel(actor);
    const entity = await api.entities.findById(parsed.data.entityRecordId);
    if (!entity) {
      return { ...EMPTY_FORM_STATE, error: "That record no longer exists." };
    }
    assertEntityRemovable(entity);

    await api.entities.softDelete(parsed.data.entityRecordId, parsed.data.reason);

    revalidateEntity(parsed.data.entityRecordId);
    refreshPath("/admin/recycle-bin");
    return {
      ...EMPTY_FORM_STATE,
      success: "Removed to the recycle bin. Nothing it was linked to was touched.",
    };
  });
}

export async function restoreEntity(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "delete");

    const parsed = entityReasonSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).entities.restore(
      parsed.data.entityRecordId,
      parsed.data.reason,
    );

    revalidateEntity(parsed.data.entityRecordId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Record restored." };
  });
}

export async function addAlias(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "edit");

    const parsed = addAliasSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).entities.addAlias({
      entityId: parsed.data.entityRecordId,
      alias: parsed.data.alias,
      aliasType: parsed.data.aliasType,
      sourceNote: parsed.data.sourceNote,
    });

    revalidateEntity(parsed.data.entityRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `"${parsed.data.alias}" recorded. A search for it now finds this record.`,
    };
  });
}

export async function removeAlias(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "edit");

    const parsed = removeAliasSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).entities.removeAlias(parsed.data.aliasId);

    revalidateEntity(parsed.data.entityRecordId);
    return { ...EMPTY_FORM_STATE, success: "Alias removed." };
  });
}

/**
 * Revealing an entity's identity reference (PRD 15).
 *
 * The value is encrypted at rest and decrypted by a SECURITY DEFINER
 * function that checks the permission itself and writes the access to the
 * audit trail. It is returned in the confirmation rather than rendered into
 * the page, so it is on screen only because somebody asked for it, and the
 * next page load does not carry it.
 */
export async function revealIdReference(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "view");

    const parsed = revealIdReferenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const reference = await intel(actor).entities.idReference(
      parsed.data.entityRecordId,
    );

    return reference
      ? {
          ...EMPTY_FORM_STATE,
          success: `Identity reference: ${reference}. Reading it has been recorded in the audit trail.`,
        }
      : {
          ...EMPTY_FORM_STATE,
          error: "No identity reference is held for this record.",
        };
  });
}

/* -------------------------------------------------------- case subjects */

export async function addSubject(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "edit");

    const parsed = addSubjectSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const subject = await intel(actor).subjects.add({
      caseId: parsed.data.caseRecordId,
      entityId: parsed.data.entityRecordId,
      subjectRole: parsed.data.subjectRole,
      relationshipToCase: parsed.data.relationshipToCase,
    });

    revalidateEntity(parsed.data.entityRecordId, parsed.data.caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${subject.entityName} is on this case as a ${subject.subjectRole.replace(/_/g, " ")}.`,
    };
  });
}

export async function updateSubject(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "edit");

    const parsed = updateSubjectSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).subjects.update(
      parsed.data.subjectId,
      {
        subjectRole: parsed.data.subjectRole,
        relationshipToCase: parsed.data.relationshipToCase,
      },
      parsed.data.expectedVersion,
    );

    revalidateEntity(undefined, parsed.data.caseRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

export async function removeSubject(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "edit");

    const parsed = removeSubjectSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).subjects.remove(parsed.data.subjectId, parsed.data.reason);

    revalidateEntity(undefined, parsed.data.caseRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success:
        "Taken off the case, with the reason. Looking at a subject and ruling them out is part of what the investigation did, so it stays on the record.",
    };
  });
}

/* --------------------------------------------------------- relationships */

export async function createRelationship(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "edit");

    const parsed = createRelationshipSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { fromEntityId, toEntityId, ...input } = parsed.data;

    assertRelationshipEndsDiffer(fromEntityId, toEntityId);
    assertPercentageBelongsToAHolding(input.relationshipType, input.percentage);
    assertHoldingPeriodInOrder(input.heldFrom, input.heldTo);
    assertConfidenceIsSupported(input.confidence, {
      sourceId: input.sourceId,
      evidenceItemId: input.evidenceItemId,
    });

    const created = await intel(actor).relationships.create({
      fromEntityId,
      toEntityId,
      ...input,
    });

    revalidateEntity(fromEntityId);
    revalidateEntity(toEntityId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${created.fromEntityName} ${created.relationshipType.replace(/_/g, " ")} ${created.toEntityName}, recorded.`,
    };
  });
}

export async function updateRelationship(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "edit");

    const parsed = updateRelationshipSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { entityRecordId, relationshipId, expectedVersion, ...input } = parsed.data;

    assertPercentageBelongsToAHolding(input.relationshipType, input.percentage);
    assertHoldingPeriodInOrder(input.heldFrom, input.heldTo);
    assertConfidenceIsSupported(input.confidence, {
      sourceId: input.sourceId,
      evidenceItemId: input.evidenceItemId,
    });

    await intel(actor).relationships.update(relationshipId, input, expectedVersion);

    revalidateEntity(entityRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

export async function removeRelationship(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "edit");

    const parsed = removeRelationshipSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).relationships.softDelete(
      parsed.data.relationshipId,
      parsed.data.reason,
    );

    revalidateEntity(parsed.data.entityRecordId);
    return { ...EMPTY_FORM_STATE, success: "Relationship removed." };
  });
}

/* ------------------------------------------- entity resolution (PRD 8.4) */

export async function flagMatch(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "edit");

    const parsed = flagMatchSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    // Refuses a record flagged against itself, and fixes the pair's order so
    // the same two records cannot be flagged twice in opposite directions.
    orderedPair(parsed.data.entityRecordId, parsed.data.otherEntityId);

    await intel(actor).resolution.flag({
      entityAId: parsed.data.entityRecordId,
      entityBId: parsed.data.otherEntityId,
      flagType: parsed.data.flagType,
      notes: parsed.data.notes,
      detectedBy: "manual",
    });

    revalidateEntity(parsed.data.entityRecordId);
    revalidateEntity(parsed.data.otherEntityId);
    return {
      ...EMPTY_FORM_STATE,
      success:
        "Flagged for a decision. Nothing is merged until somebody decides they are the same thing, and says why.",
    };
  });
}

export async function decideMatch(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "edit");

    const parsed = decideMatchSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    assertMatchDecisionHasAReason(parsed.data.status, parsed.data.reason);

    const decided = await intel(actor).resolution.decide({
      flagId: parsed.data.flagId,
      status: parsed.data.status,
      reason: parsed.data.reason,
    });

    revalidateEntity(parsed.data.entityRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success:
        decided.status === "same_entity"
          ? "Recorded as the same thing. Merging them is the next, separate step, and it is reversible."
          : "Recorded. The two records stay separate, and the flag will not be raised again.",
    };
  });
}

/**
 * Merging two records (PRD 8.4).
 *
 * Its own permission, because deciding two records are one thing is not the
 * same authority as correcting a name: PRD 8.4 says merging "requires
 * authorised confirmation".
 */
export async function mergeEntities(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "merge");

    const parsed = mergeEntitiesSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = intel(actor);
    const [surviving, merged] = await Promise.all([
      api.entities.findById(parsed.data.survivingEntityId),
      api.entities.findById(parsed.data.mergedEntityId),
    ]);
    if (!surviving || !merged) {
      return { ...EMPTY_FORM_STATE, error: "One of those records no longer exists." };
    }

    const flags = await api.resolution.flags({ entityId: surviving.id });
    const flag =
      flags.find(
        (candidate) =>
          (candidate.entityAId === merged.id || candidate.entityBId === merged.id) &&
          candidate.status === "same_entity",
      ) ?? null;

    assertMergeable(surviving, merged, flag);

    const result = await api.resolution.merge({
      survivingEntityId: surviving.id,
      mergedEntityId: merged.id,
      reason: parsed.data.reason,
    });

    revalidateEntity(surviving.id);
    revalidateEntity(merged.id);
    return {
      ...EMPTY_FORM_STATE,
      success: `${result.mergedEntityReference} merged into ${result.survivingEntityReference}. Nothing was deleted, and this can be reversed.`,
    };
  });
}

export async function reverseMerge(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "entities", "merge");

    const parsed = reverseMergeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const reversed = await intel(actor).resolution.reverse({
      mergeId: parsed.data.mergeId,
      reason: parsed.data.reason,
    });

    revalidateEntity(reversed.survivingEntityId);
    revalidateEntity(reversed.mergedEntityId);
    return {
      ...EMPTY_FORM_STATE,
      success: `${reversed.mergedEntityReference} stands on its own again, marked disputed so somebody decides it properly.`,
    };
  });
}

/* -------------------------------------------------------------- sources */

export async function createSource(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "sources", "create");

    const parsed = createSourceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, ...input } = parsed.data;

    assertSourceObtainedInThePast(input.dateObtained);
    // An identity may only be recorded where it is protected. A human source
    // is protected automatically, which is what makes this pass for the only
    // case that should carry one.
    assertIdentityIsProtected({
      sourceType: input.sourceType,
      identityRestricted: input.sourceType === "human_source",
      identityName: input.identityName,
      identityContact: input.identityContact,
      identityNotes: input.identityNotes,
    });

    await requirePermission(actor, "sources", "create", input.classification);

    const created = await intel(actor).sources.create({
      caseId: caseRecordId,
      ...input,
    });

    revalidateSource(caseRecordId, created.id);
    return {
      ...EMPTY_FORM_STATE,
      success:
        created.sourceType === "human_source"
          ? `${created.sourceId} recorded as a human source, so its identity is need-to-know: what it told you stays readable to the case team, who it is does not (PRD 6.4).`
          : `${created.sourceId} recorded.`,
    };
  });
}

export async function updateSource(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "sources", "edit");

    const parsed = updateSourceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, sourceRecordId, expectedVersion, ...input } = parsed.data;

    assertIdentityIsProtected({
      sourceType: input.sourceType,
      identityRestricted: input.sourceType === "human_source",
      identityName: input.identityName,
      identityContact: input.identityContact,
      identityNotes: input.identityNotes,
    });
    await requirePermission(actor, "sources", "edit", input.classification);

    await intel(actor).sources.update(sourceRecordId, input, expectedVersion);

    revalidateSource(caseRecordId, sourceRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

export async function removeSource(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "sources", "delete");

    const parsed = sourceReasonSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = intel(actor);
    const source = await api.sources.findById(parsed.data.sourceRecordId);
    if (!source) {
      return { ...EMPTY_FORM_STATE, error: "That source no longer exists." };
    }
    assertSourceRemovable(source);

    await api.sources.softDelete(parsed.data.sourceRecordId, parsed.data.reason);

    revalidateSource(parsed.data.caseRecordId, parsed.data.sourceRecordId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Removed to the recycle bin." };
  });
}

export async function restoreSource(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "sources", "delete");

    const parsed = sourceReasonSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).sources.restore(
      parsed.data.sourceRecordId,
      parsed.data.reason,
    );

    revalidateSource(parsed.data.caseRecordId, parsed.data.sourceRecordId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Source restored." };
  });
}

/* ---------------------------------------------------------- information */

export async function createInformation(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "information", "create");

    const parsed = createInformationSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, sourceRecordId, entityRecordId, ...input } = parsed.data;

    assertInformationObtainedInThePast(input.dateObtained);
    // Nothing is corroborated at the moment it is recorded, so "confirmed"
    // cannot be the credibility of a brand new statement.
    assertConfirmedIsCorroborated(input.informationCredibility, {
      corroborations: 0,
      evidence: 0,
    });
    await requirePermission(actor, "information", "create", input.classification);

    const created = await intel(actor).information.create({
      caseId: caseRecordId,
      sourceId: sourceRecordId,
      entityId: entityRecordId,
      ...input,
    });

    revalidateInformation(caseRecordId, created.id);
    return {
      ...EMPTY_FORM_STATE,
      success: `${created.informationId} recorded against ${created.sourceReference}.`,
    };
  });
}

export async function updateInformation(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "information", "edit");

    const parsed = updateInformationSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const {
      caseRecordId,
      informationRecordId,
      expectedVersion,
      entityRecordId,
      ...input
    } = parsed.data;

    assertCredibilityAndVerificationAgree(
      input.informationCredibility,
      input.verificationStatus,
    );

    const api = intel(actor);
    const existing = await api.information.findById(informationRecordId);
    if (!existing) {
      return { ...EMPTY_FORM_STATE, error: "That no longer exists." };
    }
    // "Confirmed" is a claim about corroboration, so it is checked against
    // what actually corroborates this statement.
    assertConfirmedIsCorroborated(input.informationCredibility, {
      corroborations: existing.corroborationCount,
      evidence: existing.evidenceCount,
    });
    await requirePermission(actor, "information", "edit", input.classification);

    await api.information.update(
      informationRecordId,
      { ...input, entityId: entityRecordId },
      expectedVersion,
    );

    revalidateInformation(caseRecordId, informationRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

export async function removeInformation(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "information", "delete");

    const parsed = informationReasonSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = intel(actor);
    const existing = await api.information.findById(parsed.data.informationRecordId);
    if (!existing) {
      return { ...EMPTY_FORM_STATE, error: "That no longer exists." };
    }
    const cited = await api.information.citedByFindings(existing.id);
    assertInformationRemovable(existing, cited);

    await api.information.softDelete(
      parsed.data.informationRecordId,
      parsed.data.reason,
    );

    revalidateInformation(parsed.data.caseRecordId, parsed.data.informationRecordId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Removed to the recycle bin." };
  });
}

export async function restoreInformation(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "information", "delete");

    const parsed = informationReasonSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).information.restore(
      parsed.data.informationRecordId,
      parsed.data.reason,
    );

    revalidateInformation(parsed.data.caseRecordId, parsed.data.informationRecordId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Restored." };
  });
}

export async function addCorroboration(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "information", "edit");

    const parsed = addCorroborationSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const api = intel(actor);
    const [subject, corroborating] = await Promise.all([
      api.information.findById(parsed.data.informationRecordId),
      api.information.findById(parsed.data.corroboratingInformationId),
    ]);
    if (!subject || !corroborating) {
      return { ...EMPTY_FORM_STATE, error: "One of those no longer exists." };
    }

    // Two statements from the same source are one source saying something
    // twice, which corroborates nothing.
    assertCorroborationIsIndependent(subject, corroborating);

    await api.information.addCorroboration({
      informationId: subject.id,
      corroboratingInformationId: corroborating.id,
      note: parsed.data.note,
    });

    revalidateInformation(parsed.data.caseRecordId, subject.id);
    return {
      ...EMPTY_FORM_STATE,
      success: `${corroborating.informationId} now corroborates this, from ${corroborating.sourceReference}.`,
    };
  });
}

export async function removeCorroboration(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "information", "edit");

    const parsed = unlinkSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).information.removeCorroboration(parsed.data.linkId);

    revalidateInformation(
      parsed.data.caseRecordId,
      parsed.data.informationRecordId,
    );
    return { ...EMPTY_FORM_STATE, success: "Corroboration removed." };
  });
}

export async function linkInformationEvidence(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "information", "edit");

    const parsed = linkInformationEvidenceSchema.safeParse(
      Object.fromEntries(formData),
    );
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).information.linkEvidence({
      informationId: parsed.data.informationRecordId,
      evidenceItemId: parsed.data.evidenceItemId,
      note: parsed.data.note,
    });

    revalidateInformation(
      parsed.data.caseRecordId,
      parsed.data.informationRecordId,
    );
    return {
      ...EMPTY_FORM_STATE,
      success: "Linked. The evidence now appears on the traceability of anything resting on this.",
    };
  });
}

export async function unlinkInformationEvidence(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "information", "edit");

    const parsed = unlinkSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).information.unlinkEvidence(parsed.data.linkId);

    revalidateInformation(
      parsed.data.caseRecordId,
      parsed.data.informationRecordId,
    );
    return { ...EMPTY_FORM_STATE, success: "Link removed." };
  });
}

/* ------------------------------------------------------------- findings */

export async function createFinding(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "findings", "create");

    const parsed = createFindingSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);
    await requirePermission(actor, "findings", "create", parsed.data.classification);

    const { caseRecordId, ...input } = parsed.data;

    const created = await intel(actor).findings.create({
      caseId: caseRecordId,
      ...input,
      findingDate: input.findingDate ?? undefined,
    });

    revalidateFinding(caseRecordId, created.id);
    return {
      ...EMPTY_FORM_STATE,
      success: `${created.findingId} drafted. Link what it rests on before putting it forward: a finding with nothing behind it cannot be reviewed.`,
    };
  });
}

export async function updateFinding(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "findings", "edit");

    const parsed = updateFindingSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, findingRecordId, expectedVersion, ...input } = parsed.data;

    const api = intel(actor);
    const existing = await api.findings.findById(findingRecordId);
    if (!existing) {
      return { ...EMPTY_FORM_STATE, error: "That finding no longer exists." };
    }
    // An accepted finding is not edited: it is withdrawn and replaced, so a
    // report that cites it still reads true.
    if (existing.status === "accepted") {
      assertFindingTransition("accepted", "draft");
    }

    const support = await api.findings.support(findingRecordId);
    assertConfidenceWithinCeiling(
      input.confidence,
      confidenceCeiling(support.information, support.evidenceCount),
    );
    await requirePermission(actor, "findings", "edit", input.classification);

    await api.findings.update(
      findingRecordId,
      { ...input, findingDate: input.findingDate ?? undefined },
      expectedVersion,
    );

    revalidateFinding(caseRecordId, findingRecordId);
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

/**
 * Putting a finding forward, or deciding one (PRD 15, PRD 16).
 *
 * The three rules together are the module's purpose: a finding cannot be put
 * forward resting on nothing, it cannot be reviewed by its own analyst, and a
 * return has to say what needs doing.
 */
export async function setFindingStatus(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();

    const parsed = findingStatusSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { caseRecordId, findingRecordId, status, reviewNotes } = parsed.data;
    const deciding = status === "accepted" || status === "returned";

    await requirePermission(actor, "findings", deciding ? "approve" : "edit");

    const api = intel(actor);
    const finding = await api.findings.findById(findingRecordId);
    if (!finding) {
      return { ...EMPTY_FORM_STATE, error: "That finding no longer exists." };
    }

    assertFindingTransition(finding.status, status);

    if (status === "submitted") {
      const links = finding.links;
      assertFindingIsSupported({
        information: links.filter((link) => link.linkType === "information").length,
        evidence: links.filter((link) => link.linkType === "evidence").length,
      });
    }

    if (deciding) {
      assertNotReviewingOwnFinding(finding, actor.userId);
      assertReturnHasNotes(status, reviewNotes);
    }

    const after = await api.findings.setStatus({
      id: findingRecordId,
      status,
      reviewNotes,
    });

    revalidateFinding(caseRecordId, findingRecordId);

    const messages: Record<string, string> = {
      submitted: `${after.findingId} is with a reviewer. You cannot review it yourself.`,
      accepted: `${after.findingId} accepted. It can now be cited in a report.`,
      returned: `${after.findingId} returned to its analyst with your note.`,
      withdrawn: `${after.findingId} withdrawn. It stays on the case with its history.`,
      draft: `${after.findingId} is a draft again.`,
    };

    return { ...EMPTY_FORM_STATE, success: messages[status] };
  });
}

export async function linkFinding(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "findings", "edit");

    const parsed = linkFindingSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).findings.link({
      findingId: parsed.data.findingRecordId,
      linkType: parsed.data.linkType,
      targetId: parsed.data.targetId,
      relevance: parsed.data.relevance,
    });

    revalidateFinding(parsed.data.caseRecordId, parsed.data.findingRecordId);
    return {
      ...EMPTY_FORM_STATE,
      success: "Linked. The traceability now runs through it.",
    };
  });
}

export async function unlinkFinding(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "findings", "edit");

    const parsed = unlinkFindingSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).findings.unlink(parsed.data.linkId);

    revalidateFinding(parsed.data.caseRecordId, parsed.data.findingRecordId);
    return { ...EMPTY_FORM_STATE, success: "Link removed." };
  });
}

export async function removeFinding(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "findings", "delete");

    const parsed = findingReasonSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).findings.softDelete(
      parsed.data.findingRecordId,
      parsed.data.reason,
    );

    revalidateFinding(parsed.data.caseRecordId, parsed.data.findingRecordId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Removed to the recycle bin." };
  });
}

export async function restoreFinding(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "findings", "delete");

    const parsed = findingReasonSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await intel(actor).findings.restore(
      parsed.data.findingRecordId,
      parsed.data.reason,
    );

    revalidateFinding(parsed.data.caseRecordId, parsed.data.findingRecordId);
    refreshPath("/admin/recycle-bin");
    return { ...EMPTY_FORM_STATE, success: "Finding restored." };
  });
}

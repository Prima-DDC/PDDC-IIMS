import "server-only";
import { canAll, requireActor } from "@/lib/auth/session";
import { intel } from "@/modules/intel";
import { evidence } from "@/modules/evidence";
import { confidenceCeiling } from "@/modules/intel/shared";
import { classificationLevels, staffDirectory } from "@/lib/reference";

/** Read models for the intelligence screens (PRD 6.4, 8.4, 15). */

const ENTITY_PERMISSIONS = [
  { resource: "entities", action: "create" },
  { resource: "entities", action: "edit" },
  { resource: "entities", action: "merge" },
  { resource: "entities", action: "delete" },
] as const;

const SOURCE_PERMISSIONS = [
  { resource: "sources", action: "create" },
  { resource: "sources", action: "edit" },
  { resource: "sources", action: "delete" },
  { resource: "information", action: "create" },
  { resource: "information", action: "edit" },
  { resource: "information", action: "delete" },
] as const;

const FINDING_PERMISSIONS = [
  { resource: "findings", action: "create" },
  { resource: "findings", action: "edit" },
  { resource: "findings", action: "approve" },
  { resource: "findings", action: "delete" },
] as const;

function entityAbilities(allowed: Record<string, boolean>) {
  return {
    create: allowed["entities:create"],
    edit: allowed["entities:edit"],
    merge: allowed["entities:merge"],
    remove: allowed["entities:delete"],
  };
}

function sourceAbilities(allowed: Record<string, boolean>) {
  return {
    createSource: allowed["sources:create"],
    editSource: allowed["sources:edit"],
    removeSource: allowed["sources:delete"],
    createInformation: allowed["information:create"],
    editInformation: allowed["information:edit"],
    removeInformation: allowed["information:delete"],
  };
}

function findingAbilities(allowed: Record<string, boolean>) {
  return {
    create: allowed["findings:create"],
    edit: allowed["findings:edit"],
    approve: allowed["findings:approve"],
    remove: allowed["findings:delete"],
  };
}

/* ------------------------------------------------------------- entities */

export async function listEntities(params: {
  search?: string;
  entityType?: string;
  resolutionStatus?: string;
  flaggedOnly?: boolean;
  onlyDeleted?: boolean;
  page?: number;
  perPage?: number;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const api = intel(actor);
  const [result, summary, allowed, levels] = await Promise.all([
    api.entities.list({
      search: params.search,
      entityType: params.entityType as never,
      resolutionStatus: params.resolutionStatus as never,
      flaggedOnly: params.flaggedOnly,
      onlyDeleted: params.onlyDeleted,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    api.entities.summary({}),
    canAll(actor, [...ENTITY_PERMISSIONS]),
    classificationLevels(actor),
  ]);

  return {
    ...result,
    summary,
    levels,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    can: entityAbilities(allowed),
  };
}

/**
 * One subject, with everything that answers "who is this and how do we know".
 *
 * The similar records come back with it rather than on request, because a
 * duplicate nobody looked for is a duplicate: PRD 8.4 wants the flag in front
 * of whoever opens the record.
 */
export async function getEntityDetail(entityRecordId: string) {
  const actor = await requireActor();
  const api = intel(actor);

  const entity = await api.entities.findById(entityRecordId);
  if (!entity) return null;

  const [
    relationships,
    graph,
    appearances,
    flags,
    merges,
    similar,
    allowed,
    levels,
  ] = await Promise.all([
    api.relationships.forEntity(entityRecordId),
    api.relationships.graph({ entityIds: [entityRecordId], depth: 2 }),
    api.entities.subjectOf(entityRecordId),
    api.resolution.flags({ entityId: entityRecordId }),
    api.resolution.merges({ entityId: entityRecordId }),
    api.entities.findSimilar({
      entityId: entityRecordId,
      name: entity.name,
      entityType: entity.entityType,
    }),
    canAll(actor, [...ENTITY_PERMISSIONS]),
    classificationLevels(actor),
  ]);

  // Already flagged or already decided: not offered again as a suggestion,
  // which is what stops the banner nagging about a pair somebody has settled.
  const known = new Set(
    flags.flatMap((flag) => [flag.entityAId, flag.entityBId]),
  );

  return {
    entity,
    relationships,
    graph,
    appearances,
    flags,
    merges,
    similar: similar.filter((match) => !known.has(match.entity.id)),
    levels,
    actorId: actor.userId,
    can: entityAbilities(allowed),
  };
}

/**
 * The case file's subjects tab.
 *
 * Everything the tab needs in one read, including the register entries it
 * could add. The tab used to fetch those separately in the route, which was
 * a second transaction and a second connection for a list this function was
 * already positioned to get: on a database 130ms away that is the difference
 * between a page and a wait.
 */
export async function getCaseSubjects(caseRecordId: string) {
  const actor = await requireActor();
  const api = intel(actor);

  const [subjects, summary, register, allowed, levels] = await Promise.all([
    api.subjects.forCase(caseRecordId, true),
    api.entities.summary({ caseId: caseRecordId }),
    api.entities.list({ limit: 200 }),
    canAll(actor, [...ENTITY_PERMISSIONS]),
    classificationLevels(actor),
  ]);

  const live = subjects.filter((subject) => subject.removedAt === null);
  const onCase = new Set(live.map((subject) => subject.entityId));

  return {
    subjects: live,
    removed: subjects.filter((subject) => subject.removedAt !== null),
    summary,
    levels,
    /** In the register and not already on this case. */
    available: register.rows.filter((entity) => !onCase.has(entity.id)),
    // The graph of the case's own subjects, which is the link analysis an
    // investigator actually wants: everything, two hops out from the people
    // this case is about.
    graph:
      live.length > 0
        ? await api.relationships.graph({
            entityIds: live.map((subject) => subject.entityId),
            depth: 2,
          })
        : { entities: [], relationships: [] },
    actorId: actor.userId,
    can: entityAbilities(allowed),
  };
}

/* -------------------------------------------------- sources, information */

export async function listSources(params: {
  caseId?: string;
  search?: string;
  sourceType?: string;
  sourceReliability?: string;
  onlyDeleted?: boolean;
  page?: number;
  perPage?: number;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const api = intel(actor);
  const [result, summary, allowed] = await Promise.all([
    api.sources.list({
      caseId: params.caseId,
      search: params.search,
      sourceType: params.sourceType as never,
      sourceReliability: params.sourceReliability as never,
      onlyDeleted: params.onlyDeleted,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    api.sources.summary({ caseId: params.caseId }),
    canAll(actor, [...SOURCE_PERMISSIONS]),
  ]);

  return {
    ...result,
    summary,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    can: sourceAbilities(allowed),
  };
}

export async function getSourceDetail(sourceRecordId: string) {
  const actor = await requireActor();
  const api = intel(actor);

  const source = await api.sources.findById(sourceRecordId);
  if (!source) return null;

  const [information, allowed, directory, levels] = await Promise.all([
    api.information.list({ sourceId: sourceRecordId, limit: 200 }),
    canAll(actor, [...SOURCE_PERMISSIONS]),
    staffDirectory(actor),
    classificationLevels(actor),
  ]);

  return {
    source,
    information: information.rows,
    levels,
    people: directory,
    actorId: actor.userId,
    can: sourceAbilities(allowed),
  };
}

export async function listInformation(params: {
  caseId?: string;
  search?: string;
  credibility?: string;
  uncorroboratedOnly?: boolean;
  onlyDeleted?: boolean;
  page?: number;
  perPage?: number;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const api = intel(actor);
  const [result, summary, allowed] = await Promise.all([
    api.information.list({
      caseId: params.caseId,
      search: params.search,
      credibility: params.credibility as never,
      uncorroboratedOnly: params.uncorroboratedOnly,
      onlyDeleted: params.onlyDeleted,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    api.information.summary({ caseId: params.caseId }),
    canAll(actor, [...SOURCE_PERMISSIONS]),
  ]);

  return {
    ...result,
    summary,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    can: sourceAbilities(allowed),
  };
}

export async function getInformationDetail(informationRecordId: string) {
  const actor = await requireActor();
  const api = intel(actor);

  const information = await api.information.findById(informationRecordId);
  if (!information) return null;

  const [corroborations, linkedEvidence, candidates, items, cited, allowed, levels] =
    await Promise.all([
      api.information.corroborations(informationRecordId),
      api.information.evidence(informationRecordId),
      // What could corroborate it: anything else on the case, which the form
      // then narrows to a different source when it is submitted.
      api.information.list({ caseId: information.caseId, limit: 200 }),
      evidence(actor).items.list({ caseId: information.caseId, limit: 200 }),
      api.information.citedByFindings(informationRecordId),
      canAll(actor, [...SOURCE_PERMISSIONS]),
      classificationLevels(actor),
    ]);

  const already = new Set(
    corroborations.map((link) => link.corroboratingInformationId),
  );
  const linked = new Set(linkedEvidence.map((link) => link.evidenceItemId));

  return {
    information,
    corroborations,
    linkedEvidence,
    citedByFindings: cited,
    // Only what is not already linked and not from the same source, so the
    // control offers nothing the server would refuse.
    corroborationCandidates: candidates.rows.filter(
      (candidate) =>
        candidate.id !== informationRecordId &&
        candidate.sourceId !== information.sourceId &&
        !already.has(candidate.id),
    ),
    evidenceCandidates: items.rows.filter((item) => !linked.has(item.id)),
    levels,
    actorId: actor.userId,
    can: sourceAbilities(allowed),
  };
}

/** The case file's sources tab, which holds both registers. */
export async function getCaseSources(caseRecordId: string) {
  const actor = await requireActor();
  const api = intel(actor);

  const [sources, information, sourceSummary, informationSummary, allowed, directory, levels] =
    await Promise.all([
      api.sources.list({ caseId: caseRecordId, limit: 200 }),
      api.information.list({ caseId: caseRecordId, limit: 200 }),
      api.sources.summary({ caseId: caseRecordId }),
      api.information.summary({ caseId: caseRecordId }),
      canAll(actor, [...SOURCE_PERMISSIONS]),
      staffDirectory(actor),
      classificationLevels(actor),
    ]);

  return {
    sources: sources.rows,
    information: information.rows,
    sourceSummary,
    informationSummary,
    levels,
    people: directory,
    actorId: actor.userId,
    can: sourceAbilities(allowed),
  };
}

/* ------------------------------------------------------------- findings */

export async function listFindings(params: {
  caseId?: string;
  search?: string;
  status?: string;
  confidence?: string;
  onlyDeleted?: boolean;
  page?: number;
  perPage?: number;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const api = intel(actor);
  const [result, summary, allowed] = await Promise.all([
    api.findings.list({
      caseId: params.caseId,
      search: params.search,
      status: params.status as never,
      confidence: params.confidence as never,
      onlyDeleted: params.onlyDeleted,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    api.findings.summary({ caseId: params.caseId }),
    canAll(actor, [...FINDING_PERMISSIONS]),
  ]);

  return {
    ...result,
    summary,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    can: findingAbilities(allowed),
  };
}

/**
 * One finding, with its traceability and the ceiling its support will carry.
 *
 * The ceiling is computed here rather than on submit so the form can show it
 * before anybody picks a confidence, which is the difference between a rule
 * that teaches and a rule that refuses.
 */
export async function getFindingDetail(findingRecordId: string) {
  const actor = await requireActor();
  const api = intel(actor);

  const finding = await api.findings.findById(findingRecordId);
  if (!finding) return null;

  const [trace, support, information, items, allowed, directory, levels] =
    await Promise.all([
      api.findings.traceability(findingRecordId),
      api.findings.support(findingRecordId),
      api.information.list({ caseId: finding.caseId, limit: 200 }),
      evidence(actor).items.list({ caseId: finding.caseId, limit: 200 }),
      canAll(actor, [...FINDING_PERMISSIONS]),
      staffDirectory(actor),
      classificationLevels(actor),
    ]);

  const linked = new Set(
    finding.links.map(
      (link) => link.informationId ?? link.evidenceItemId ?? link.documentId ?? "",
    ),
  );

  return {
    finding,
    trace,
    ceiling: confidenceCeiling(support.information, support.evidenceCount),
    support,
    informationCandidates: information.rows.filter((row) => !linked.has(row.id)),
    evidenceCandidates: items.rows.filter((row) => !linked.has(row.id)),
    levels,
    people: directory,
    actorId: actor.userId,
    /** True when this actor is the analyst, so the screen says why not. */
    isOwnFinding: finding.analyst === actor.userId,
    can: findingAbilities(allowed),
  };
}

/** The case file's findings tab. */
export async function getCaseFindings(caseRecordId: string) {
  const actor = await requireActor();
  const api = intel(actor);

  const [findings, summary, allowed, directory, levels] = await Promise.all([
    api.findings.list({ caseId: caseRecordId, limit: 200 }),
    api.findings.summary({ caseId: caseRecordId }),
    canAll(actor, [...FINDING_PERMISSIONS]),
    staffDirectory(actor),
    classificationLevels(actor),
  ]);

  return {
    findings: findings.rows,
    summary,
    levels,
    people: directory,
    actorId: actor.userId,
    can: findingAbilities(allowed),
  };
}

/**
 * The counts the case file's tab bar shows for this module.
 *
 * One query. See the note on the casework equivalent for why that matters
 * more than it looks like it should.
 */
export async function getIntelTabCounts(caseRecordId: string) {
  const actor = await requireActor();
  return intel(actor).entities.tabCounts(caseRecordId);
}

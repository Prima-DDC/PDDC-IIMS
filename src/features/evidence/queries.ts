import "server-only";
import { canAll, requireActor } from "@/lib/auth/session";
import { evidence } from "@/modules/evidence";
import { classificationLevels, staffDirectory } from "@/lib/reference";

/** Read models for the evidence register and the custody ledger (PRD 6). */

export async function listEvidence(params: {
  caseId?: string;
  search?: string;
  evidenceType?: string;
  status?: string;
  copyStatus?: string;
  integrityConcernsOnly?: boolean;
  page?: number;
  perPage?: number;
  onlyDeleted?: boolean;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const api = evidence(actor);
  const [result, summary, allowed] = await Promise.all([
    api.items.list({
      caseId: params.caseId,
      search: params.search,
      evidenceType: params.evidenceType as never,
      status: (params.status as never) ?? "all",
      copyStatus: params.copyStatus as never,
      integrityConcernsOnly: params.integrityConcernsOnly,
      onlyDeleted: params.onlyDeleted,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    api.items.summary({ caseId: params.caseId }),
    canAll(actor, [
      { resource: "evidence", action: "create" },
      { resource: "evidence", action: "edit" },
      { resource: "evidence", action: "upload" },
      { resource: "evidence", action: "download" },
      { resource: "evidence", action: "delete" },
      { resource: "custody", action: "create" },
    ]),
  ]);

  return {
    ...result,
    summary,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    can: {
      create: allowed["evidence:create"],
      edit: allowed["evidence:edit"],
      upload: allowed["evidence:upload"],
      download: allowed["evidence:download"],
      remove: allowed["evidence:delete"],
      recordCustody: allowed["custody:create"],
    },
  };
}

/** One item with its ledger, its checks, and whether the chain holds. */
export async function getEvidenceDetail(evidenceRecordId: string) {
  const actor = await requireActor();
  const api = evidence(actor);

  const item = await api.items.findById(evidenceRecordId);
  if (!item) return null;

  const [events, chain, checks, copies, allowed, directory, levels] =
    await Promise.all([
      api.custody.events(evidenceRecordId),
      api.custody.verifyChain(evidenceRecordId),
      api.items.integrityChecks(evidenceRecordId),
      // The working copies taken from this item, so an original says what has
      // been made from it.
      api.items.list({ originalEvidenceId: evidenceRecordId, limit: 50 }),
      canAll(actor, [
        { resource: "evidence", action: "edit" },
        { resource: "evidence", action: "create" },
        { resource: "evidence", action: "upload" },
        { resource: "evidence", action: "download" },
        { resource: "evidence", action: "delete" },
        { resource: "custody", action: "create" },
      ]),
      staffDirectory(actor),
      classificationLevels(actor),
    ]);

  return {
    item,
    events,
    chain,
    checks,
    workingCopies: copies.rows,
    levels,
    people: directory,
    actorId: actor.userId,
    can: {
      edit: allowed["evidence:edit"],
      create: allowed["evidence:create"],
      upload: allowed["evidence:upload"],
      download: allowed["evidence:download"],
      remove: allowed["evidence:delete"],
      recordCustody: allowed["custody:create"],
    },
  };
}

/** The case file's evidence tab. */
export async function getCaseEvidence(caseRecordId: string) {
  const actor = await requireActor();
  const api = evidence(actor);

  const [items, summary, allowed, directory, levels] = await Promise.all([
    api.items.list({ caseId: caseRecordId, limit: 200 }),
    api.items.summary({ caseId: caseRecordId }),
    canAll(actor, [
      { resource: "evidence", action: "create" },
      { resource: "evidence", action: "edit" },
      { resource: "evidence", action: "upload" },
      { resource: "evidence", action: "view" },
    ]),
    staffDirectory(actor),
    classificationLevels(actor),
  ]);

  return {
    items: items.rows,
    summary,
    levels,
    people: directory,
    actorId: actor.userId,
    can: {
      create: allowed["evidence:create"],
      edit: allowed["evidence:edit"],
      upload: allowed["evidence:upload"],
      view: allowed["evidence:view"],
    },
  };
}

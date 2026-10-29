import "server-only";
import { canAll, requireActor } from "@/lib/auth/session";
import { evidence } from "@/modules/evidence";
import { classificationLevels } from "@/lib/reference";

/** Read models for the case document screens (PRD 7). */

const DOCUMENT_PERMISSIONS = [
  { resource: "documents", action: "create" },
  { resource: "documents", action: "edit" },
  { resource: "documents", action: "upload" },
  { resource: "documents", action: "download" },
  { resource: "documents", action: "delete" },
] as const;

function documentAbilities(allowed: Record<string, boolean>) {
  return {
    create: allowed["documents:create"],
    edit: allowed["documents:edit"],
    upload: allowed["documents:upload"],
    download: allowed["documents:download"],
    remove: allowed["documents:delete"],
  };
}

export async function listDocuments(params: {
  caseId?: string;
  folderId?: string;
  search?: string;
  documentType?: string;
  tag?: string;
  approvedOnly?: boolean;
  onlyDeleted?: boolean;
  page?: number;
  perPage?: number;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const api = evidence(actor);
  const [result, summary, tags, allowed] = await Promise.all([
    api.documents.list({
      caseId: params.caseId,
      folderId: params.folderId,
      search: params.search,
      documentType: params.documentType as never,
      tag: params.tag,
      approvedOnly: params.approvedOnly,
      onlyDeleted: params.onlyDeleted,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    api.documents.summary({ caseId: params.caseId }),
    api.documents.tags(),
    canAll(actor, [...DOCUMENT_PERMISSIONS]),
  ]);

  return {
    ...result,
    summary,
    tags,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
    can: documentAbilities(allowed),
  };
}

/**
 * One document with its whole version history.
 *
 * The history is the point of the screen rather than a detail of it: PRD 7.2
 * makes an approved version immutable, so what a reader needs to see is which
 * version is in force, who approved it, and what every earlier one said.
 */
export async function getDocumentDetail(documentRecordId: string) {
  const actor = await requireActor();
  const api = evidence(actor);

  const document = await api.documents.findById(documentRecordId);
  if (!document) return null;

  const [versions, folders, tags, allowed, levels] = await Promise.all([
    api.documents.versions(documentRecordId),
    api.documents.folders(document.caseId),
    api.documents.tags(),
    canAll(actor, [...DOCUMENT_PERMISSIONS]),
    classificationLevels(actor),
  ]);

  return {
    document,
    versions,
    folders,
    tags,
    levels,
    actorId: actor.userId,
    can: documentAbilities(allowed),
  };
}

/** The case file's documents tab: the folder tree and what is filed in it. */
export async function getCaseDocuments(caseRecordId: string) {
  const actor = await requireActor();
  const api = evidence(actor);

  const [folders, documents, summary, tags, allowed, levels] = await Promise.all([
    api.documents.folders(caseRecordId),
    api.documents.list({ caseId: caseRecordId, limit: 200 }),
    api.documents.summary({ caseId: caseRecordId }),
    api.documents.tags(),
    canAll(actor, [...DOCUMENT_PERMISSIONS]),
    classificationLevels(actor),
  ]);

  return {
    // `folders()` counts its own documents in SQL, so there is nothing to
    // join up here.
    folders,
    documents: documents.rows,
    summary,
    tags,
    levels,
    actorId: actor.userId,
    can: documentAbilities(allowed),
  };
}

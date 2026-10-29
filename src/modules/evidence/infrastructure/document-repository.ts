import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { EvidenceError } from "../domain/errors";
import type { CaseDocument, CaseFolder, DocumentVersion } from "../domain/types";
import type {
  DocumentRepository,
  ListDocumentsFilter,
  Page,
} from "../application/ports";

/**
 * Case documents and their versions (PRD 7).
 *
 * A document is the thing; its versions are what it has been. The current
 * version is what every screen shows, the approved one is what a report may
 * rely on, and an approved version is frozen: a change produces the next
 * version with a recorded reason and needs approving again (PRD 7.2). The
 * database holds that last rule as a trigger, so it survives whatever reaches
 * the table.
 */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

interface VersionRow {
  id: string;
  document_id: string;
  version_no: number;
  version_label: string;
  change_note: string | null;
  file_name: string;
  mime_type: string;
  file_size: string;
  sha256: string;
  storage_bucket: string;
  storage_path: string;
  is_current: boolean;
  is_approved: boolean;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
}

function toVersion(row: VersionRow): DocumentVersion {
  return {
    id: row.id,
    documentId: row.document_id,
    versionNo: Number(row.version_no),
    versionLabel: row.version_label,
    changeNote: row.change_note,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    sha256: row.sha256,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    isCurrent: row.is_current,
    isApproved: row.is_approved,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
  };
}

const VERSION_SELECT = (sql: postgres.TransactionSql) => sql`
  select v.*,
         app.full_name as approved_by_name,
         aut.full_name as created_by_name
  from docs.document_versions v
  left join directory app on app.user_id = v.approved_by
  left join directory aut on aut.user_id = v.created_by
`;

interface DocumentRow {
  id: string;
  document_id: string;
  case_id: string;
  case_reference: string;
  folder_id: string | null;
  folder_name: string | null;
  title: string;
  document_type: CaseDocument["documentType"];
  classification: CaseDocument["classification"];
  current_version_id: string | null;
  approved_version_id: string | null;
  related_source_id: string | null;
  related_evidence_id: string | null;
  related_evidence_reference: string | null;
  related_task_id: string | null;
  related_task_title: string | null;
  tags: string[] | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: string;
  version: number;
  deleted_at: string | null;
  version_count: string;
}

function toDocument(row: DocumentRow, current: DocumentVersion | null): CaseDocument {
  return {
    id: row.id,
    documentId: row.document_id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    folderId: row.folder_id,
    folderName: row.folder_name,
    title: row.title,
    documentType: row.document_type,
    classification: row.classification,
    currentVersionId: row.current_version_id,
    approvedVersionId: row.approved_version_id,
    relatedSourceId: row.related_source_id,
    relatedEvidenceId: row.related_evidence_id,
    relatedEvidenceReference: row.related_evidence_reference,
    relatedTaskId: row.related_task_id,
    relatedTaskTitle: row.related_task_title,
    tags: row.tags ?? [],
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
    current,
    versionCount: Number(row.version_count ?? 0),
  };
}

function auditShape(row: DocumentRow) {
  return {
    documentId: row.document_id,
    title: row.title,
    documentType: row.document_type,
    classification: row.classification,
    folderId: row.folder_id,
  };
}

/**
 * The projection every document read shares.
 *
 * The tags come back as an aggregate rather than a second query, because a
 * list of twenty documents would otherwise be twenty more round trips to a
 * database 127ms away.
 */
const DOCUMENT_SELECT = (sql: postgres.TransactionSql) => sql`
  select d.*,
         c.case_id as case_reference,
         f.name as folder_name,
         ev.evidence_id as related_evidence_reference,
         t.title as related_task_title,
         aut.full_name as created_by_name,
         (
           select coalesce(array_agg(dt.tag_key order by dt.tag_key), '{}')
           from docs.document_tags dt where dt.document_id = d.id
         ) as tags,
         (
           select count(*) from docs.document_versions v
           where v.document_id = d.id
         ) as version_count
  from docs.documents d
  join casework.cases c on c.id = d.case_id
  left join docs.folders f on f.id = d.folder_id
  left join evidence.evidence_items ev on ev.id = d.related_evidence_id
  left join casework.tasks t on t.id = d.related_task_id
  left join directory aut on aut.user_id = d.created_by
`;

export function createDocumentRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): DocumentRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  const loadVersions = async (
    sql: postgres.TransactionSql,
    documentIds: string[],
  ): Promise<Map<string, DocumentVersion>> => {
    if (documentIds.length === 0) return new Map();

    const rows = await sql<VersionRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${VERSION_SELECT(sql)}
      where v.document_id = any(${documentIds}::uuid[]) and v.is_current
    `;
    return new Map(rows.map((row) => [row.document_id, toVersion(row)]));
  };

  const load = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<CaseDocument | null> => {
    const rows = await sql<DocumentRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${DOCUMENT_SELECT(sql)}
      where d.id = ${id}::uuid
    `;
    if (rows.length === 0) return null;

    const current = await loadVersions(sql, [rows[0].id]);
    return toDocument(rows[0], current.get(rows[0].id) ?? null);
  };

  return {
    async folders(caseId): Promise<CaseFolder[]> {
      return tx(async (sql) => {
        const rows = await sql<
          {
            id: string;
            case_id: string;
            key: string;
            name: string;
            position: number;
            is_system: boolean;
            document_count: string;
          }[]
        >`
          select f.*,
                 (
                   select count(*) from docs.documents d
                   where d.folder_id = f.id and d.deleted_at is null
                 ) as document_count
          from docs.folders f
          where f.case_id = ${caseId}::uuid
          order by f.position
        `;

        return rows.map((row) => ({
          id: row.id,
          caseId: row.case_id,
          key: row.key,
          name: row.name,
          position: Number(row.position),
          isSystem: row.is_system,
          documentCount: Number(row.document_count ?? 0),
        }));
      });
    },

    async list(filter: ListDocumentsFilter): Promise<Page<CaseDocument>> {
      const limit = Math.min(filter.limit ?? 50, 200);
      const offset = Math.max(filter.offset ?? 0, 0);

      return tx(async (sql) => {
        const rows = await sql<(DocumentRow & { total_count: string })[]>`
          with directory as (${DIRECTORY(sql)}),
          filtered as (
            ${DOCUMENT_SELECT(sql)}
            where (
                    ${filter.onlyDeleted ?? false} and d.deleted_at is not null
                    or ${filter.includeDeleted ?? false}
                    or (not ${filter.onlyDeleted ?? false} and d.deleted_at is null)
                  )
              and (${filter.caseId ?? null}::uuid is null or d.case_id = ${filter.caseId ?? null}::uuid)
              and (${filter.folderId ?? null}::uuid is null or d.folder_id = ${filter.folderId ?? null}::uuid)
              and (${filter.documentType ?? null}::text is null or d.document_type = ${filter.documentType ?? null})
              and (not ${filter.approvedOnly ?? false} or d.approved_version_id is not null)
              and (
                ${filter.tag ?? null}::text is null
                or exists (
                  select 1 from docs.document_tags dt
                  where dt.document_id = d.id and dt.tag_key = ${filter.tag ?? null}
                )
              )
              and (
                ${filter.search ?? null}::text is null
                or d.title ilike '%' || ${filter.search ?? ""} || '%'
                or d.document_id ilike '%' || ${filter.search ?? ""} || '%'
              )
          )
          select f.*, count(*) over () as total_count
          from filtered f
          order by f.created_at desc
          limit ${limit} offset ${offset}
        `;

        const current = await loadVersions(
          sql,
          rows.map((row) => row.id),
        );

        return {
          rows: rows.map((row) => toDocument(row, current.get(row.id) ?? null)),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async findById(id) {
      return tx((sql) => load(sql, id));
    },

    async versions(documentId): Promise<DocumentVersion[]> {
      return tx(async (sql) => {
        const rows = await sql<VersionRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${VERSION_SELECT(sql)}
          where v.document_id = ${documentId}::uuid
          order by v.version_no desc
        `;
        return rows.map(toVersion);
      });
    },

    async create(input): Promise<CaseDocument> {
      return tx(async (sql) => {
        const docs = await sql<{ id: string; document_id: string }[]>`
          insert into docs.documents (
            case_id, folder_id, title, document_type, classification,
            related_source_id, related_evidence_id, related_task_id, created_by
          ) values (
            ${input.caseId}::uuid, ${input.folderId ?? null}::uuid,
            ${input.title}, ${input.documentType}, ${input.classification},
            ${input.relatedSourceId ?? null}::uuid,
            ${input.relatedEvidenceId ?? null}::uuid,
            ${input.relatedTaskId ?? null}::uuid,
            ${actor.userId}::uuid
          )
          returning id, document_id
        `;
        const documentId = docs[0].id;

        const versions = await sql<{ id: string }[]>`
          insert into docs.document_versions (
            document_id, version_no, version_label, change_note, file_name,
            mime_type, file_size, sha256, storage_bucket, storage_path,
            is_current, created_by
          ) values (
            ${documentId}::uuid, 1, ${input.version.versionLabel},
            ${input.version.changeNote ?? null}, ${input.version.fileName},
            ${input.version.mimeType}, ${input.version.fileSize},
            ${input.version.sha256}, ${input.version.storageBucket},
            ${input.version.storagePath}, true, ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          update docs.documents
          set current_version_id = ${versions[0].id}::uuid
          where id = ${documentId}::uuid
        `;

        for (const tag of input.tags ?? []) {
          await sql`
            insert into docs.tags (key, name) values (${tag}, ${tag})
            on conflict (key) do nothing
          `;
          await sql`
            insert into docs.document_tags (document_id, tag_key)
            values (${documentId}::uuid, ${tag})
            on conflict do nothing
          `;
        }

        await sql`
          select audit.write(
            'document.created', 'docs.documents', ${documentId},
            ${input.caseId}::uuid, null,
            ${sql.json({
              documentId: docs[0].document_id,
              title: input.title,
              documentType: input.documentType,
              versionLabel: input.version.versionLabel,
              sha256: input.version.sha256,
            })},
            null, ${input.classification}
          )
        `;

        const created = await load(sql, documentId);
        if (!created) {
          throw new EvidenceError(
            "not_found",
            "The document could not be read back after saving.",
          );
        }
        return created;
      });
    },

    async update(id, input, expectedVersion) {
      return tx(async (sql) => {
        const before = await sql<DocumentRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${DOCUMENT_SELECT(sql)}
          where d.id = ${id}::uuid and d.deleted_at is null
        `;
        if (before.length === 0) {
          throw new EvidenceError("not_found", "That document no longer exists.");
        }
        if (before[0].version !== expectedVersion) {
          throw new EvidenceError(
            "stale_version",
            "This document changed since you opened it. Reload and try again.",
            { expected: expectedVersion, actual: before[0].version },
          );
        }

        const updated = await sql<{ id: string }[]>`
          update docs.documents set
            title = coalesce(${input.title ?? null}, title),
            folder_id = ${input.folderId === undefined ? sql`folder_id` : sql`${input.folderId}::uuid`},
            document_type = coalesce(${input.documentType ?? null}, document_type),
            classification = coalesce(${input.classification ?? null}, classification),
            related_source_id = ${input.relatedSourceId === undefined ? sql`related_source_id` : sql`${input.relatedSourceId}::uuid`},
            related_evidence_id = ${input.relatedEvidenceId === undefined ? sql`related_evidence_id` : sql`${input.relatedEvidenceId}::uuid`},
            related_task_id = ${input.relatedTaskId === undefined ? sql`related_task_id` : sql`${input.relatedTaskId}::uuid`},
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${expectedVersion}
          returning id
        `;
        if (updated.length === 0) {
          throw new EvidenceError(
            "stale_version",
            "This document changed while saving. Reload and try again.",
          );
        }

        if (input.tags) {
          await sql`
            delete from docs.document_tags where document_id = ${id}::uuid
          `;
          for (const tag of input.tags) {
            await sql`
              insert into docs.tags (key, name) values (${tag}, ${tag})
              on conflict (key) do nothing
            `;
            await sql`
              insert into docs.document_tags (document_id, tag_key)
              values (${id}::uuid, ${tag})
            `;
          }
        }

        const after = await sql<DocumentRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${DOCUMENT_SELECT(sql)}
          where d.id = ${id}::uuid
        `;

        await sql`
          select audit.write(
            'document.updated', 'docs.documents', ${id},
            ${before[0].case_id}::uuid,
            ${sql.json(auditShape(before[0]))},
            ${sql.json(auditShape(after[0]))},
            null, ${after[0].classification}
          )
        `;

        const result = await load(sql, id);
        if (!result) {
          throw new EvidenceError(
            "not_found",
            "The document could not be read back after saving.",
          );
        }
        return result;
      });
    },

    async addVersion(input): Promise<DocumentVersion> {
      return tx(async (sql) => {
        const doc = await sql<
          { case_id: string; classification: string; document_id: string }[]
        >`
          select case_id, classification, document_id from docs.documents
          where id = ${input.documentId}::uuid and deleted_at is null
        `;
        if (doc.length === 0) {
          throw new EvidenceError("not_found", "That document no longer exists.");
        }

        // The next number comes from the table, not from the caller: two
        // uploads a moment apart would otherwise race for the same one, and
        // the unique constraint would refuse the second with a message about
        // a constraint rather than about the upload.
        const next = await sql<{ next_no: number }[]>`
          select coalesce(max(version_no), 0) + 1 as next_no
          from docs.document_versions
          where document_id = ${input.documentId}::uuid
        `;

        // Only one version is current, which a partial unique index enforces,
        // so the old one is stood down first.
        await sql`
          update docs.document_versions set is_current = false
          where document_id = ${input.documentId}::uuid and is_current
        `;

        const rows = await sql<{ id: string }[]>`
          insert into docs.document_versions (
            document_id, version_no, version_label, change_note, file_name,
            mime_type, file_size, sha256, storage_bucket, storage_path,
            is_current, created_by
          ) values (
            ${input.documentId}::uuid, ${next[0].next_no}, ${input.versionLabel},
            ${input.changeNote ?? null}, ${input.fileName}, ${input.mimeType},
            ${input.fileSize}, ${input.sha256}, ${input.storageBucket},
            ${input.storagePath}, true, ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          update docs.documents
          set current_version_id = ${rows[0].id}::uuid,
              updated_by = ${actor.userId}::uuid
          where id = ${input.documentId}::uuid
        `;

        await sql`
          select audit.write(
            'document.version_added', 'docs.document_versions', ${rows[0].id},
            ${doc[0].case_id}::uuid, null,
            ${sql.json({
              documentId: doc[0].document_id,
              versionLabel: input.versionLabel,
              sha256: input.sha256,
            })},
            ${input.changeNote ?? null}, ${doc[0].classification}
          )
        `;

        const created = await sql<VersionRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${VERSION_SELECT(sql)}
          where v.id = ${rows[0].id}::uuid
        `;
        return toVersion(created[0]);
      });
    },

    async approveVersion(versionId): Promise<DocumentVersion> {
      return tx(async (sql) => {
        const version = await sql<
          {
            document_id: string;
            is_approved: boolean;
            version_label: string;
            case_id: string;
            classification: string;
          }[]
        >`
          select v.document_id, v.is_approved, v.version_label,
                 d.case_id, d.classification
          from docs.document_versions v
          join docs.documents d on d.id = v.document_id
          where v.id = ${versionId}::uuid
        `;
        if (version.length === 0) {
          throw new EvidenceError("not_found", "That version no longer exists.");
        }
        if (version[0].is_approved) {
          throw new EvidenceError(
            "conflict",
            `${version[0].version_label} is already approved.`,
          );
        }

        await sql`
          update docs.document_versions set
            is_approved = true,
            approved_by = ${actor.userId}::uuid,
            approved_at = now()
          where id = ${versionId}::uuid
        `;

        await sql`
          update docs.documents set
            approved_version_id = ${versionId}::uuid,
            updated_by = ${actor.userId}::uuid
          where id = ${version[0].document_id}::uuid
        `;

        await sql`
          select audit.write(
            'document.version_approved', 'docs.document_versions', ${versionId},
            ${version[0].case_id}::uuid, null,
            ${sql.json({ versionLabel: version[0].version_label })},
            'approved and locked against further change (PRD 7.2)',
            ${version[0].classification}
          )
        `;

        const after = await sql<VersionRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${VERSION_SELECT(sql)}
          where v.id = ${versionId}::uuid
        `;
        return toVersion(after[0]);
      });
    },

    async softDelete(id, reason) {
      await tx(async (sql) => {
        const existing = await sql<{ case_id: string; classification: string }[]>`
          select case_id, classification from docs.documents
          where id = ${id}::uuid and deleted_at is null
        `;
        const result = await sql`
          update docs.documents
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (existing.length === 0 || result.count === 0) {
          throw new EvidenceError("not_found", "That document no longer exists.");
        }

        await sql`
          select audit.write(
            'document.removed', 'docs.documents', ${id},
            ${existing[0].case_id}::uuid, null, null, ${reason},
            ${existing[0].classification}
          )
        `;
      });
    },

    async restore(id, reason) {
      await tx(async (sql) => {
        const existing = await sql<{ case_id: string; classification: string }[]>`
          select case_id, classification from docs.documents
          where id = ${id}::uuid and deleted_at is not null
        `;
        const result = await sql`
          update docs.documents
          set deleted_at = null, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is not null
        `;
        if (existing.length === 0 || result.count === 0) {
          throw new EvidenceError(
            "not_found",
            "That document is not in the recycle bin.",
          );
        }

        await sql`
          select audit.write(
            'document.restored', 'docs.documents', ${id},
            ${existing[0].case_id}::uuid, null, null, ${reason},
            ${existing[0].classification}
          )
        `;
      });
    },

    async tags() {
      return tx(async (sql) => {
        const rows = await sql<{ key: string; name: string }[]>`
          select key, name from docs.tags order by name
        `;
        return rows.map((row) => ({ key: row.key, name: row.name }));
      });
    },

    async upsertTag(key, name) {
      await tx(async (sql) => {
        await sql`
          insert into docs.tags (key, name) values (${key}, ${name})
          on conflict (key) do update set name = excluded.name
        `;
      });
    },

    async summary(filter) {
      return tx(async (sql) => {
        const [totals] = await sql<
          { total: string; approved: string; drafts: string }[]
        >`
          select
            count(*) as total,
            count(*) filter (where approved_version_id is not null) as approved,
            count(*) filter (where approved_version_id is null) as drafts
          from docs.documents
          where deleted_at is null
            and (${filter.caseId ?? null}::uuid is null or case_id = ${filter.caseId ?? null}::uuid)
        `;

        const byFolder = await sql<{ folder_id: string; documents: string }[]>`
          select folder_id, count(*) as documents
          from docs.documents
          where deleted_at is null and folder_id is not null
            and (${filter.caseId ?? null}::uuid is null or case_id = ${filter.caseId ?? null}::uuid)
          group by folder_id
        `;

        return {
          total: Number(totals?.total ?? 0),
          approved: Number(totals?.approved ?? 0),
          drafts: Number(totals?.drafts ?? 0),
          byFolder: byFolder.map((row) => ({
            folderId: row.folder_id,
            documents: Number(row.documents),
          })),
        };
      });
    },
  };
}

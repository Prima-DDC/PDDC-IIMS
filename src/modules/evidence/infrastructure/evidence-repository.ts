import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { EvidenceError } from "../domain/errors";
import { integrityVerdict } from "../domain/policies";
import type { CustodyEvent, EvidenceItem, IntegrityCheck } from "../domain/types";
import type {
  CustodyRepository,
  EvidenceRepository,
  ListEvidenceFilter,
  Page,
  RegisterEvidenceInput,
} from "../application/ports";

/**
 * The evidence register and the chain of custody (PRD 6).
 *
 * Two repositories in one file because they are two halves of one thing: an
 * item without its ledger has a chain that starts nowhere, and registering an
 * item writes its first custody event in the same transaction.
 *
 * There is no `update` and no `delete` on custody events, deliberately. PRD
 * 6.2 makes the ledger append-only for every role, the database refuses the
 * mutation with a trigger, and no policy would let the application reach the
 * trigger. A correction is a new event pointing at the original.
 */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

interface EvidenceRow {
  id: string;
  evidence_id: string;
  case_id: string;
  case_reference: string;
  exhibit_no: string | null;
  evidence_type: EvidenceItem["evidenceType"];
  description: string;
  source_id: string | null;
  collected_by: string;
  collected_by_name: string | null;
  collected_at: string;
  collection_location: string;
  collection_method: string;
  copy_status: EvidenceItem["copyStatus"];
  original_evidence_id: string | null;
  original_evidence_reference: string | null;
  working_copy_count: string;
  file_name: string | null;
  file_type: string | null;
  file_size: string | null;
  declared_sha256: string | null;
  computed_sha256: string | null;
  integrity_status: EvidenceItem["integrityStatus"];
  verified_at: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  classification: EvidenceItem["classification"];
  current_custodian: string | null;
  current_custodian_name: string | null;
  status: EvidenceItem["status"];
  created_at: string;
  created_by: string | null;
  updated_at: string;
  version: number;
  deleted_at: string | null;
  custody_event_count: string;
}

function toItem(row: EvidenceRow): EvidenceItem {
  return {
    id: row.id,
    evidenceId: row.evidence_id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    exhibitNo: row.exhibit_no,
    evidenceType: row.evidence_type,
    description: row.description,
    sourceId: row.source_id,
    collectedBy: row.collected_by,
    collectedByName: row.collected_by_name,
    collectedAt: row.collected_at,
    collectionLocation: row.collection_location,
    collectionMethod: row.collection_method,
    copyStatus: row.copy_status,
    originalEvidenceId: row.original_evidence_id,
    originalEvidenceReference: row.original_evidence_reference,
    workingCopyCount: Number(row.working_copy_count ?? 0),
    fileName: row.file_name,
    fileType: row.file_type,
    fileSize: row.file_size === null ? null : Number(row.file_size),
    declaredSha256: row.declared_sha256,
    computedSha256: row.computed_sha256,
    integrityStatus: row.integrity_status,
    verifiedAt: row.verified_at,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    classification: row.classification,
    currentCustodian: row.current_custodian,
    currentCustodianName: row.current_custodian_name,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
    custodyEventCount: Number(row.custody_event_count ?? 0),
  };
}

function auditShape(row: EvidenceRow) {
  return {
    evidenceId: row.evidence_id,
    evidenceType: row.evidence_type,
    description: row.description,
    exhibitNo: row.exhibit_no,
    classification: row.classification,
    status: row.status,
    currentCustodian: row.current_custodian,
    integrityStatus: row.integrity_status,
  };
}

const EVIDENCE_SELECT = (sql: postgres.TransactionSql) => sql`
  select e.*,
         c.case_id as case_reference,
         orig.evidence_id as original_evidence_reference,
         col.full_name as collected_by_name,
         cus.full_name as current_custodian_name,
         (
           select count(*) from evidence.evidence_items copy
           where copy.original_evidence_id = e.id and copy.deleted_at is null
         ) as working_copy_count,
         (
           select count(*) from evidence.custody_events ce
           where ce.evidence_item_id = e.id
         ) as custody_event_count
  from evidence.evidence_items e
  join casework.cases c on c.id = e.case_id
  left join evidence.evidence_items orig on orig.id = e.original_evidence_id
  left join directory col on col.user_id = e.collected_by
  left join directory cus on cus.user_id = e.current_custodian
`;

/* ------------------------------------------------------------- custody */

interface CustodyRow {
  id: string;
  evidence_item_id: string;
  event_type: CustodyEvent["eventType"];
  occurred_at: string;
  released_by: string | null;
  released_by_name: string | null;
  received_by: string | null;
  received_by_name: string | null;
  purpose: string;
  location: string | null;
  condition: string | null;
  confirmation: string | null;
  corrects_event_id: string | null;
  correction_reason: string | null;
  corrected_by_event_id: string | null;
  recorded_at: string;
  recorded_by: string;
  recorded_by_name: string | null;
  seq: string;
  prev_hash: string;
  row_hash: string;
}

function toEvent(row: CustodyRow): CustodyEvent {
  return {
    id: row.id,
    evidenceItemId: row.evidence_item_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    releasedBy: row.released_by,
    releasedByName: row.released_by_name,
    receivedBy: row.received_by,
    receivedByName: row.received_by_name,
    purpose: row.purpose,
    location: row.location,
    condition: row.condition,
    confirmation: row.confirmation,
    correctsEventId: row.corrects_event_id,
    correctionReason: row.correction_reason,
    correctedByEventId: row.corrected_by_event_id,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
    recordedByName: row.recorded_by_name,
    seq: String(row.seq),
    prevHash: row.prev_hash,
    rowHash: row.row_hash,
  };
}

/**
 * The projection every custody read shares.
 *
 * `corrected_by` is a reverse lookup, as the activity log's is: an event does
 * not know it has been corrected, so the event that corrects it is found by
 * looking for one that points back. Without it the ledger would show a
 * superseded event as though it still stood.
 */
const CUSTODY_SELECT = (sql: postgres.TransactionSql) => sql`
  select ce.*,
         fix.id as corrected_by_event_id,
         rel.full_name as released_by_name,
         rec.full_name as received_by_name,
         rby.full_name as recorded_by_name
  from evidence.custody_events ce
  left join evidence.custody_events fix on fix.corrects_event_id = ce.id
  left join directory rel on rel.user_id = ce.released_by
  left join directory rec on rec.user_id = ce.received_by
  left join directory rby on rby.user_id = ce.recorded_by
`;

export function createEvidenceRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): EvidenceRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  const load = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<EvidenceItem | null> => {
    const rows = await sql<EvidenceRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${EVIDENCE_SELECT(sql)}
      where e.id = ${id}::uuid
    `;
    return rows.length > 0 ? toItem(rows[0]) : null;
  };

  const readBack = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<EvidenceItem> => {
    const item = await load(sql, id);
    if (!item) {
      throw new EvidenceError(
        "not_found",
        "The evidence item could not be read back after saving.",
      );
    }
    return item;
  };

  return {
    async list(filter: ListEvidenceFilter): Promise<Page<EvidenceItem>> {
      const limit = Math.min(filter.limit ?? 50, 200);
      const offset = Math.max(filter.offset ?? 0, 0);
      const sort = filter.sort ?? "collected";

      return tx(async (sql) => {
        const rows = await sql<(EvidenceRow & { total_count: string })[]>`
          with directory as (${DIRECTORY(sql)}),
          filtered as (
            ${EVIDENCE_SELECT(sql)}
            where (
                    ${filter.onlyDeleted ?? false} and e.deleted_at is not null
                    or ${filter.includeDeleted ?? false}
                    or (not ${filter.onlyDeleted ?? false} and e.deleted_at is null)
                  )
              and (${filter.caseId ?? null}::uuid is null or e.case_id = ${filter.caseId ?? null}::uuid)
              and (${filter.evidenceType ?? null}::text is null or e.evidence_type = ${filter.evidenceType ?? null})
              and (${filter.status ?? "all"} = 'all' or e.status = ${filter.status ?? "all"})
              and (${filter.copyStatus ?? null}::text is null or e.copy_status = ${filter.copyStatus ?? null})
              and (${filter.custodian ?? null}::uuid is null or e.current_custodian = ${filter.custodian ?? null}::uuid)
              and (
                ${filter.originalEvidenceId ?? null}::uuid is null
                or e.original_evidence_id = ${filter.originalEvidenceId ?? null}::uuid
              )
              and (
                not ${filter.integrityConcernsOnly ?? false}
                or e.integrity_status in ('hash_unverified', 'mismatch')
              )
              and (
                ${filter.search ?? null}::text is null
                or e.evidence_id ilike '%' || ${filter.search ?? ""} || '%'
                or e.description ilike '%' || ${filter.search ?? ""} || '%'
                or coalesce(e.exhibit_no, '') ilike '%' || ${filter.search ?? ""} || '%'
                or coalesce(e.file_name, '') ilike '%' || ${filter.search ?? ""} || '%'
              )
          )
          select f.*, count(*) over () as total_count
          from filtered f
          order by
            case when ${sort} = 'exhibit' then f.exhibit_no end nulls last,
            case when ${sort} = 'type' then f.evidence_type end,
            case when ${sort} = 'registered' then f.created_at end desc,
            case when ${sort} = 'collected' then f.collected_at end desc,
            f.created_at desc
          limit ${limit} offset ${offset}
        `;

        return {
          rows: rows.map(toItem),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async findById(id) {
      return tx((sql) => load(sql, id));
    },

    async findByEvidenceId(evidenceId) {
      return tx(async (sql) => {
        const rows = await sql<EvidenceRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${EVIDENCE_SELECT(sql)}
          where e.evidence_id = ${evidenceId}
        `;
        return rows.length > 0 ? toItem(rows[0]) : null;
      });
    },

    async register(input: RegisterEvidenceInput): Promise<EvidenceItem> {
      return tx(async (sql) => {
        const rows = await sql<{ id: string; evidence_id: string }[]>`
          insert into evidence.evidence_items (
            evidence_id, case_id, exhibit_no, evidence_type, description,
            source_id, collected_by, collected_at, collection_location,
            collection_method, copy_status, original_evidence_id,
            classification, current_custodian, created_by
          ) values (
            evidence.next_evidence_id(${input.caseId}::uuid),
            ${input.caseId}::uuid, ${input.exhibitNo ?? null},
            ${input.evidenceType}, ${input.description},
            ${input.sourceId ?? null}::uuid, ${input.collectedBy}::uuid,
            ${input.collectedAt}::timestamptz, ${input.collectionLocation},
            ${input.collectionMethod}, ${input.copyStatus ?? "original"},
            ${input.originalEvidenceId ?? null}::uuid, ${input.classification},
            ${input.currentCustodian ?? input.collectedBy}::uuid,
            ${actor.userId}::uuid
          )
          returning id, evidence_id
        `;

        // The first custody event, in the same transaction. PRD 6.2 makes
        // registration an event, and an item whose ledger starts later has a
        // gap at exactly the point that matters most.
        await sql`
          insert into evidence.custody_events (
            evidence_item_id, event_type, occurred_at, received_by, purpose,
            location, condition, recorded_by
          ) values (
            ${rows[0].id}::uuid,
            ${input.copyStatus === "working_copy" ? "copied" : "registered"},
            ${input.collectedAt}::timestamptz,
            ${input.currentCustodian ?? input.collectedBy}::uuid,
            ${
              input.copyStatus === "working_copy"
                ? "Working copy taken for examination"
                : "Collected and registered in the evidence register"
            },
            ${input.collectionLocation}, 'As collected',
            ${actor.userId}::uuid
          )
        `;

        await sql`
          select audit.write(
            'evidence.registered', 'evidence.evidence_items', ${rows[0].id},
            ${input.caseId}::uuid, null,
            ${sql.json({
              evidenceId: rows[0].evidence_id,
              evidenceType: input.evidenceType,
              copyStatus: input.copyStatus ?? "original",
            })},
            null, ${input.classification}
          )
        `;

        return readBack(sql, rows[0].id);
      });
    },

    async update(id, input, expectedVersion) {
      return tx(async (sql) => {
        const before = await sql<EvidenceRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${EVIDENCE_SELECT(sql)}
          where e.id = ${id}::uuid and e.deleted_at is null
        `;
        if (before.length === 0) {
          throw new EvidenceError("not_found", "That evidence item no longer exists.");
        }
        if (before[0].version !== expectedVersion) {
          throw new EvidenceError(
            "stale_version",
            "This item changed since you opened it. Reload and try again.",
            { expected: expectedVersion, actual: before[0].version },
          );
        }

        const updated = await sql<{ id: string }[]>`
          update evidence.evidence_items set
            description = coalesce(${input.description ?? null}, description),
            exhibit_no = ${input.exhibitNo === undefined ? sql`exhibit_no` : input.exhibitNo},
            evidence_type = coalesce(${input.evidenceType ?? null}, evidence_type),
            classification = coalesce(${input.classification ?? null}, classification),
            source_id = ${input.sourceId === undefined ? sql`source_id` : sql`${input.sourceId}::uuid`},
            collection_location = coalesce(${input.collectionLocation ?? null}, collection_location),
            collection_method = coalesce(${input.collectionMethod ?? null}, collection_method),
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${expectedVersion}
          returning id
        `;
        if (updated.length === 0) {
          throw new EvidenceError(
            "stale_version",
            "This item changed while saving. Reload and try again.",
          );
        }

        const after = await sql<EvidenceRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${EVIDENCE_SELECT(sql)}
          where e.id = ${id}::uuid
        `;

        await sql`
          select audit.write(
            'evidence.updated', 'evidence.evidence_items', ${id},
            ${before[0].case_id}::uuid,
            ${sql.json(auditShape(before[0]))},
            ${sql.json(auditShape(after[0]))},
            null, ${after[0].classification}
          )
        `;

        return toItem(after[0]);
      });
    },

    async attachFile(id, input) {
      return tx(async (sql) => {
        const before = await sql<
          {
            case_id: string;
            copy_status: string;
            storage_path: string | null;
            classification: string;
            evidence_id: string;
          }[]
        >`
          select case_id, copy_status, storage_path, classification, evidence_id
          from evidence.evidence_items
          where id = ${id}::uuid and deleted_at is null
        `;
        if (before.length === 0) {
          throw new EvidenceError("not_found", "That evidence item no longer exists.");
        }
        // Refused here as well as by the domain rule, because this check reads
        // the row in the same transaction as the write: an original that
        // acquired a file a moment ago is caught.
        if (before[0].copy_status === "original" && before[0].storage_path !== null) {
          throw new EvidenceError(
            "original_immutable",
            `${before[0].evidence_id} is an original with a file already attached. An original is write-once: take a working copy and work on that.`,
          );
        }

        await sql`
          update evidence.evidence_items set
            file_name = ${input.fileName},
            file_type = ${input.fileType},
            file_size = ${input.fileSize},
            declared_sha256 = ${input.declaredSha256},
            storage_bucket = ${input.storageBucket},
            storage_path = ${input.storagePath},
            integrity_status = 'hash_unverified',
            computed_sha256 = null,
            verified_at = null,
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid
        `;

        await sql`
          select audit.write(
            'evidence.file_attached', 'evidence.evidence_items', ${id},
            ${before[0].case_id}::uuid, null,
            ${sql.json({
              fileName: input.fileName,
              fileSize: input.fileSize,
              declaredSha256: input.declaredSha256,
              storagePath: input.storagePath,
            })},
            'declared by the browser, not yet verified by the server',
            ${before[0].classification}
          )
        `;

        return readBack(sql, id);
      });
    },

    async recordVerification(input) {
      return tx(async (sql) => {
        const before = await sql<
          {
            case_id: string;
            declared_sha256: string | null;
            classification: string;
            evidence_id: string;
          }[]
        >`
          select case_id, declared_sha256, classification, evidence_id
          from evidence.evidence_items
          where id = ${input.id}::uuid
        `;
        if (before.length === 0) {
          throw new EvidenceError("not_found", "That evidence item no longer exists.");
        }
        const declared = before[0].declared_sha256;
        if (!declared) {
          throw new EvidenceError(
            "validation_failed",
            "That item has no declared hash, so there is nothing to verify it against.",
          );
        }

        const verdict =
          input.result === "unreadable"
            ? "hash_unverified"
            : integrityVerdict(declared, input.computedSha256);

        await sql`
          update evidence.evidence_items set
            computed_sha256 = ${input.computedSha256 ?? null},
            integrity_status = ${verdict},
            verified_at = ${
              verdict === "verified" || verdict === "mismatch" ? sql`now()` : null
            },
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid
        `;

        // The check is kept whether it matched or not (PRD 6.3). An append-only
        // row, so a mismatch cannot later be tidied away.
        await sql`
          insert into evidence.integrity_checks (
            evidence_item_id, expected_sha256, actual_sha256, result,
            checked_by, notes
          ) values (
            ${input.id}::uuid, ${declared}, ${input.computedSha256 ?? null},
            ${input.result}, ${actor.userId}::uuid, ${input.notes ?? null}
          )
        `;

        await sql`
          select audit.write(
            ${input.result === "mismatch" ? "evidence.integrity_mismatch" : "evidence.verified"},
            'evidence.evidence_items', ${input.id},
            ${before[0].case_id}::uuid, null,
            ${sql.json({
              expected: declared,
              actual: input.computedSha256 ?? null,
              result: input.result,
            })},
            ${input.notes ?? null}, ${before[0].classification}
          )
        `;

        return readBack(sql, input.id);
      });
    },

    async setStatus(input) {
      return tx(async (sql) => {
        const before = await sql<
          { case_id: string; status: string; classification: string }[]
        >`
          select case_id, status, classification from evidence.evidence_items
          where id = ${input.id}::uuid and deleted_at is null
        `;
        if (before.length === 0) {
          throw new EvidenceError("not_found", "That evidence item no longer exists.");
        }

        await sql`
          update evidence.evidence_items set
            status = ${input.status},
            current_custodian = ${
              input.custodian === undefined
                ? sql`current_custodian`
                : sql`${input.custodian}::uuid`
            },
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid
        `;

        await sql`
          select audit.write(
            'evidence.status_changed', 'evidence.evidence_items', ${input.id},
            ${before[0].case_id}::uuid,
            ${sql.json({ status: before[0].status })},
            ${sql.json({ status: input.status })},
            null, ${before[0].classification}
          )
        `;

        return readBack(sql, input.id);
      });
    },

    async softDelete(id, reason) {
      await tx(async (sql) => {
        // Read first, write second: a soft delete cannot return the row,
        // because the SELECT policy applied to the new row excludes it. The
        // lesson of migration 0033.
        const existing = await sql<{ case_id: string; classification: string }[]>`
          select case_id, classification from evidence.evidence_items
          where id = ${id}::uuid and deleted_at is null
        `;
        const result = await sql`
          update evidence.evidence_items
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (existing.length === 0 || result.count === 0) {
          throw new EvidenceError("not_found", "That evidence item no longer exists.");
        }

        await sql`
          select audit.write(
            'evidence.removed', 'evidence.evidence_items', ${id},
            ${existing[0].case_id}::uuid, null, null, ${reason},
            ${existing[0].classification}
          )
        `;
      });
    },

    async restore(id, reason) {
      await tx(async (sql) => {
        const existing = await sql<{ case_id: string; classification: string }[]>`
          select case_id, classification from evidence.evidence_items
          where id = ${id}::uuid and deleted_at is not null
        `;
        const result = await sql`
          update evidence.evidence_items
          set deleted_at = null, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is not null
        `;
        if (existing.length === 0 || result.count === 0) {
          throw new EvidenceError("not_found", "That item is not in the recycle bin.");
        }

        await sql`
          select audit.write(
            'evidence.restored', 'evidence.evidence_items', ${id},
            ${existing[0].case_id}::uuid, null, null, ${reason},
            ${existing[0].classification}
          )
        `;
      });
    },

    async integrityChecks(id): Promise<IntegrityCheck[]> {
      return tx(async (sql) => {
        const rows = await sql<
          {
            id: string;
            evidence_item_id: string;
            checked_at: string;
            expected_sha256: string;
            actual_sha256: string | null;
            result: IntegrityCheck["result"];
            checked_by: string | null;
            checked_by_name: string | null;
            notes: string | null;
          }[]
        >`
          with directory as (${DIRECTORY(sql)})
          select ic.*, dir.full_name as checked_by_name
          from evidence.integrity_checks ic
          left join directory dir on dir.user_id = ic.checked_by
          where ic.evidence_item_id = ${id}::uuid
          order by ic.seq desc
        `;

        return rows.map((row) => ({
          id: row.id,
          evidenceItemId: row.evidence_item_id,
          checkedAt: row.checked_at,
          expectedSha256: row.expected_sha256,
          actualSha256: row.actual_sha256,
          result: row.result,
          checkedBy: row.checked_by,
          checkedByName: row.checked_by_name,
          notes: row.notes,
        }));
      });
    },

    /**
     * The tab bar's evidence and document figures, in one statement.
     *
     * Deliberately spans both of this module's schemas: they are one module
     * because they share the same two problems, and a page asking for two
     * connections where one will do is a page that queues at the pooler.
     */
    async tabCounts(caseId) {
      return tx(async (sql) => {
        const [row] = await sql<
          {
            evidence: string;
            concerns: string;
            documents: string;
            drafts: string;
          }[]
        >`
          select
            (
              select count(*) from evidence.evidence_items e
              where e.case_id = ${caseId}::uuid and e.deleted_at is null
            ) as evidence,
            (
              select count(*) from evidence.evidence_items e
              where e.case_id = ${caseId}::uuid and e.deleted_at is null
                and e.integrity_status in ('hash_unverified', 'mismatch')
            ) as concerns,
            (
              select count(*) from docs.documents d
              where d.case_id = ${caseId}::uuid and d.deleted_at is null
            ) as documents,
            (
              select count(*) from docs.documents d
              where d.case_id = ${caseId}::uuid and d.deleted_at is null
                and d.approved_version_id is null
            ) as drafts
        `;

        return {
          evidence: Number(row.evidence),
          evidenceConcerns: Number(row.concerns),
          documents: Number(row.documents),
          documentsAwaitingApproval: Number(row.drafts),
        };
      });
    },

    async summary(filter) {
      return tx(async (sql) => {
        const rows = await sql<
          {
            total: string;
            originals: string;
            working_copies: string;
            awaiting: string;
            mismatched: string;
            released: string;
          }[]
        >`
          select
            count(*) as total,
            count(*) filter (where copy_status = 'original') as originals,
            count(*) filter (where copy_status = 'working_copy') as working_copies,
            count(*) filter (where integrity_status = 'hash_unverified') as awaiting,
            count(*) filter (where integrity_status = 'mismatch') as mismatched,
            count(*) filter (where status = 'released') as released
          from evidence.evidence_items
          where deleted_at is null
            and (${filter.caseId ?? null}::uuid is null or case_id = ${filter.caseId ?? null}::uuid)
        `;

        const row = rows[0];
        return {
          total: Number(row?.total ?? 0),
          originals: Number(row?.originals ?? 0),
          workingCopies: Number(row?.working_copies ?? 0),
          awaitingVerification: Number(row?.awaiting ?? 0),
          mismatched: Number(row?.mismatched ?? 0),
          released: Number(row?.released ?? 0),
        };
      });
    },
  };
}

export function createCustodyRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): CustodyRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  const loadEvent = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<CustodyEvent | null> => {
    const rows = await sql<CustodyRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${CUSTODY_SELECT(sql)}
      where ce.id = ${id}::uuid
    `;
    return rows.length > 0 ? toEvent(rows[0]) : null;
  };

  return {
    async events(evidenceItemId) {
      return tx(async (sql) => {
        const rows = await sql<CustodyRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${CUSTODY_SELECT(sql)}
          where ce.evidence_item_id = ${evidenceItemId}::uuid
          -- Oldest first: a chain of custody is read forwards, from
          -- collection to wherever the item is now. Ordered by the sequence
          -- rather than the timestamp, because now() is transaction-stable
          -- and two events written together would tie.
          order by ce.seq asc
        `;
        return rows.map(toEvent);
      });
    },

    async record(input) {
      return tx(async (sql) => {
        const item = await sql<{ case_id: string; classification: string }[]>`
          select case_id, classification from evidence.evidence_items
          where id = ${input.evidenceItemId}::uuid and deleted_at is null
        `;
        if (item.length === 0) {
          throw new EvidenceError("not_found", "That evidence item no longer exists.");
        }

        const rows = await sql<{ id: string }[]>`
          insert into evidence.custody_events (
            evidence_item_id, event_type, occurred_at, released_by, received_by,
            purpose, location, condition, confirmation, recorded_by
          ) values (
            ${input.evidenceItemId}::uuid, ${input.eventType},
            coalesce(${input.occurredAt ?? null}::timestamptz, now()),
            ${input.releasedBy ?? null}::uuid, ${input.receivedBy ?? null}::uuid,
            ${input.purpose}, ${input.location ?? null}, ${input.condition ?? null},
            ${input.confirmation ?? null}, ${actor.userId}::uuid
          )
          returning id
        `;

        // The custodian follows the ledger: whoever received it holds it.
        if (input.receivedBy) {
          await sql`
            update evidence.evidence_items
            set current_custodian = ${input.receivedBy}::uuid,
                updated_by = ${actor.userId}::uuid
            where id = ${input.evidenceItemId}::uuid
          `;
        }

        await sql`
          select audit.write(
            'custody.recorded', 'evidence.custody_events', ${rows[0].id},
            ${item[0].case_id}::uuid, null,
            ${sql.json({
              eventType: input.eventType,
              releasedBy: input.releasedBy ?? null,
              receivedBy: input.receivedBy ?? null,
            })},
            ${input.purpose}, ${item[0].classification}
          )
        `;

        const created = await loadEvent(sql, rows[0].id);
        if (!created) {
          throw new EvidenceError(
            "not_found",
            "The custody event could not be read back after recording.",
          );
        }
        return created;
      });
    },

    async correct(input) {
      return tx(async (sql) => {
        const original = await sql<
          { evidence_item_id: string; case_id: string; classification: string }[]
        >`
          select ce.evidence_item_id, e.case_id, e.classification
          from evidence.custody_events ce
          join evidence.evidence_items e on e.id = ce.evidence_item_id
          where ce.id = ${input.correctsEventId}::uuid
        `;
        if (original.length === 0) {
          throw new EvidenceError(
            "not_found",
            "The custody event being corrected no longer exists.",
          );
        }

        // Refused here as well as in the domain rule, because this reads the
        // row in the same transaction as the insert and therefore holds
        // against a concurrent second correction.
        const already = await sql<{ id: string }[]>`
          select id from evidence.custody_events
          where corrects_event_id = ${input.correctsEventId}::uuid
          limit 1
        `;
        if (already.length > 0) {
          throw new EvidenceError(
            "conflict",
            "That event has already been corrected. Correct the correcting event instead, so the ledger reads as one sequence.",
          );
        }

        const rows = await sql<{ id: string }[]>`
          insert into evidence.custody_events (
            evidence_item_id, event_type, occurred_at, released_by, received_by,
            purpose, location, condition, confirmation,
            corrects_event_id, correction_reason, recorded_by
          ) values (
            ${original[0].evidence_item_id}::uuid, ${input.eventType},
            coalesce(${input.occurredAt ?? null}::timestamptz, now()),
            ${input.releasedBy ?? null}::uuid, ${input.receivedBy ?? null}::uuid,
            ${input.purpose}, ${input.location ?? null}, ${input.condition ?? null},
            ${input.confirmation ?? null},
            ${input.correctsEventId}::uuid, ${input.correctionReason},
            ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'custody.corrected', 'evidence.custody_events', ${rows[0].id},
            ${original[0].case_id}::uuid, null,
            ${sql.json({ corrects: input.correctsEventId })},
            ${input.correctionReason}, ${original[0].classification}
          )
        `;

        const created = await loadEvent(sql, rows[0].id);
        if (!created) {
          throw new EvidenceError(
            "not_found",
            "The correction could not be read back after recording.",
          );
        }
        return created;
      });
    },

    async findEventById(id) {
      return tx((sql) => loadEvent(sql, id));
    },

    /**
     * Walks the chain for one item and recomputes each link.
     *
     * The hash is computed by the database on insert, so verification asks the
     * database to recompute it the same way rather than reimplementing the
     * payload in TypeScript, where the two would drift.
     */
    async verifyChain(evidenceItemId) {
      return tx(async (sql) => {
        const rows = await sql<
          { id: string; ok: boolean }[]
        >`
          select
            ce.id,
            ce.row_hash = encode(
              extensions.digest(
                convert_to(
                  ce.prev_hash || '|' || concat_ws('|',
                    ce.id::text,
                    ce.evidence_item_id::text,
                    ce.event_type,
                    extract(epoch from ce.occurred_at)::text,
                    coalesce(ce.released_by::text, ''),
                    coalesce(ce.received_by::text, ''),
                    ce.purpose,
                    coalesce(ce.location, ''),
                    coalesce(ce.condition, ''),
                    coalesce(ce.confirmation, ''),
                    coalesce(ce.corrects_event_id::text, ''),
                    coalesce(ce.correction_reason, ''),
                    ce.recorded_by::text
                  ),
                  'UTF8'
                ),
                'sha256'
              ),
              'hex'
            ) as ok
          from evidence.custody_events ce
          where ce.evidence_item_id = ${evidenceItemId}::uuid
          order by ce.seq asc
        `;

        const broken = rows.find((row) => !row.ok);
        return {
          events: rows.length,
          intact: broken === undefined,
          brokeAt: broken?.id ?? null,
        };
      });
    },
  };
}

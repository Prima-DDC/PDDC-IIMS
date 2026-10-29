import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { IntelError } from "../domain/errors";
import { buildTraceability } from "../domain/policies";
import type {
  Finding,
  FindingLink,
  InformationCredibility,
  SourceReliability,
  Traceability,
} from "../domain/types";
import type { FindingRepository } from "../application/ports";

/**
 * Findings and what they rest on (PRD 15, screens 17 and 23).
 *
 * `traceability` is the method the platform's purpose comes down to: given a
 * conclusion in a client report, walk back to the evidence and the
 * information behind it, and the source behind that. It is assembled in SQL
 * across four tables because the alternative is a query per link, and a
 * finding with eight links on a remote database is then eight round trips for
 * one strip.
 */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

/**
 * One finding's links, with the human identifier and a recognisable line for
 * whatever each one points at.
 *
 * Four left joins and a coalesce rather than four queries. The `link_type`
 * column decides which one is populated, and the table's own constraint
 * guarantees exactly one is.
 */
const LINK_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    l.id, l.finding_id, l.link_type,
    l.information_id, l.evidence_item_id, l.document_id, l.entity_id,
    coalesce(i.information_id, ev.evidence_id, d.document_id, en.entity_id)
      as target_reference,
    coalesce(i.description, ev.description, d.title, en.name) as target_label,
    l.relevance, l.created_at
  from intel.finding_links l
  left join intel.information i on i.id = l.information_id
  left join evidence.evidence_items ev on ev.id = l.evidence_item_id
  left join docs.documents d on d.id = l.document_id
  left join intel.entities en on en.id = l.entity_id
`;

interface LinkRow {
  id: string;
  finding_id: string;
  link_type: FindingLink["linkType"];
  information_id: string | null;
  evidence_item_id: string | null;
  document_id: string | null;
  entity_id: string | null;
  target_reference: string | null;
  target_label: string | null;
  relevance: string | null;
  created_at: string;
}

function toLink(row: LinkRow): FindingLink {
  return {
    id: row.id,
    findingId: row.finding_id,
    linkType: row.link_type,
    informationId: row.information_id,
    evidenceItemId: row.evidence_item_id,
    documentId: row.document_id,
    entityId: row.entity_id,
    // A null here means the target exists but this actor cannot see it: the
    // join finds nothing because the policy hides the row. Saying so is
    // better than an empty cell, and better than leaking what it is.
    targetReference: row.target_reference ?? "not visible to you",
    targetLabel:
      row.target_label ??
      "Something this finding rests on that your permissions do not reach.",
    relevance: row.relevance,
    createdAt: row.created_at,
  };
}

const FINDING_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    f.id, f.finding_id, f.case_id, c.case_id as case_reference,
    f.statement, f.detail,
    f.analyst, an.full_name as analyst_name,
    f.confidence, f.finding_date, f.status,
    f.reviewer, rv.full_name as reviewer_name, f.reviewed_at, f.review_notes,
    f.classification,
    f.created_at, f.updated_at, f.version, f.deleted_at
  from intel.findings f
  join casework.cases c on c.id = f.case_id
  left join directory an on an.user_id = f.analyst
  left join directory rv on rv.user_id = f.reviewer
`;

interface FindingRow {
  id: string;
  finding_id: string;
  case_id: string;
  case_reference: string;
  statement: string;
  detail: string | null;
  analyst: string;
  analyst_name: string | null;
  confidence: Finding["confidence"];
  finding_date: string;
  status: Finding["status"];
  reviewer: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  classification: Finding["classification"];
  created_at: string;
  updated_at: string;
  version: number;
  deleted_at: string | null;
}

function toFinding(row: FindingRow, links: FindingLink[]): Finding {
  return {
    id: row.id,
    findingId: row.finding_id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    statement: row.statement,
    detail: row.detail,
    analyst: row.analyst,
    analystName: row.analyst_name,
    confidence: row.confidence,
    findingDate: row.finding_date,
    status: row.status,
    reviewer: row.reviewer,
    reviewerName: row.reviewer_name,
    reviewedAt: row.reviewed_at,
    reviewNotes: row.review_notes,
    classification: row.classification,
    links,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
  };
}

const TARGET_COLUMN: Record<FindingLink["linkType"], string> = {
  information: "information_id",
  evidence: "evidence_item_id",
  document: "document_id",
  entity: "entity_id",
};

export function createFindingRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): FindingRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  /** The links for a set of findings, in one query. */
  const linksFor = async (
    sql: postgres.TransactionSql,
    findingIds: string[],
  ): Promise<Map<string, FindingLink[]>> => {
    if (findingIds.length === 0) return new Map();

    const rows = await sql<LinkRow[]>`
      ${LINK_SELECT(sql)}
      where l.finding_id = any(${findingIds}::uuid[])
      order by l.link_type, l.created_at
    `;

    const grouped = new Map<string, FindingLink[]>();
    for (const row of rows) {
      const list = grouped.get(row.finding_id) ?? [];
      list.push(toLink(row));
      grouped.set(row.finding_id, list);
    }
    return grouped;
  };

  const load = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Finding | null> => {
    const rows = await sql<FindingRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${FINDING_SELECT(sql)}
      where f.id = ${id}::uuid
    `;
    if (rows.length === 0) return null;
    const links = await linksFor(sql, [id]);
    return toFinding(rows[0], links.get(id) ?? []);
  };

  const readBack = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Finding> => {
    const finding = await load(sql, id);
    if (!finding) {
      throw new IntelError(
        "not_found",
        "That finding was written but cannot be read back, which means your permissions do not reach it.",
      );
    }
    return finding;
  };

  return {
    async list(filter) {
      return tx(async (sql) => {
        const limit = Math.min(filter.limit ?? 25, 200);
        const offset = filter.offset ?? 0;

        const where = [
          filter.onlyDeleted
            ? sql`f.deleted_at is not null`
            : filter.includeDeleted
              ? sql`true`
              : sql`f.deleted_at is null`,
          filter.caseId ? sql`f.case_id = ${filter.caseId}::uuid` : sql`true`,
          filter.status ? sql`f.status = ${filter.status}` : sql`true`,
          filter.confidence ? sql`f.confidence = ${filter.confidence}` : sql`true`,
          filter.analyst ? sql`f.analyst = ${filter.analyst}::uuid` : sql`true`,
          filter.search
            ? sql`(
                f.statement ilike ${"%" + filter.search + "%"}
                or f.finding_id ilike ${"%" + filter.search + "%"}
              )`
            : sql`true`,
        ];
        const condition = where.reduce(
          (acc, clause) => sql`${acc} and ${clause}`,
          sql`true`,
        );

        const [rows, counted] = await Promise.all([
          sql<FindingRow[]>`
            with directory as (${DIRECTORY(sql)})
            ${FINDING_SELECT(sql)}
            where ${condition}
            order by f.case_id, f.finding_id
            limit ${limit} offset ${offset}
          `,
          sql<{ total: string }[]>`
            select count(*) as total from intel.findings f where ${condition}
          `,
        ]);

        const links = await linksFor(
          sql,
          rows.map((row) => row.id),
        );

        return {
          rows: rows.map((row) => toFinding(row, links.get(row.id) ?? [])),
          total: Number(counted[0].total),
        };
      });
    },

    async findById(id) {
      return tx((sql) => load(sql, id));
    },

    async create(input) {
      return tx(async (sql) => {
        const [created] = await sql<{ id: string; finding_id: string }[]>`
          insert into intel.findings (
            finding_id, case_id, statement, detail, analyst, confidence,
            finding_date, classification, created_by, updated_by
          ) values (
            intel.next_finding_id(${input.caseId}::uuid), ${input.caseId}::uuid,
            ${input.statement}, ${input.detail ?? null}, ${input.analyst}::uuid,
            ${input.confidence},
            coalesce(${input.findingDate ?? null}::date, current_date),
            ${input.classification}, ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id, finding_id
        `;

        await sql`
          select audit.write(
            'finding.created', 'intel.findings', ${created.id},
            ${input.caseId}::uuid, null,
            ${sql.json({
              findingId: created.finding_id,
              confidence: input.confidence,
            })},
            null, ${input.classification}
          )
        `;

        return readBack(sql, created.id);
      });
    },

    async update(id, input, expectedVersion) {
      return tx(async (sql) => {
        const before = await load(sql, id);
        if (!before) {
          throw new IntelError("not_found", "That finding no longer exists.");
        }
        if (before.version !== expectedVersion) {
          throw new IntelError(
            "stale_version",
            "Somebody else changed this finding while you were editing it. Reload and apply your change again.",
          );
        }

        const result = await sql`
          update intel.findings set
            statement = coalesce(${input.statement ?? null}, statement),
            detail = ${input.detail ?? null},
            confidence = coalesce(${input.confidence ?? null}, confidence),
            finding_date = coalesce(${input.findingDate ?? null}::date, finding_date),
            classification = coalesce(${input.classification ?? null}, classification),
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${expectedVersion}
        `;
        if (result.count === 0) {
          throw new IntelError("stale_version", "That change could not be applied.");
        }

        const after = await readBack(sql, id);
        await sql`
          select audit.write(
            'finding.updated', 'intel.findings', ${id}, ${after.caseId}::uuid,
            ${sql.json({ statement: before.statement, confidence: before.confidence })},
            ${sql.json({ statement: after.statement, confidence: after.confidence })},
            null, ${after.classification}
          )
        `;
        return after;
      });
    },

    /**
     * Putting a finding forward, or deciding one.
     *
     * The reviewer is cleared when it goes back out for review, so a
     * resubmitted finding does not carry the previous reviewer's name as
     * though they had seen the new version.
     */
    async setStatus(input) {
      return tx(async (sql) => {
        const before = await load(sql, input.id);
        if (!before) {
          throw new IntelError("not_found", "That finding no longer exists.");
        }

        const decision = input.status === "accepted" || input.status === "returned";

        const result = await sql`
          update intel.findings set
            status = ${input.status},
            reviewer = ${decision ? (input.reviewer ?? actor.userId) : null}::uuid,
            reviewed_at = ${decision ? sql`now()` : sql`null`},
            review_notes = ${input.reviewNotes ?? null},
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid and status = ${before.status}
        `;
        if (result.count === 0) {
          throw new IntelError(
            "conflict",
            "Somebody else moved this finding while you were looking at it.",
          );
        }

        await sql`
          select audit.write(
            'finding.status_changed', 'intel.findings', ${input.id},
            ${before.caseId}::uuid,
            ${sql.json({ status: before.status })},
            ${sql.json({ status: input.status })},
            ${input.reviewNotes ?? null}, ${before.classification}
          )
        `;

        return readBack(sql, input.id);
      });
    },

    async softDelete(id, reason) {
      await tx(async (sql) => {
        const existing = await sql<{ case_id: string; classification: string }[]>`
          select case_id, classification from intel.findings
          where id = ${id}::uuid and deleted_at is null
        `;
        const result = await sql`
          update intel.findings
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (existing.length === 0 || result.count === 0) {
          throw new IntelError("not_found", "That finding no longer exists.");
        }

        await sql`
          select audit.write(
            'finding.removed', 'intel.findings', ${id},
            ${existing[0].case_id}::uuid, null, null, ${reason},
            ${existing[0].classification}
          )
        `;
      });
    },

    async restore(id, reason) {
      await tx(async (sql) => {
        const result = await sql`
          update intel.findings
          set deleted_at = null, deleted_by = null, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is not null
        `;
        if (result.count === 0) {
          throw new IntelError("not_found", "That finding is not in the recycle bin.");
        }
        await sql`
          select audit.write(
            'finding.restored', 'intel.findings', ${id}, null, null, null,
            ${reason}, null
          )
        `;
      });
    },

    async links(findingId) {
      return tx(async (sql) => {
        const grouped = await linksFor(sql, [findingId]);
        return grouped.get(findingId) ?? [];
      });
    },

    async link(input) {
      await tx(async (sql) => {
        const column = TARGET_COLUMN[input.linkType];
        // The column name is chosen from a closed map keyed by a union type,
        // never from anything a caller supplies, which is why it can be
        // interpolated as an identifier at all.
        const inserted = await sql`
          insert into intel.finding_links (
            finding_id, link_type, ${sql(column)}, relevance, created_by
          ) values (
            ${input.findingId}::uuid, ${input.linkType}, ${input.targetId}::uuid,
            ${input.relevance ?? null}, ${actor.userId}::uuid
          )
          on conflict do nothing
        `;
        if (inserted.count === 0) {
          throw new IntelError(
            "conflict",
            "That is already linked to this finding.",
          );
        }

        await sql`
          select audit.write(
            'finding.linked', 'intel.findings', ${input.findingId}, null, null,
            ${sql.json({ linkType: input.linkType, targetId: input.targetId })},
            ${input.relevance ?? null}, null
          )
        `;
      });
    },

    async unlink(linkId) {
      await tx(async (sql) => {
        const [removed] = await sql<{ finding_id: string; link_type: string }[]>`
          delete from intel.finding_links where id = ${linkId}::uuid
          returning finding_id, link_type
        `;
        if (!removed) {
          throw new IntelError("not_found", "That link no longer exists.");
        }
        await sql`
          select audit.write(
            'finding.unlinked', 'intel.findings', ${removed.finding_id}, null,
            ${sql.json({ linkType: removed.link_type })}, null, null, null
          )
        `;
      });
    },

    /**
     * The traceability strip (PRD 23).
     *
     * One query for the hops, which reaches a hop further than the links
     * themselves: a linked piece of information brings the source behind it,
     * because Source to Information is the first leg of the chain and a strip
     * that started at the information would hide where it came from.
     */
    async traceability(findingId) {
      return tx(async (sql) => {
        const header = await sql<{ id: string; finding_id: string }[]>`
          select id, finding_id from intel.findings where id = ${findingId}::uuid
        `;
        if (header.length === 0) return null;

        const hops = await sql<
          {
            kind: "source" | "information" | "evidence" | "document" | "entity";
            id: string;
            reference: string;
            label: string;
            rating: string | null;
            href: string;
          }[]
        >`
          -- The sources behind the linked information.
          select distinct
            'source' as kind, s.id, s.source_id as reference,
            s.description as label, s.source_reliability as rating,
            '/sources/' || s.id as href
          from intel.finding_links l
          join intel.information i on i.id = l.information_id
          join intel.sources s on s.id = i.source_id
          where l.finding_id = ${findingId}::uuid

          union all

          select
            'information', i.id, i.information_id, i.description,
            i.information_credibility, '/information/' || i.id
          from intel.finding_links l
          join intel.information i on i.id = l.information_id
          where l.finding_id = ${findingId}::uuid

          union all

          select
            'evidence', e.id, e.evidence_id, e.description,
            e.integrity_status, '/evidence/' || e.id
          from intel.finding_links l
          join evidence.evidence_items e on e.id = l.evidence_item_id
          where l.finding_id = ${findingId}::uuid

          union all

          select
            'document', d.id, d.document_id, d.title,
            case when d.approved_version_id is not null then 'approved'
                 else 'draft' end,
            '/documents/' || d.id
          from intel.finding_links l
          join docs.documents d on d.id = l.document_id
          where l.finding_id = ${findingId}::uuid

          union all

          select
            'entity', en.id, en.entity_id, en.name, en.entity_type,
            '/entities/' || en.id
          from intel.finding_links l
          join intel.entities en on en.id = l.entity_id
          where l.finding_id = ${findingId}::uuid
        `;

        return buildTraceability(
          { id: header[0].id, findingId: header[0].finding_id },
          hops,
        ) as Traceability;
      });
    },

    async support(findingId) {
      return tx(async (sql) => {
        const [information, evidence] = await Promise.all([
          sql<
            {
              credibility: InformationCredibility;
              reliability: SourceReliability;
            }[]
          >`
            select
              i.information_credibility as credibility,
              s.source_reliability as reliability
            from intel.finding_links l
            join intel.information i on i.id = l.information_id
            join intel.sources s on s.id = i.source_id
            where l.finding_id = ${findingId}::uuid
          `,
          sql<{ total: string }[]>`
            select count(*) as total
            from intel.finding_links l
            join evidence.evidence_items e on e.id = l.evidence_item_id
            where l.finding_id = ${findingId}::uuid
              -- An item whose stored file does not match what was collected
              -- supports nothing, which is the point of PRD 6.3.
              and e.integrity_status <> 'mismatch'
          `,
        ]);

        return {
          information: information.map((row) => ({
            credibility: row.credibility,
            reliability: row.reliability,
          })),
          evidenceCount: Number(evidence[0].total),
        };
      });
    },

    async summary(filter) {
      return tx(async (sql) => {
        const [row] = await sql<
          {
            total: string;
            accepted: string;
            awaiting_review: string;
            returned: string;
            unsupported: string;
          }[]
        >`
          select
            count(*) as total,
            count(*) filter (where f.status = 'accepted') as accepted,
            count(*) filter (where f.status = 'submitted') as awaiting_review,
            count(*) filter (where f.status = 'returned') as returned,
            count(*) filter (
              where not exists (
                select 1 from intel.finding_links l
                where l.finding_id = f.id
                  and (l.information_id is not null or l.evidence_item_id is not null)
              )
            ) as unsupported
          from intel.findings f
          where f.deleted_at is null
            and (${filter.caseId ?? null}::uuid is null
                 or f.case_id = ${filter.caseId ?? null}::uuid)
        `;

        return {
          total: Number(row.total),
          accepted: Number(row.accepted),
          awaitingReview: Number(row.awaiting_review),
          returned: Number(row.returned),
          unsupported: Number(row.unsupported),
        };
      });
    },
  };
}

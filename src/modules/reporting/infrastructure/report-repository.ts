import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { ReportingError } from "../domain/errors";
import type {
  CitationType,
  Report,
  ReportSection,
  ReportTransition,
  ReportVersion,
  SectionCitation,
} from "../domain/types";
import type { ListReportsFilter, ReportRepository } from "../application/ports";

/**
 * Reports, their versions, their sections and the workflow history
 * (PRD 10, screen 18).
 *
 * Two things here are worth reading closely.
 *
 * `transition` writes the stage change and its history row in one
 * transaction, because PRD 10.1 wants every stage recorded with user, time
 * and decision, and a stage change whose reason was written separately is one
 * that can exist without it.
 *
 * `citable` returns only what a report may actually cite: accepted findings,
 * exhibits that still match what was collected, approved documents. A picker
 * offering a draft finding is a picker offering something the database will
 * refuse, and the refusal would arrive after the author had written the
 * paragraph.
 */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

const VERSION_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    v.id, v.report_id, v.version_no, v.version_label, v.status,
    v.executive_summary, v.scope_statement, v.methodology, v.limitations,
    v.conclusion, v.change_note,
    v.is_current, v.is_approved,
    v.approved_by, ab.full_name as approved_by_name, v.approved_at,
    v.created_at, v.created_by, cb.full_name as created_by_name,
    v.updated_at, v.version,
    (
      select count(*) from reporting.report_sections s where s.version_id = v.id
    ) as section_count
  from reporting.report_versions v
  left join directory ab on ab.user_id = v.approved_by
  left join directory cb on cb.user_id = v.created_by
`;

interface VersionRow {
  id: string;
  report_id: string;
  version_no: number;
  version_label: string;
  status: ReportVersion["status"];
  executive_summary: string | null;
  scope_statement: string | null;
  methodology: string | null;
  limitations: string | null;
  conclusion: string | null;
  change_note: string | null;
  is_current: boolean;
  is_approved: boolean;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: string;
  version: number;
  section_count: string;
}

function toVersion(row: VersionRow): ReportVersion {
  return {
    id: row.id,
    reportId: row.report_id,
    versionNo: row.version_no,
    versionLabel: row.version_label,
    status: row.status,
    executiveSummary: row.executive_summary,
    scopeStatement: row.scope_statement,
    methodology: row.methodology,
    limitations: row.limitations,
    conclusion: row.conclusion,
    changeNote: row.change_note,
    isCurrent: row.is_current,
    isApproved: row.is_approved,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    version: row.version,
    sectionCount: Number(row.section_count),
  };
}

const REPORT_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    r.id, r.report_id, r.case_id, c.case_id as case_reference,
    c.title as case_title, cl.organisation_name as client_name,
    r.title, r.report_type, r.status,
    r.author, au.full_name as author_name,
    r.current_version_id, r.approved_version_id, r.classification,
    r.created_at, r.updated_at, r.version, r.deleted_at,
    (
      select count(*) from reporting.report_versions v where v.report_id = r.id
    ) as version_count,
    (
      select count(*) from reporting.deliveries d where d.report_id = r.id
    ) as delivery_count
  from reporting.reports r
  join casework.cases c on c.id = r.case_id
  left join crm.clients cl on cl.id = c.client_id
  left join directory au on au.user_id = r.author
`;

interface ReportRow {
  id: string;
  report_id: string;
  case_id: string;
  case_reference: string;
  case_title: string;
  client_name: string | null;
  title: string;
  report_type: Report["reportType"];
  status: Report["status"];
  author: string;
  author_name: string | null;
  current_version_id: string | null;
  approved_version_id: string | null;
  classification: Report["classification"];
  created_at: string;
  updated_at: string;
  version: number;
  deleted_at: string | null;
  version_count: string;
  delivery_count: string;
}

function toReport(row: ReportRow, current: ReportVersion | null): Report {
  return {
    id: row.id,
    reportId: row.report_id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    caseTitle: row.case_title,
    clientName: row.client_name ?? "unknown client",
    title: row.title,
    reportType: row.report_type,
    status: row.status,
    author: row.author,
    authorName: row.author_name,
    currentVersionId: row.current_version_id,
    approvedVersionId: row.approved_version_id,
    classification: row.classification,
    current,
    versionCount: Number(row.version_count),
    deliveryCount: Number(row.delivery_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
  };
}

/**
 * A section's citations, with the human identifier and a readable label for
 * whatever each one points at.
 *
 * Four left joins and a coalesce rather than four queries. A null label means
 * the target exists but this actor cannot see it, which is said in words
 * rather than shown as an empty cell.
 */
const CITATION_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    sc.id, sc.section_id, sc.citation_type,
    sc.finding_id, sc.evidence_item_id, sc.document_id, sc.information_id,
    coalesce(f.finding_id, ev.evidence_id, d.document_id, i.information_id)
      as target_reference,
    coalesce(f.statement, ev.description, d.title, i.description) as target_label,
    sc.note
  from reporting.section_citations sc
  left join intel.findings f on f.id = sc.finding_id
  left join evidence.evidence_items ev on ev.id = sc.evidence_item_id
  left join docs.documents d on d.id = sc.document_id
  left join intel.information i on i.id = sc.information_id
`;

interface CitationRow {
  id: string;
  section_id: string;
  citation_type: CitationType;
  finding_id: string | null;
  evidence_item_id: string | null;
  document_id: string | null;
  information_id: string | null;
  target_reference: string | null;
  target_label: string | null;
  note: string | null;
}

function toCitation(row: CitationRow): SectionCitation {
  const href = row.finding_id
    ? `/findings/${row.finding_id}`
    : row.evidence_item_id
      ? `/evidence/${row.evidence_item_id}`
      : row.document_id
        ? `/documents/${row.document_id}`
        : `/information/${row.information_id}`;

  return {
    id: row.id,
    sectionId: row.section_id,
    citationType: row.citation_type,
    findingId: row.finding_id,
    evidenceItemId: row.evidence_item_id,
    documentId: row.document_id,
    informationId: row.information_id,
    targetReference: row.target_reference ?? "not visible to you",
    targetLabel:
      row.target_label ??
      "Something this section cites that your permissions do not reach.",
    note: row.note,
    href,
  };
}

export function createReportRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): ReportRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  const loadVersion = async (
    sql: postgres.TransactionSql,
    versionId: string,
  ): Promise<ReportVersion | null> => {
    const rows = await sql<VersionRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${VERSION_SELECT(sql)}
      where v.id = ${versionId}::uuid
    `;
    return rows.length > 0 ? toVersion(rows[0]) : null;
  };

  const load = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Report | null> => {
    const rows = await sql<ReportRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${REPORT_SELECT(sql)}
      where r.id = ${id}::uuid
    `;
    if (rows.length === 0) return null;

    const current = rows[0].current_version_id
      ? await loadVersion(sql, rows[0].current_version_id)
      : null;
    return toReport(rows[0], current);
  };

  const readBack = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Report> => {
    const report = await load(sql, id);
    if (!report) {
      throw new ReportingError(
        "not_found",
        "That report was written but cannot be read back, which means your permissions do not reach it.",
      );
    }
    return report;
  };

  const sectionsFor = async (
    sql: postgres.TransactionSql,
    versionId: string,
  ): Promise<ReportSection[]> => {
    const [sections, citations] = await Promise.all([
      sql<
        {
          id: string;
          version_id: string;
          position: number;
          heading: string;
          body: string | null;
          section_type: ReportSection["sectionType"];
          version: number;
        }[]
      >`
        select id, version_id, position, heading, body, section_type, version
        from reporting.report_sections
        where version_id = ${versionId}::uuid
        order by position
      `,
      sql<CitationRow[]>`
        ${CITATION_SELECT(sql)}
        where sc.section_id in (
          select id from reporting.report_sections
          where version_id = ${versionId}::uuid
        )
        order by sc.citation_type, sc.created_at
      `,
    ]);

    const grouped = new Map<string, SectionCitation[]>();
    for (const row of citations) {
      const list = grouped.get(row.section_id) ?? [];
      list.push(toCitation(row));
      grouped.set(row.section_id, list);
    }

    return sections.map((section) => ({
      id: section.id,
      versionId: section.version_id,
      position: section.position,
      heading: section.heading,
      body: section.body,
      sectionType: section.section_type,
      citations: grouped.get(section.id) ?? [],
      version: section.version,
    }));
  };

  return {
    async list(filter: ListReportsFilter) {
      return tx(async (sql) => {
        const limit = Math.min(filter.limit ?? 25, 200);
        const offset = filter.offset ?? 0;

        const where = [
          filter.onlyDeleted
            ? sql`r.deleted_at is not null`
            : filter.includeDeleted
              ? sql`true`
              : sql`r.deleted_at is null`,
          filter.caseId ? sql`r.case_id = ${filter.caseId}::uuid` : sql`true`,
          filter.status ? sql`r.status = ${filter.status}` : sql`true`,
          filter.reportType ? sql`r.report_type = ${filter.reportType}` : sql`true`,
          filter.author ? sql`r.author = ${filter.author}::uuid` : sql`true`,
          // Waiting on somebody, and not on the person who wrote it: that is
          // what makes it a queue rather than a list.
          filter.awaitingReview
            ? sql`r.status in ('investigator_review', 'supervisor_review',
                               'qa_review', 'approval')
                  and r.author <> ${actor.userId}::uuid`
            : sql`true`,
          filter.search
            ? sql`(
                r.title ilike ${"%" + filter.search + "%"}
                or r.report_id ilike ${"%" + filter.search + "%"}
              )`
            : sql`true`,
        ];
        const condition = where.reduce(
          (acc, clause) => sql`${acc} and ${clause}`,
          sql`true`,
        );

        const [rows, counted] = await Promise.all([
          sql<ReportRow[]>`
            with directory as (${DIRECTORY(sql)})
            ${REPORT_SELECT(sql)}
            where ${condition}
            order by r.updated_at desc
            limit ${limit} offset ${offset}
          `,
          sql<{ total: string }[]>`
            select count(*) as total from reporting.reports r where ${condition}
          `,
        ]);

        // The current versions in one query rather than one per report.
        const versionIds = rows
          .map((row) => row.current_version_id)
          .filter((id): id is string => id !== null);

        const versions =
          versionIds.length > 0
            ? await sql<VersionRow[]>`
                with directory as (${DIRECTORY(sql)})
                ${VERSION_SELECT(sql)}
                where v.id = any(${versionIds}::uuid[])
              `
            : [];

        const byId = new Map(versions.map((row) => [row.id, toVersion(row)]));

        return {
          rows: rows.map((row) =>
            toReport(
              row,
              row.current_version_id
                ? (byId.get(row.current_version_id) ?? null)
                : null,
            ),
          ),
          total: Number(counted[0].total),
        };
      });
    },

    async findById(id) {
      return tx((sql) => load(sql, id));
    },

    async create(input) {
      return tx(async (sql) => {
        const [report] = await sql<{ id: string; report_id: string }[]>`
          insert into reporting.reports (
            case_id, title, report_type, author, classification,
            created_by, updated_by
          ) values (
            ${input.caseId}::uuid, ${input.title}, ${input.reportType},
            ${input.author}::uuid, ${input.classification},
            ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id, report_id
        `;

        const [version] = await sql<{ id: string }[]>`
          insert into reporting.report_versions (
            report_id, version_no, version_label, status,
            executive_summary, scope_statement, methodology,
            created_by, updated_by
          ) values (
            ${report.id}::uuid, 1, 'v0.1', 'draft',
            ${input.executiveSummary ?? null}, ${input.scopeStatement ?? null},
            ${input.methodology ?? null},
            ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          update reporting.reports set current_version_id = ${version.id}::uuid
          where id = ${report.id}::uuid
        `;

        await sql`
          select audit.write(
            'report.created', 'reporting.reports', ${report.id},
            ${input.caseId}::uuid, null,
            ${sql.json({ reportId: report.report_id, title: input.title })},
            null, ${input.classification}
          )
        `;

        return readBack(sql, report.id);
      });
    },

    async update(id, input, expectedVersion) {
      return tx(async (sql) => {
        const result = await sql`
          update reporting.reports set
            title = coalesce(${input.title ?? null}, title),
            report_type = coalesce(${input.reportType ?? null}, report_type),
            classification = coalesce(${input.classification ?? null}, classification),
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${expectedVersion}
        `;
        if (result.count === 0) {
          throw new ReportingError(
            "stale_version",
            "Somebody else changed this report while you were editing it. Reload and apply your change again.",
          );
        }
        return readBack(sql, id);
      });
    },

    /**
     * One stage along the line, with its reason, in one transaction.
     *
     * `approveVersion` closes the lock in the same breath, because a report
     * that reached Final with its version still editable would be a lock
     * nobody had turned.
     */
    async transition(input) {
      return tx(async (sql) => {
        const before = await load(sql, input.id);
        if (!before) {
          throw new ReportingError("not_found", "That report no longer exists.");
        }

        const result = await sql`
          update reporting.reports set
            status = ${input.to},
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid and status = ${before.status}
        `;
        if (result.count === 0) {
          throw new ReportingError(
            "conflict",
            "Somebody else moved this report while you were looking at it.",
          );
        }

        if (before.currentVersionId) {
          // The version's own status follows the report's, so a reader of the
          // history can see which version was at which stage.
          await sql`
            update reporting.report_versions set
              status = ${
                input.to === "delivered" || input.to === "final"
                  ? "final"
                  : input.to === "withdrawn"
                    ? "superseded"
                    : input.decision === "returned"
                      ? "returned"
                      : input.to
              },
              updated_by = ${actor.userId}::uuid
            where id = ${before.currentVersionId}::uuid
          `;

          if (input.approveVersion) {
            await sql`
              update reporting.report_versions set
                is_approved = true,
                approved_by = ${actor.userId}::uuid,
                approved_at = now(),
                updated_by = ${actor.userId}::uuid
              where id = ${before.currentVersionId}::uuid
            `;
            await sql`
              update reporting.reports
              set approved_version_id = ${before.currentVersionId}::uuid
              where id = ${input.id}::uuid
            `;
          }
        }

        await sql`
          insert into reporting.report_transitions (
            report_id, version_id, from_status, to_status, decision, notes,
            decided_by
          ) values (
            ${input.id}::uuid, ${before.currentVersionId}::uuid,
            ${before.status}, ${input.to}, ${input.decision},
            ${input.notes ?? null}, ${actor.userId}::uuid
          )
        `;

        await sql`
          select audit.write(
            'report.transitioned', 'reporting.reports', ${input.id},
            ${before.caseId}::uuid,
            ${sql.json({ status: before.status })},
            ${sql.json({ status: input.to, decision: input.decision })},
            ${input.notes ?? null}, ${before.classification}
          )
        `;

        return readBack(sql, input.id);
      });
    },

    async history(id) {
      return tx(async (sql) => {
        const rows = await sql<
          {
            id: string;
            report_id: string;
            version_id: string | null;
            version_label: string | null;
            from_status: string;
            to_status: string;
            decision: ReportTransition["decision"];
            notes: string | null;
            decided_by: string;
            decided_by_name: string | null;
            decided_at: string;
          }[]
        >`
          with directory as (${DIRECTORY(sql)})
          select
            t.id, t.report_id, t.version_id, v.version_label,
            t.from_status, t.to_status, t.decision, t.notes,
            t.decided_by, db.full_name as decided_by_name, t.decided_at
          from reporting.report_transitions t
          left join reporting.report_versions v on v.id = t.version_id
          left join directory db on db.user_id = t.decided_by
          where t.report_id = ${id}::uuid
          -- By insertion order, not by the clock: decided_at is the
          -- transaction time and ties between decisions taken seconds apart
          -- (migration 0042).
          order by t.seq
        `;

        return rows.map(
          (row): ReportTransition => ({
            id: row.id,
            reportId: row.report_id,
            versionId: row.version_id,
            versionLabel: row.version_label,
            fromStatus: row.from_status,
            toStatus: row.to_status,
            decision: row.decision,
            notes: row.notes,
            decidedBy: row.decided_by,
            decidedByName: row.decided_by_name,
            decidedAt: row.decided_at,
          }),
        );
      });
    },

    async softDelete(id, reason) {
      await tx(async (sql) => {
        const existing = await sql<{ case_id: string; classification: string }[]>`
          select case_id, classification from reporting.reports
          where id = ${id}::uuid and deleted_at is null
        `;
        const result = await sql`
          update reporting.reports
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (existing.length === 0 || result.count === 0) {
          throw new ReportingError("not_found", "That report no longer exists.");
        }

        await sql`
          select audit.write(
            'report.removed', 'reporting.reports', ${id},
            ${existing[0].case_id}::uuid, null, null, ${reason},
            ${existing[0].classification}
          )
        `;
      });
    },

    async restore(id, reason) {
      await tx(async (sql) => {
        const result = await sql`
          update reporting.reports
          set deleted_at = null, deleted_by = null, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is not null
        `;
        if (result.count === 0) {
          throw new ReportingError(
            "not_found",
            "That report is not in the recycle bin.",
          );
        }
        await sql`
          select audit.write(
            'report.restored', 'reporting.reports', ${id}, null, null, null,
            ${reason}, null
          )
        `;
      });
    },

    /* ------------------------------------------------------- versions */

    async versions(reportId) {
      return tx(async (sql) => {
        const rows = await sql<VersionRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${VERSION_SELECT(sql)}
          where v.report_id = ${reportId}::uuid
          order by v.version_no desc
        `;
        return rows.map(toVersion);
      });
    },

    async findVersion(versionId) {
      return tx((sql) => loadVersion(sql, versionId));
    },

    /**
     * The next version, carrying the previous one's content forward.
     *
     * Copied rather than referenced, because an approved version is locked
     * and a later version has to be able to differ from it in any respect.
     * Not copying it would mean retyping a thirty-page report to correct a
     * date.
     */
    async addVersion(input) {
      return tx(async (sql) => {
        const [next] = await sql<{ version_no: number }[]>`
          select coalesce(max(version_no), 0) + 1 as version_no
          from reporting.report_versions where report_id = ${input.reportId}::uuid
        `;

        await sql`
          update reporting.report_versions set is_current = false
          where report_id = ${input.reportId}::uuid and is_current
        `;

        const source = input.copyFromVersionId
          ? await loadVersion(sql, input.copyFromVersionId)
          : null;

        const [created] = await sql<{ id: string }[]>`
          insert into reporting.report_versions (
            report_id, version_no, version_label, status, change_note,
            executive_summary, scope_statement, methodology, limitations,
            conclusion, is_current, created_by, updated_by
          ) values (
            ${input.reportId}::uuid, ${next.version_no}, ${input.versionLabel},
            'draft', ${input.changeNote ?? null},
            ${source?.executiveSummary ?? null}, ${source?.scopeStatement ?? null},
            ${source?.methodology ?? null}, ${source?.limitations ?? null},
            ${source?.conclusion ?? null},
            true, ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id
        `;

        if (input.copyFromVersionId) {
          // Sections and their citations come forward too, in two statements
          // rather than one per row: a thirty-page report would otherwise be
          // sixty round trips to a database 130ms away.
          //
          // The citations join the old section to the new one on `position`,
          // which is unique per version and is what the copy preserves. That
          // is why this needs no mapping passed back through the client.
          await sql`
            insert into reporting.report_sections (
              version_id, position, heading, body, section_type,
              created_by, updated_by
            )
            select
              ${created.id}::uuid, s.position, s.heading, s.body,
              s.section_type, ${actor.userId}::uuid, ${actor.userId}::uuid
            from reporting.report_sections s
            where s.version_id = ${input.copyFromVersionId}::uuid
          `;

          await sql`
            insert into reporting.section_citations (
              section_id, citation_type, finding_id, evidence_item_id,
              document_id, information_id, note, created_by
            )
            select
              ns.id, sc.citation_type, sc.finding_id, sc.evidence_item_id,
              sc.document_id, sc.information_id, sc.note, ${actor.userId}::uuid
            from reporting.section_citations sc
            join reporting.report_sections os
              on os.id = sc.section_id
             and os.version_id = ${input.copyFromVersionId}::uuid
            join reporting.report_sections ns
              on ns.version_id = ${created.id}::uuid
             and ns.position = os.position
          `;
        }

        await sql`
          update reporting.reports set
            current_version_id = ${created.id}::uuid,
            status = 'draft',
            updated_by = ${actor.userId}::uuid
          where id = ${input.reportId}::uuid
        `;

        const version = await loadVersion(sql, created.id);
        if (!version) {
          throw new ReportingError(
            "not_found",
            "That version was written but cannot be read back.",
          );
        }
        return version;
      });
    },

    async updateVersion(versionId, input, expectedVersion) {
      return tx(async (sql) => {
        const result = await sql`
          update reporting.report_versions set
            executive_summary = ${input.executiveSummary ?? null},
            scope_statement = ${input.scopeStatement ?? null},
            methodology = ${input.methodology ?? null},
            limitations = ${input.limitations ?? null},
            conclusion = ${input.conclusion ?? null},
            updated_by = ${actor.userId}::uuid
          where id = ${versionId}::uuid and version = ${expectedVersion}
        `;
        if (result.count === 0) {
          throw new ReportingError(
            "stale_version",
            "Somebody else changed this version while you were editing it.",
          );
        }
        const version = await loadVersion(sql, versionId);
        if (!version) {
          throw new ReportingError("not_found", "That version no longer exists.");
        }
        return version;
      });
    },

    /* ------------------------------------------------------- sections */

    async sections(versionId) {
      return tx((sql) => sectionsFor(sql, versionId));
    },

    async addSection(input) {
      return tx(async (sql) => {
        const [next] = await sql<{ position: number }[]>`
          select coalesce(max(position), 0) + 1 as position
          from reporting.report_sections where version_id = ${input.versionId}::uuid
        `;

        const [created] = await sql<{ id: string }[]>`
          insert into reporting.report_sections (
            version_id, position, heading, body, section_type,
            created_by, updated_by
          ) values (
            ${input.versionId}::uuid, ${next.position}, ${input.heading},
            ${input.body ?? null}, ${input.sectionType},
            ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id
        `;

        const sections = await sectionsFor(sql, input.versionId);
        const section = sections.find((row) => row.id === created.id);
        if (!section) {
          throw new ReportingError(
            "not_found",
            "That section was written but cannot be read back.",
          );
        }
        return section;
      });
    },

    async updateSection(sectionId, input, expectedVersion) {
      return tx(async (sql) => {
        const result = await sql`
          update reporting.report_sections set
            heading = coalesce(${input.heading ?? null}, heading),
            body = ${input.body ?? null},
            section_type = coalesce(${input.sectionType ?? null}, section_type),
            updated_by = ${actor.userId}::uuid
          where id = ${sectionId}::uuid and version = ${expectedVersion}
        `;
        if (result.count === 0) {
          throw new ReportingError(
            "stale_version",
            "Somebody else changed this section while you were editing it.",
          );
        }

        const [row] = await sql<{ version_id: string }[]>`
          select version_id from reporting.report_sections
          where id = ${sectionId}::uuid
        `;
        const sections = await sectionsFor(sql, row.version_id);
        const section = sections.find((candidate) => candidate.id === sectionId);
        if (!section) {
          throw new ReportingError("not_found", "That section no longer exists.");
        }
        return section;
      });
    },

    /**
     * Moving a section, by swapping it with its neighbour.
     *
     * A swap rather than a renumber of everything below, so the unique index
     * on (version_id, position) is never violated part way through: the
     * neighbour is parked at a position no row can hold.
     */
    async moveSection(sectionId, direction) {
      await tx(async (sql) => {
        const [current] = await sql<
          { version_id: string; position: number }[]
        >`
          select version_id, position from reporting.report_sections
          where id = ${sectionId}::uuid
        `;
        if (!current) {
          throw new ReportingError("not_found", "That section no longer exists.");
        }

        const [neighbour] = await sql<{ id: string; position: number }[]>`
          select id, position from reporting.report_sections
          where version_id = ${current.version_id}::uuid
            and position ${direction === "up" ? sql`<` : sql`>`} ${current.position}
          order by position ${direction === "up" ? sql`desc` : sql`asc`}
          limit 1
        `;
        if (!neighbour) return;

        await sql`
          update reporting.report_sections set position = -1
          where id = ${sectionId}::uuid
        `;
        await sql`
          update reporting.report_sections set position = ${current.position}
          where id = ${neighbour.id}::uuid
        `;
        await sql`
          update reporting.report_sections set position = ${neighbour.position}
          where id = ${sectionId}::uuid
        `;
      });
    },

    async removeSection(sectionId) {
      await tx(async (sql) => {
        const result = await sql`
          delete from reporting.report_sections where id = ${sectionId}::uuid
        `;
        if (result.count === 0) {
          throw new ReportingError("not_found", "That section no longer exists.");
        }
      });
    },

    async cite(input) {
      await tx(async (sql) => {
        const column =
          input.citationType === "finding"
            ? "finding_id"
            : input.citationType === "evidence"
              ? "evidence_item_id"
              : input.citationType === "document"
                ? "document_id"
                : "information_id";

        // The column name comes from a closed map keyed by a union type,
        // never from anything a caller supplies.
        await sql`
          insert into reporting.section_citations (
            section_id, citation_type, ${sql(column)}, note, created_by
          ) values (
            ${input.sectionId}::uuid, ${input.citationType},
            ${input.targetId}::uuid, ${input.note ?? null}, ${actor.userId}::uuid
          )
        `;
      });
    },

    async uncite(citationId) {
      await tx(async (sql) => {
        const result = await sql`
          delete from reporting.section_citations where id = ${citationId}::uuid
        `;
        if (result.count === 0) {
          throw new ReportingError("not_found", "That citation no longer exists.");
        }
      });
    },

    /**
     * What this case has that a report may cite.
     *
     * Only the citable: an accepted finding, an exhibit that is not a
     * mismatch, an approved document. The database refuses the rest, and a
     * picker that offered them would spring that refusal on the author after
     * they had written the paragraph.
     */
    async citable(caseId) {
      return tx(async (sql) => {
        const [findings, evidenceItems, documents, information] = await Promise.all([
          sql<{ id: string; reference: string; label: string }[]>`
            select id, finding_id as reference, statement as label
            from intel.findings
            where case_id = ${caseId}::uuid
              and deleted_at is null
              and status = 'accepted'
            order by finding_id
          `,
          sql<{ id: string; reference: string; label: string }[]>`
            select id, evidence_id as reference, description as label
            from evidence.evidence_items
            where case_id = ${caseId}::uuid
              and deleted_at is null
              and integrity_status <> 'mismatch'
            order by evidence_id
          `,
          sql<{ id: string; reference: string; label: string }[]>`
            select id, document_id as reference, title as label
            from docs.documents
            where case_id = ${caseId}::uuid
              and deleted_at is null
              and approved_version_id is not null
            order by document_id
          `,
          sql<{ id: string; reference: string; label: string }[]>`
            select id, information_id as reference, description as label
            from intel.information
            where case_id = ${caseId}::uuid and deleted_at is null
            order by information_id
          `,
        ]);

        return {
          findings,
          evidence: evidenceItems,
          documents,
          information,
        };
      });
    },

    async summary(filter) {
      return tx(async (sql) => {
        const [row] = await sql<
          {
            total: string;
            drafts: string;
            in_review: string;
            final: string;
            delivered: string;
          }[]
        >`
          select
            count(*) as total,
            count(*) filter (where r.status = 'draft') as drafts,
            count(*) filter (
              where r.status in ('investigator_review', 'supervisor_review',
                                 'qa_review', 'approval')
            ) as in_review,
            count(*) filter (where r.status = 'final') as final,
            count(*) filter (where r.status = 'delivered') as delivered
          from reporting.reports r
          where r.deleted_at is null
            and (${filter.caseId ?? null}::uuid is null
                 or r.case_id = ${filter.caseId ?? null}::uuid)
        `;

        return {
          total: Number(row.total),
          drafts: Number(row.drafts),
          inReview: Number(row.in_review),
          final: Number(row.final),
          delivered: Number(row.delivered),
        };
      });
    },
  };
}

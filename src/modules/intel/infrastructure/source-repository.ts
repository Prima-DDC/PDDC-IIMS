import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { IntelError } from "../domain/errors";
import type { Corroboration, Information, InformationEvidence, Source } from "../domain/types";
import type {
  InformationRepository,
  SourceRepository,
} from "../application/ports";

/**
 * Sources and information (PRD 6.4, 15).
 *
 * The thing to notice is what the two selects do NOT do: they never combine
 * a source's reliability with a piece of information's credibility. PRD 6.4
 * rates them separately, and every read here carries both so a screen can
 * show both. A single quality number would be easier to display and would
 * lose the distinction the whole module exists for.
 *
 * The second thing is the identity of a human source. It is held on the
 * source row, and the select below returns it only to somebody whose
 * clearance reaches STRICTLY_RESTRICTED. For anybody else the columns come
 * back null with `identity_withheld` true, which is not the same as the
 * source having no identity recorded, and the screen says which it is.
 */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

const SOURCE_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    s.id, s.source_id, s.case_id, c.case_id as case_reference,
    s.source_type, s.description, s.date_obtained,
    s.obtained_by, ob.full_name as obtained_by_name,
    s.source_reliability, s.access_restrictions, s.verification_status,
    s.identity_restricted,
    -- Need-to-know, decided here rather than in the application: a query
    -- that forgot the check would leak a human source's name, and that is
    -- the one failure in this module that cannot be undone.
    case when not s.identity_restricted
           or iam.has_permission('sources', 'view', 'STRICTLY_RESTRICTED')
         then s.identity_name end as identity_name,
    case when not s.identity_restricted
           or iam.has_permission('sources', 'view', 'STRICTLY_RESTRICTED')
         then s.identity_contact end as identity_contact,
    case when not s.identity_restricted
           or iam.has_permission('sources', 'view', 'STRICTLY_RESTRICTED')
         then s.identity_notes end as identity_notes,
    (
      s.identity_restricted
      and s.identity_name is not null
      and not iam.has_permission('sources', 'view', 'STRICTLY_RESTRICTED')
    ) as identity_withheld,
    s.classification,
    (
      select count(*) from intel.information i
      where i.source_id = s.id and i.deleted_at is null
    ) as information_count,
    s.created_at, s.updated_at, s.version, s.deleted_at
  from intel.sources s
  join casework.cases c on c.id = s.case_id
  left join directory ob on ob.user_id = s.obtained_by
`;

interface SourceRow {
  id: string;
  source_id: string;
  case_id: string;
  case_reference: string;
  source_type: Source["sourceType"];
  description: string;
  date_obtained: string;
  obtained_by: string;
  obtained_by_name: string | null;
  source_reliability: Source["sourceReliability"];
  access_restrictions: string | null;
  verification_status: Source["verificationStatus"];
  identity_restricted: boolean;
  identity_name: string | null;
  identity_contact: string | null;
  identity_notes: string | null;
  identity_withheld: boolean;
  classification: Source["classification"];
  information_count: string;
  created_at: string;
  updated_at: string;
  version: number;
  deleted_at: string | null;
}

function toSource(row: SourceRow): Source {
  return {
    id: row.id,
    sourceId: row.source_id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    sourceType: row.source_type,
    description: row.description,
    dateObtained: row.date_obtained,
    obtainedBy: row.obtained_by,
    obtainedByName: row.obtained_by_name,
    sourceReliability: row.source_reliability,
    accessRestrictions: row.access_restrictions,
    verificationStatus: row.verification_status,
    identityRestricted: row.identity_restricted,
    identityName: row.identity_name,
    identityContact: row.identity_contact,
    identityNotes: row.identity_notes,
    identityWithheld: row.identity_withheld,
    classification: row.classification,
    informationCount: Number(row.information_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
  };
}

const INFORMATION_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    i.id, i.information_id, i.case_id, c.case_id as case_reference,
    i.source_id, s.source_id as source_reference, s.description as source_description,
    s.source_type, s.source_reliability,
    i.date_obtained, i.description, i.information_credibility,
    i.verification_status, i.confidence,
    i.analyst, an.full_name as analyst_name,
    i.entity_id, e.name as entity_name, e.entity_id as entity_reference,
    i.classification,
    (
      select count(*) from intel.information_corroboration ic
      where ic.information_id = i.id
    ) as corroboration_count,
    (
      select count(*) from intel.information_evidence ie
      where ie.information_id = i.id
    ) as evidence_count,
    i.created_at, i.updated_at, i.version, i.deleted_at
  from intel.information i
  join casework.cases c on c.id = i.case_id
  join intel.sources s on s.id = i.source_id
  left join intel.entities e on e.id = i.entity_id
  left join directory an on an.user_id = i.analyst
`;

interface InformationRow {
  id: string;
  information_id: string;
  case_id: string;
  case_reference: string;
  source_id: string;
  source_reference: string;
  source_description: string;
  source_type: Information["sourceType"];
  source_reliability: Information["sourceReliability"];
  date_obtained: string;
  description: string;
  information_credibility: Information["informationCredibility"];
  verification_status: Information["verificationStatus"];
  confidence: Information["confidence"];
  analyst: string | null;
  analyst_name: string | null;
  entity_id: string | null;
  entity_name: string | null;
  entity_reference: string | null;
  classification: Information["classification"];
  corroboration_count: string;
  evidence_count: string;
  created_at: string;
  updated_at: string;
  version: number;
  deleted_at: string | null;
}

function toInformation(row: InformationRow): Information {
  return {
    id: row.id,
    informationId: row.information_id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    sourceId: row.source_id,
    sourceReference: row.source_reference,
    sourceDescription: row.source_description,
    sourceType: row.source_type,
    sourceReliability: row.source_reliability,
    dateObtained: row.date_obtained,
    description: row.description,
    informationCredibility: row.information_credibility,
    verificationStatus: row.verification_status,
    confidence: row.confidence,
    analyst: row.analyst,
    analystName: row.analyst_name,
    entityId: row.entity_id,
    entityName: row.entity_name,
    entityReference: row.entity_reference,
    classification: row.classification,
    corroborationCount: Number(row.corroboration_count),
    evidenceCount: Number(row.evidence_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
  };
}

function transactor(actor: ActorContext, existing?: postgres.TransactionSql) {
  return async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };
}

export function createSourceRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): SourceRepository {
  const tx = transactor(actor, existing);

  const load = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Source | null> => {
    const rows = await sql<SourceRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${SOURCE_SELECT(sql)}
      where s.id = ${id}::uuid
    `;
    return rows.length > 0 ? toSource(rows[0]) : null;
  };

  const readBack = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Source> => {
    const source = await load(sql, id);
    if (!source) {
      throw new IntelError(
        "not_found",
        // The common cause: a human source is raised to STRICTLY_RESTRICTED
        // by the trigger, and somebody whose clearance stops below that can
        // record one and then not see it.
        "That source was recorded but cannot be read back. A human source is strictly restricted automatically, which may now put it above your clearance.",
      );
    }
    return source;
  };

  return {
    async list(filter) {
      return tx(async (sql) => {
        const limit = Math.min(filter.limit ?? 25, 200);
        const offset = filter.offset ?? 0;

        const where = [
          filter.onlyDeleted
            ? sql`s.deleted_at is not null`
            : filter.includeDeleted
              ? sql`true`
              : sql`s.deleted_at is null`,
          filter.caseId ? sql`s.case_id = ${filter.caseId}::uuid` : sql`true`,
          filter.sourceType ? sql`s.source_type = ${filter.sourceType}` : sql`true`,
          filter.sourceReliability
            ? sql`s.source_reliability = ${filter.sourceReliability}`
            : sql`true`,
          filter.verificationStatus
            ? sql`s.verification_status = ${filter.verificationStatus}`
            : sql`true`,
          filter.search
            ? sql`(
                s.description ilike ${"%" + filter.search + "%"}
                or s.source_id ilike ${"%" + filter.search + "%"}
              )`
            : sql`true`,
        ];
        const condition = where.reduce(
          (acc, clause) => sql`${acc} and ${clause}`,
          sql`true`,
        );

        const [rows, counted] = await Promise.all([
          sql<SourceRow[]>`
            with directory as (${DIRECTORY(sql)})
            ${SOURCE_SELECT(sql)}
            where ${condition}
            order by s.date_obtained desc, s.source_id desc
            limit ${limit} offset ${offset}
          `,
          sql<{ total: string }[]>`
            select count(*) as total from intel.sources s where ${condition}
          `,
        ]);

        return { rows: rows.map(toSource), total: Number(counted[0].total) };
      });
    },

    async findById(id) {
      return tx((sql) => load(sql, id));
    },

    async create(input) {
      return tx(async (sql) => {
        const [created] = await sql<{ id: string; source_id: string }[]>`
          insert into intel.sources (
            case_id, source_type, description, date_obtained, obtained_by,
            source_reliability, access_restrictions, identity_restricted,
            identity_name, identity_contact, identity_notes, classification,
            created_by, updated_by
          ) values (
            ${input.caseId}::uuid, ${input.sourceType}, ${input.description},
            ${input.dateObtained}::date, ${input.obtainedBy}::uuid,
            ${input.sourceReliability}, ${input.accessRestrictions ?? null},
            -- The trigger sets this for a human source whatever is passed;
            -- passing it here lets an identity be recorded in the same
            -- insert, which the CHECK constraint would otherwise refuse.
            ${input.sourceType === "human_source"},
            ${input.identityName ?? null}, ${input.identityContact ?? null},
            ${input.identityNotes ?? null}, ${input.classification},
            ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id, source_id
        `;

        await sql`
          select audit.write(
            'source.created', 'intel.sources', ${created.id},
            ${input.caseId}::uuid, null,
            ${sql.json({
              sourceId: created.source_id,
              sourceType: input.sourceType,
              sourceReliability: input.sourceReliability,
            })},
            ${
              input.sourceType === "human_source"
                ? "a human source, recorded strictly restricted with its identity protected (PRD 6.4)"
                : null
            },
            ${input.classification}
          )
        `;

        return readBack(sql, created.id);
      });
    },

    async update(id, input, expectedVersion) {
      return tx(async (sql) => {
        const before = await load(sql, id);
        if (!before) {
          throw new IntelError("not_found", "That source no longer exists.");
        }
        if (before.version !== expectedVersion) {
          throw new IntelError(
            "stale_version",
            "Somebody else changed this source while you were editing it. Reload and apply your change again.",
          );
        }

        // An identity cannot be written by somebody who cannot read it: they
        // would be overwriting a value they never saw.
        const touchesIdentity =
          input.identityName !== undefined ||
          input.identityContact !== undefined ||
          input.identityNotes !== undefined;
        if (touchesIdentity && before.identityWithheld) {
          throw new IntelError(
            "source_protected",
            "This source's identity is withheld from you, so you cannot change it.",
          );
        }

        const result = await sql`
          update intel.sources set
            source_type = coalesce(${input.sourceType ?? null}, source_type),
            description = coalesce(${input.description ?? null}, description),
            source_reliability = coalesce(
              ${input.sourceReliability ?? null}, source_reliability
            ),
            access_restrictions = ${input.accessRestrictions ?? null},
            verification_status = coalesce(
              ${input.verificationStatus ?? null}, verification_status
            ),
            identity_name = case when ${touchesIdentity}
              then ${input.identityName ?? null} else identity_name end,
            identity_contact = case when ${touchesIdentity}
              then ${input.identityContact ?? null} else identity_contact end,
            identity_notes = case when ${touchesIdentity}
              then ${input.identityNotes ?? null} else identity_notes end,
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
            'source.updated', 'intel.sources', ${id}, ${after.caseId}::uuid,
            ${sql.json({
              sourceReliability: before.sourceReliability,
              verificationStatus: before.verificationStatus,
            })},
            ${sql.json({
              sourceReliability: after.sourceReliability,
              verificationStatus: after.verificationStatus,
            })},
            null, ${after.classification}
          )
        `;
        return after;
      });
    },

    async softDelete(id, reason) {
      await tx(async (sql) => {
        const existing = await sql<{ case_id: string; classification: string }[]>`
          select case_id, classification from intel.sources
          where id = ${id}::uuid and deleted_at is null
        `;
        const result = await sql`
          update intel.sources
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (existing.length === 0 || result.count === 0) {
          throw new IntelError("not_found", "That source no longer exists.");
        }

        await sql`
          select audit.write(
            'source.removed', 'intel.sources', ${id},
            ${existing[0].case_id}::uuid, null, null, ${reason},
            ${existing[0].classification}
          )
        `;
      });
    },

    async restore(id, reason) {
      await tx(async (sql) => {
        const result = await sql`
          update intel.sources
          set deleted_at = null, deleted_by = null, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is not null
        `;
        if (result.count === 0) {
          throw new IntelError("not_found", "That source is not in the recycle bin.");
        }
        await sql`
          select audit.write(
            'source.restored', 'intel.sources', ${id}, null, null, null,
            ${reason}, null
          )
        `;
      });
    },

    async summary(filter) {
      return tx(async (sql) => {
        const [row] = await sql<
          {
            total: string;
            reliable: string;
            human_sources: string;
            unverified: string;
          }[]
        >`
          select
            count(*) as total,
            count(*) filter (
              where s.source_reliability in ('reliable', 'usually_reliable')
            ) as reliable,
            count(*) filter (where s.source_type = 'human_source') as human_sources,
            count(*) filter (where s.verification_status = 'unverified') as unverified
          from intel.sources s
          where s.deleted_at is null
            and (${filter.caseId ?? null}::uuid is null
                 or s.case_id = ${filter.caseId ?? null}::uuid)
        `;

        return {
          total: Number(row.total),
          reliable: Number(row.reliable),
          humanSources: Number(row.human_sources),
          unverified: Number(row.unverified),
        };
      });
    },
  };
}

export function createInformationRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): InformationRepository {
  const tx = transactor(actor, existing);

  const load = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Information | null> => {
    const rows = await sql<InformationRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${INFORMATION_SELECT(sql)}
      where i.id = ${id}::uuid
    `;
    return rows.length > 0 ? toInformation(rows[0]) : null;
  };

  const readBack = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Information> => {
    const information = await load(sql, id);
    if (!information) {
      throw new IntelError(
        "not_found",
        "That was recorded but cannot be read back, which means your permissions do not reach it.",
      );
    }
    return information;
  };

  return {
    async list(filter) {
      return tx(async (sql) => {
        const limit = Math.min(filter.limit ?? 25, 200);
        const offset = filter.offset ?? 0;

        const where = [
          filter.onlyDeleted
            ? sql`i.deleted_at is not null`
            : filter.includeDeleted
              ? sql`true`
              : sql`i.deleted_at is null`,
          filter.caseId ? sql`i.case_id = ${filter.caseId}::uuid` : sql`true`,
          filter.sourceId ? sql`i.source_id = ${filter.sourceId}::uuid` : sql`true`,
          filter.entityId ? sql`i.entity_id = ${filter.entityId}::uuid` : sql`true`,
          filter.credibility
            ? sql`i.information_credibility = ${filter.credibility}`
            : sql`true`,
          filter.verificationStatus
            ? sql`i.verification_status = ${filter.verificationStatus}`
            : sql`true`,
          // Nothing bears it out, which on a case is the list to work
          // through: an uncorroborated statement is where the next task
          // comes from.
          filter.uncorroboratedOnly
            ? sql`not exists (
                select 1 from intel.information_corroboration ic
                where ic.information_id = i.id
              )
              and not exists (
                select 1 from intel.information_evidence ie
                where ie.information_id = i.id
              )`
            : sql`true`,
          filter.search
            ? sql`(
                i.description ilike ${"%" + filter.search + "%"}
                or i.information_id ilike ${"%" + filter.search + "%"}
              )`
            : sql`true`,
        ];
        const condition = where.reduce(
          (acc, clause) => sql`${acc} and ${clause}`,
          sql`true`,
        );

        const [rows, counted] = await Promise.all([
          sql<InformationRow[]>`
            with directory as (${DIRECTORY(sql)})
            ${INFORMATION_SELECT(sql)}
            where ${condition}
            order by i.date_obtained desc, i.information_id desc
            limit ${limit} offset ${offset}
          `,
          sql<{ total: string }[]>`
            select count(*) as total from intel.information i where ${condition}
          `,
        ]);

        return { rows: rows.map(toInformation), total: Number(counted[0].total) };
      });
    },

    async findById(id) {
      return tx((sql) => load(sql, id));
    },

    async create(input) {
      return tx(async (sql) => {
        const [created] = await sql<{ id: string; information_id: string }[]>`
          insert into intel.information (
            case_id, source_id, date_obtained, description,
            information_credibility, confidence, analyst, entity_id,
            classification, created_by, updated_by
          ) values (
            ${input.caseId}::uuid, ${input.sourceId}::uuid,
            ${input.dateObtained}::date, ${input.description},
            ${input.informationCredibility}, ${input.confidence},
            ${input.analyst ?? actor.userId}::uuid, ${input.entityId ?? null}::uuid,
            ${input.classification}, ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id, information_id
        `;

        await sql`
          select audit.write(
            'information.created', 'intel.information', ${created.id},
            ${input.caseId}::uuid, null,
            ${sql.json({
              informationId: created.information_id,
              sourceId: input.sourceId,
              credibility: input.informationCredibility,
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
          throw new IntelError("not_found", "That no longer exists.");
        }
        if (before.version !== expectedVersion) {
          throw new IntelError(
            "stale_version",
            "Somebody else changed this while you were editing it. Reload and apply your change again.",
          );
        }

        const result = await sql`
          update intel.information set
            description = coalesce(${input.description ?? null}, description),
            information_credibility = coalesce(
              ${input.informationCredibility ?? null}, information_credibility
            ),
            verification_status = coalesce(
              ${input.verificationStatus ?? null}, verification_status
            ),
            confidence = coalesce(${input.confidence ?? null}, confidence),
            entity_id = ${input.entityId ?? null}::uuid,
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
            'information.updated', 'intel.information', ${id},
            ${after.caseId}::uuid,
            ${sql.json({
              credibility: before.informationCredibility,
              verificationStatus: before.verificationStatus,
            })},
            ${sql.json({
              credibility: after.informationCredibility,
              verificationStatus: after.verificationStatus,
            })},
            null, ${after.classification}
          )
        `;
        return after;
      });
    },

    async softDelete(id, reason) {
      await tx(async (sql) => {
        const existing = await sql<{ case_id: string; classification: string }[]>`
          select case_id, classification from intel.information
          where id = ${id}::uuid and deleted_at is null
        `;
        const result = await sql`
          update intel.information
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (existing.length === 0 || result.count === 0) {
          throw new IntelError("not_found", "That no longer exists.");
        }

        await sql`
          select audit.write(
            'information.removed', 'intel.information', ${id},
            ${existing[0].case_id}::uuid, null, null, ${reason},
            ${existing[0].classification}
          )
        `;
      });
    },

    async restore(id, reason) {
      await tx(async (sql) => {
        const result = await sql`
          update intel.information
          set deleted_at = null, deleted_by = null, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is not null
        `;
        if (result.count === 0) {
          throw new IntelError("not_found", "That is not in the recycle bin.");
        }
        await sql`
          select audit.write(
            'information.restored', 'intel.information', ${id}, null, null,
            null, ${reason}, null
          )
        `;
      });
    },

    async corroborations(informationId) {
      return tx(async (sql) => {
        const rows = await sql<
          {
            id: string;
            information_id: string;
            corroborating_information_id: string;
            corroborating_reference: string;
            corroborating_description: string;
            corroborating_source_reference: string;
            corroborating_source_reliability: Corroboration["corroboratingSourceReliability"];
            note: string | null;
            created_at: string;
          }[]
        >`
          select
            ic.id, ic.information_id, ic.corroborating_information_id,
            ci.information_id as corroborating_reference,
            ci.description as corroborating_description,
            cs.source_id as corroborating_source_reference,
            cs.source_reliability as corroborating_source_reliability,
            ic.note, ic.created_at
          from intel.information_corroboration ic
          join intel.information ci on ci.id = ic.corroborating_information_id
          join intel.sources cs on cs.id = ci.source_id
          where ic.information_id = ${informationId}::uuid
          order by ic.created_at
        `;

        return rows.map((row) => ({
          id: row.id,
          informationId: row.information_id,
          corroboratingInformationId: row.corroborating_information_id,
          corroboratingReference: row.corroborating_reference,
          corroboratingDescription: row.corroborating_description,
          corroboratingSourceReference: row.corroborating_source_reference,
          corroboratingSourceReliability: row.corroborating_source_reliability,
          note: row.note,
          createdAt: row.created_at,
        }));
      });
    },

    async addCorroboration(input) {
      await tx(async (sql) => {
        const inserted = await sql`
          insert into intel.information_corroboration (
            information_id, corroborating_information_id, note, created_by
          ) values (
            ${input.informationId}::uuid, ${input.corroboratingInformationId}::uuid,
            ${input.note ?? null}, ${actor.userId}::uuid
          )
          on conflict (information_id, corroborating_information_id) do nothing
        `;
        if (inserted.count === 0) {
          throw new IntelError(
            "conflict",
            "That is already recorded as corroborating this.",
          );
        }

        await sql`
          select audit.write(
            'information.corroborated', 'intel.information', ${input.informationId},
            null, null,
            ${sql.json({ corroboratingInformationId: input.corroboratingInformationId })},
            ${input.note ?? null}, null
          )
        `;
      });
    },

    async removeCorroboration(id) {
      await tx(async (sql) => {
        const [removed] = await sql<{ information_id: string }[]>`
          delete from intel.information_corroboration where id = ${id}::uuid
          returning information_id
        `;
        if (!removed) {
          throw new IntelError("not_found", "That link no longer exists.");
        }
        await sql`
          select audit.write(
            'information.corroboration_removed', 'intel.information',
            ${removed.information_id}, null, null, null, null, null
          )
        `;
      });
    },

    async evidence(informationId) {
      return tx(async (sql) => {
        const rows = await sql<
          {
            id: string;
            information_id: string;
            evidence_item_id: string;
            evidence_reference: string;
            evidence_description: string;
            note: string | null;
            created_at: string;
          }[]
        >`
          select
            ie.id, ie.information_id, ie.evidence_item_id,
            e.evidence_id as evidence_reference,
            e.description as evidence_description,
            ie.note, ie.created_at
          from intel.information_evidence ie
          join evidence.evidence_items e on e.id = ie.evidence_item_id
          where ie.information_id = ${informationId}::uuid
          order by ie.created_at
        `;

        return rows.map(
          (row): InformationEvidence => ({
            id: row.id,
            informationId: row.information_id,
            evidenceItemId: row.evidence_item_id,
            evidenceReference: row.evidence_reference,
            evidenceDescription: row.evidence_description,
            note: row.note,
            createdAt: row.created_at,
          }),
        );
      });
    },

    async linkEvidence(input) {
      await tx(async (sql) => {
        const inserted = await sql`
          insert into intel.information_evidence (
            information_id, evidence_item_id, note, created_by
          ) values (
            ${input.informationId}::uuid, ${input.evidenceItemId}::uuid,
            ${input.note ?? null}, ${actor.userId}::uuid
          )
          on conflict (information_id, evidence_item_id) do nothing
        `;
        if (inserted.count === 0) {
          throw new IntelError("conflict", "That evidence is already linked.");
        }

        await sql`
          select audit.write(
            'information.evidence_linked', 'intel.information',
            ${input.informationId}, null, null,
            ${sql.json({ evidenceItemId: input.evidenceItemId })},
            ${input.note ?? null}, null
          )
        `;
      });
    },

    async unlinkEvidence(id) {
      await tx(async (sql) => {
        const [removed] = await sql<{ information_id: string }[]>`
          delete from intel.information_evidence where id = ${id}::uuid
          returning information_id
        `;
        if (!removed) {
          throw new IntelError("not_found", "That link no longer exists.");
        }
        await sql`
          select audit.write(
            'information.evidence_unlinked', 'intel.information',
            ${removed.information_id}, null, null, null, null, null
          )
        `;
      });
    },

    async citedByFindings(informationId) {
      return tx(async (sql) => {
        const [row] = await sql<{ total: string }[]>`
          select count(*) as total
          from intel.finding_links l
          join intel.findings f on f.id = l.finding_id
          where l.information_id = ${informationId}::uuid
            and f.deleted_at is null
        `;
        return Number(row.total);
      });
    },

    async summary(filter) {
      return tx(async (sql) => {
        const [row] = await sql<
          {
            total: string;
            confirmed: string;
            uncorroborated: string;
            contradicted: string;
          }[]
        >`
          select
            count(*) as total,
            count(*) filter (where i.information_credibility = 'confirmed') as confirmed,
            count(*) filter (
              where not exists (
                select 1 from intel.information_corroboration ic
                where ic.information_id = i.id
              )
              and not exists (
                select 1 from intel.information_evidence ie
                where ie.information_id = i.id
              )
            ) as uncorroborated,
            count(*) filter (where i.verification_status = 'contradicted') as contradicted
          from intel.information i
          where i.deleted_at is null
            and (${filter.caseId ?? null}::uuid is null
                 or i.case_id = ${filter.caseId ?? null}::uuid)
        `;

        return {
          total: Number(row.total),
          confirmed: Number(row.confirmed),
          uncorroborated: Number(row.uncorroborated),
          contradicted: Number(row.contradicted),
        };
      });
    },
  };
}

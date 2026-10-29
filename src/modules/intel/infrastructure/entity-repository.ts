import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { IntelError } from "../domain/errors";
import { orderedPair } from "../domain/policies";
import type {
  CaseSubject,
  Entity,
  EntityMerge,
  MatchFlag,
  Relationship,
} from "../domain/types";
import type {
  CaseSubjectRepository,
  EntityRepository,
  RelationshipRepository,
  ResolutionRepository,
} from "../application/ports";

/**
 * Entities, the cases they appear on, their relationships, and entity
 * resolution (PRD 8.4, 15).
 *
 * Four repositories in one file because they are four views of one subject.
 * The merge is the part worth reading: PRD 8.4 says merges are reversible and
 * never delete source records, so `merge` moves rows and writes down exactly
 * what it moved, and `reverse` reads that record rather than trying to work
 * out afterwards which aliases used to belong to which record.
 */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

const ENTITY_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    e.id, e.entity_id, e.entity_type, e.name, e.normalised_name,
    e.registration_no, e.id_reference_hint,
    (e.id_reference_encrypted is not null) as has_id_reference,
    e.nationality, nat.name as nationality_name,
    e.country, ctry.name as country_name,
    e.address, e.date_of_birth, e.incorporated_on, e.notes,
    e.resolution_status, e.merged_into_id, into_e.entity_id as merged_into_reference,
    e.classification,
    e.created_at, e.created_by, cb.full_name as created_by_name,
    e.updated_at, e.version, e.deleted_at,
    (
      select count(*) from intel.case_subjects s
      where s.entity_id = e.id and s.removed_at is null
    ) as case_count,
    (
      select count(*) from intel.entity_match_flags f
      where (f.entity_a_id = e.id or f.entity_b_id = e.id) and f.status = 'open'
    ) as open_match_flags,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', a.id, 'entityId', a.entity_id, 'alias', a.alias,
            'aliasType', a.alias_type, 'sourceNote', a.source_note
          ) order by a.alias
        )
        from intel.entity_aliases a where a.entity_id = e.id
      ),
      '[]'::jsonb
    ) as aliases
  from intel.entities e
  left join intel.entities into_e on into_e.id = e.merged_into_id
  left join iam.countries nat on nat.code = e.nationality
  left join iam.countries ctry on ctry.code = e.country
  left join directory cb on cb.user_id = e.created_by
`;

interface EntityRow {
  id: string;
  entity_id: string;
  entity_type: Entity["entityType"];
  name: string;
  normalised_name: string;
  registration_no: string | null;
  id_reference_hint: string | null;
  has_id_reference: boolean;
  nationality: string | null;
  nationality_name: string | null;
  country: string | null;
  country_name: string | null;
  address: string | null;
  date_of_birth: string | null;
  incorporated_on: string | null;
  notes: string | null;
  resolution_status: Entity["resolutionStatus"];
  merged_into_id: string | null;
  merged_into_reference: string | null;
  classification: Entity["classification"];
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: string;
  version: number;
  deleted_at: string | null;
  case_count: string;
  open_match_flags: string;
  aliases: Entity["aliases"];
}

function toEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    entityId: row.entity_id,
    entityType: row.entity_type,
    name: row.name,
    normalisedName: row.normalised_name,
    registrationNo: row.registration_no,
    idReferenceHint: row.id_reference_hint,
    hasIdReference: row.has_id_reference,
    nationality: row.nationality,
    nationalityName: row.nationality_name,
    country: row.country,
    countryName: row.country_name,
    address: row.address,
    dateOfBirth: row.date_of_birth,
    incorporatedOn: row.incorporated_on,
    notes: row.notes,
    resolutionStatus: row.resolution_status,
    mergedIntoId: row.merged_into_id,
    mergedIntoReference: row.merged_into_reference,
    classification: row.classification,
    aliases: row.aliases,
    caseCount: Number(row.case_count),
    openMatchFlags: Number(row.open_match_flags),
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
  };
}

const SUBJECT_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    s.id, s.case_id, c.case_id as case_reference,
    s.entity_id, e.entity_id as entity_reference, e.name as entity_name,
    e.entity_type, e.classification as entity_classification,
    s.subject_role, s.relationship_to_case,
    s.removed_at, s.removal_reason,
    s.created_at, cb.full_name as created_by_name, s.version
  from intel.case_subjects s
  join casework.cases c on c.id = s.case_id
  join intel.entities e on e.id = s.entity_id
  left join directory cb on cb.user_id = s.created_by
`;

interface SubjectRow {
  id: string;
  case_id: string;
  case_reference: string;
  entity_id: string;
  entity_reference: string;
  entity_name: string;
  entity_type: CaseSubject["entityType"];
  entity_classification: CaseSubject["entityClassification"];
  subject_role: CaseSubject["subjectRole"];
  relationship_to_case: string | null;
  removed_at: string | null;
  removal_reason: string | null;
  created_at: string;
  created_by_name: string | null;
  version: number;
}

function toSubject(row: SubjectRow): CaseSubject {
  return {
    id: row.id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    entityId: row.entity_id,
    entityReference: row.entity_reference,
    entityName: row.entity_name,
    entityType: row.entity_type,
    entityClassification: row.entity_classification,
    subjectRole: row.subject_role,
    relationshipToCase: row.relationship_to_case,
    removedAt: row.removed_at,
    removalReason: row.removal_reason,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    version: row.version,
  };
}

const RELATIONSHIP_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    r.id,
    r.from_entity_id, fe.name as from_entity_name, fe.entity_id as from_entity_reference,
    r.to_entity_id, te.name as to_entity_name, te.entity_id as to_entity_reference,
    r.relationship_type, r.description, r.percentage, r.held_from, r.held_to,
    r.source_id, s.source_id as source_reference,
    r.evidence_item_id, ev.evidence_id as evidence_reference,
    r.confidence, r.created_at, cb.full_name as created_by_name,
    r.version, r.deleted_at
  from intel.relationships r
  join intel.entities fe on fe.id = r.from_entity_id
  join intel.entities te on te.id = r.to_entity_id
  left join intel.sources s on s.id = r.source_id
  left join evidence.evidence_items ev on ev.id = r.evidence_item_id
  left join directory cb on cb.user_id = r.created_by
`;

interface RelationshipRow {
  id: string;
  from_entity_id: string;
  from_entity_name: string;
  from_entity_reference: string;
  to_entity_id: string;
  to_entity_name: string;
  to_entity_reference: string;
  relationship_type: Relationship["relationshipType"];
  description: string | null;
  percentage: string | null;
  held_from: string | null;
  held_to: string | null;
  source_id: string | null;
  source_reference: string | null;
  evidence_item_id: string | null;
  evidence_reference: string | null;
  confidence: Relationship["confidence"];
  created_at: string;
  created_by_name: string | null;
  version: number;
  deleted_at: string | null;
}

function toRelationship(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    fromEntityId: row.from_entity_id,
    fromEntityName: row.from_entity_name,
    fromEntityReference: row.from_entity_reference,
    toEntityId: row.to_entity_id,
    toEntityName: row.to_entity_name,
    toEntityReference: row.to_entity_reference,
    relationshipType: row.relationship_type,
    description: row.description,
    percentage: row.percentage === null ? null : Number(row.percentage),
    heldFrom: row.held_from,
    heldTo: row.held_to,
    sourceId: row.source_id,
    sourceReference: row.source_reference,
    evidenceItemId: row.evidence_item_id,
    evidenceReference: row.evidence_reference,
    confidence: row.confidence,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    version: row.version,
    deletedAt: row.deleted_at,
  };
}

const FLAG_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    f.id,
    f.entity_a_id, ea.name as entity_a_name, ea.entity_id as entity_a_reference,
    f.entity_b_id, eb.name as entity_b_name, eb.entity_id as entity_b_reference,
    f.flag_type, f.similarity_score, f.detected_by, f.notes, f.status,
    f.decided_by, db.full_name as decided_by_name, f.decided_at,
    f.decision_reason, f.created_at, f.version
  from intel.entity_match_flags f
  join intel.entities ea on ea.id = f.entity_a_id
  join intel.entities eb on eb.id = f.entity_b_id
  left join directory db on db.user_id = f.decided_by
`;

interface FlagRow {
  id: string;
  entity_a_id: string;
  entity_a_name: string;
  entity_a_reference: string;
  entity_b_id: string;
  entity_b_name: string;
  entity_b_reference: string;
  flag_type: MatchFlag["flagType"];
  similarity_score: string | null;
  detected_by: MatchFlag["detectedBy"];
  notes: string | null;
  status: MatchFlag["status"];
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  created_at: string;
  version: number;
}

function toFlag(row: FlagRow): MatchFlag {
  return {
    id: row.id,
    entityAId: row.entity_a_id,
    entityAName: row.entity_a_name,
    entityAReference: row.entity_a_reference,
    entityBId: row.entity_b_id,
    entityBName: row.entity_b_name,
    entityBReference: row.entity_b_reference,
    flagType: row.flag_type,
    similarityScore:
      row.similarity_score === null ? null : Number(row.similarity_score),
    detectedBy: row.detected_by,
    notes: row.notes,
    status: row.status,
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    createdAt: row.created_at,
    version: row.version,
  };
}

const MERGE_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    m.id,
    m.surviving_entity_id, se.entity_id as surviving_entity_reference,
    se.name as surviving_entity_name,
    m.merged_entity_id, me.entity_id as merged_entity_reference,
    me.name as merged_entity_name,
    m.reason, m.moved,
    m.merged_by, mb.full_name as merged_by_name, m.merged_at,
    m.reversed_at, rb.full_name as reversed_by_name, m.reversal_reason
  from intel.entity_merges m
  join intel.entities se on se.id = m.surviving_entity_id
  join intel.entities me on me.id = m.merged_entity_id
  left join directory mb on mb.user_id = m.merged_by
  left join directory rb on rb.user_id = m.reversed_by
`;

interface MergeRow {
  id: string;
  surviving_entity_id: string;
  surviving_entity_reference: string;
  surviving_entity_name: string;
  merged_entity_id: string;
  merged_entity_reference: string;
  merged_entity_name: string;
  reason: string;
  moved: EntityMerge["moved"];
  merged_by: string;
  merged_by_name: string | null;
  merged_at: string;
  reversed_at: string | null;
  reversed_by_name: string | null;
  reversal_reason: string | null;
}

function toMerge(row: MergeRow): EntityMerge {
  return {
    id: row.id,
    survivingEntityId: row.surviving_entity_id,
    survivingEntityReference: row.surviving_entity_reference,
    survivingEntityName: row.surviving_entity_name,
    mergedEntityId: row.merged_entity_id,
    mergedEntityReference: row.merged_entity_reference,
    mergedEntityName: row.merged_entity_name,
    reason: row.reason,
    moved: row.moved,
    mergedBy: row.merged_by,
    mergedByName: row.merged_by_name,
    mergedAt: row.merged_at,
    reversedAt: row.reversed_at,
    reversedByName: row.reversed_by_name,
    reversalReason: row.reversal_reason,
  };
}

/* --------------------------------------------------------------------- */

function transactor(actor: ActorContext, existing?: postgres.TransactionSql) {
  return async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };
}

export function createEntityRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): EntityRepository {
  const tx = transactor(actor, existing);

  const load = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Entity | null> => {
    const rows = await sql<EntityRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${ENTITY_SELECT(sql)}
      where e.id = ${id}::uuid
    `;
    return rows.length > 0 ? toEntity(rows[0]) : null;
  };

  const readBack = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Entity> => {
    const entity = await load(sql, id);
    if (!entity) {
      throw new IntelError(
        "not_found",
        "That record was written but cannot be read back, which means your permissions do not reach it.",
      );
    }
    return entity;
  };

  return {
    async list(filter) {
      return tx(async (sql) => {
        const limit = Math.min(filter.limit ?? 25, 200);
        const offset = filter.offset ?? 0;

        const where = [
          filter.onlyDeleted
            ? sql`e.deleted_at is not null`
            : filter.includeDeleted
              ? sql`true`
              : sql`e.deleted_at is null`,
          filter.includeMerged ? sql`true` : sql`e.resolution_status <> 'merged'`,
          filter.entityType ? sql`e.entity_type = ${filter.entityType}` : sql`true`,
          filter.resolutionStatus
            ? sql`e.resolution_status = ${filter.resolutionStatus}`
            : sql`true`,
          filter.country ? sql`e.country = ${filter.country}` : sql`true`,
          filter.caseId
            ? sql`exists (
                select 1 from intel.case_subjects s
                where s.entity_id = e.id and s.case_id = ${filter.caseId}::uuid
                  and s.removed_at is null
              )`
            : sql`true`,
          filter.flaggedOnly
            ? sql`exists (
                select 1 from intel.entity_match_flags f
                where (f.entity_a_id = e.id or f.entity_b_id = e.id)
                  and f.status = 'open'
              )`
            : sql`true`,
          // Searches the name, the aliases and the registration number
          // together: an investigator looking for "ABC Ghana" should find the
          // record whose alias that is.
          filter.search
            ? sql`(
                extensions.similarity(
                  e.normalised_name, crm.normalise_name(${filter.search})
                ) >= 0.3
                or e.name ilike ${"%" + filter.search + "%"}
                or e.entity_id ilike ${"%" + filter.search + "%"}
                or e.registration_no ilike ${"%" + filter.search + "%"}
                or exists (
                  select 1 from intel.entity_aliases a
                  where a.entity_id = e.id
                    and a.alias ilike ${"%" + filter.search + "%"}
                )
              )`
            : sql`true`,
        ];

        const condition = where.reduce(
          (acc, clause) => sql`${acc} and ${clause}`,
          sql`true`,
        );

        const [rows, counted] = await Promise.all([
          sql<EntityRow[]>`
            with directory as (${DIRECTORY(sql)})
            ${ENTITY_SELECT(sql)}
            where ${condition}
            order by e.name
            limit ${limit} offset ${offset}
          `,
          sql<{ total: string }[]>`
            select count(*) as total from intel.entities e where ${condition}
          `,
        ]);

        return { rows: rows.map(toEntity), total: Number(counted[0].total) };
      });
    },

    async findById(id) {
      return tx((sql) => load(sql, id));
    },

    async create(input) {
      return tx(async (sql) => {
        const [created] = await sql<{ id: string; entity_id: string }[]>`
          insert into intel.entities (
            entity_type, name, registration_no, nationality, country, address,
            date_of_birth, incorporated_on, notes, classification, created_by,
            updated_by
          ) values (
            ${input.entityType}, ${input.name}, ${input.registrationNo ?? null},
            ${input.nationality ?? null}, ${input.country ?? null},
            ${input.address ?? null},
            ${input.dateOfBirth ?? null}::date, ${input.incorporatedOn ?? null}::date,
            ${input.notes ?? null}, ${input.classification},
            ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id, entity_id
        `;

        if (input.idReference) {
          await sql`select intel.set_id_reference(${created.id}::uuid, ${input.idReference})`;
        }

        await sql`
          select audit.write(
            'entity.created', 'intel.entities', ${created.id}, null, null,
            ${sql.json({ entityId: created.entity_id, name: input.name })},
            'registered in the entity register', ${input.classification}
          )
        `;

        return readBack(sql, created.id);
      });
    },

    async update(id, input, expectedVersion) {
      return tx(async (sql) => {
        const before = await load(sql, id);
        if (!before) {
          throw new IntelError("not_found", "That record no longer exists.");
        }
        if (before.version !== expectedVersion) {
          throw new IntelError(
            "stale_version",
            "Somebody else changed this record while you were editing it. Reload and apply your change again.",
          );
        }

        const result = await sql`
          update intel.entities set
            entity_type = coalesce(${input.entityType ?? null}, entity_type),
            name = coalesce(${input.name ?? null}, name),
            registration_no = ${input.registrationNo ?? null},
            nationality = ${input.nationality ?? null},
            country = ${input.country ?? null},
            address = ${input.address ?? null},
            date_of_birth = ${input.dateOfBirth ?? null}::date,
            incorporated_on = ${input.incorporatedOn ?? null}::date,
            notes = ${input.notes ?? null},
            classification = coalesce(${input.classification ?? null}, classification),
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${expectedVersion}
        `;
        if (result.count === 0) {
          throw new IntelError("stale_version", "That change could not be applied.");
        }

        if (input.idReference !== undefined) {
          await sql`select intel.set_id_reference(${id}::uuid, ${input.idReference})`;
        }

        const after = await readBack(sql, id);
        await sql`
          select audit.write(
            'entity.updated', 'intel.entities', ${id}, null,
            ${sql.json({ name: before.name, classification: before.classification })},
            ${sql.json({ name: after.name, classification: after.classification })},
            null, ${after.classification}
          )
        `;
        return after;
      });
    },

    async idReference(id) {
      return tx(async (sql) => {
        const [row] = await sql<{ reference: string | null }[]>`
          select intel.id_reference(${id}::uuid) as reference
        `;
        return row?.reference ?? null;
      });
    },

    async softDelete(id, reason) {
      await tx(async (sql) => {
        // Read first, write second: the soft delete cannot return the row,
        // because the SELECT policy applied to the new row excludes it. The
        // lesson of migration 0033.
        const existing = await sql<{ classification: string }[]>`
          select classification from intel.entities
          where id = ${id}::uuid and deleted_at is null
        `;
        const result = await sql`
          update intel.entities
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (existing.length === 0 || result.count === 0) {
          throw new IntelError("not_found", "That record no longer exists.");
        }

        await sql`
          select audit.write(
            'entity.removed', 'intel.entities', ${id}, null, null, null,
            ${reason}, ${existing[0].classification}
          )
        `;
      });
    },

    async restore(id, reason) {
      await tx(async (sql) => {
        const result = await sql`
          update intel.entities
          set deleted_at = null, deleted_by = null, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is not null
        `;
        if (result.count === 0) {
          throw new IntelError("not_found", "That record is not in the recycle bin.");
        }

        await sql`
          select audit.write(
            'entity.restored', 'intel.entities', ${id}, null, null, null,
            ${reason}, null
          )
        `;
      });
    },

    async addAlias(input) {
      await tx(async (sql) => {
        const inserted = await sql`
          insert into intel.entity_aliases (
            entity_id, alias, alias_type, source_note, created_by, updated_by
          ) values (
            ${input.entityId}::uuid, ${input.alias}, ${input.aliasType},
            ${input.sourceNote ?? null}, ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          on conflict (entity_id, normalised_alias) do nothing
        `;
        if (inserted.count === 0) {
          throw new IntelError(
            "conflict",
            "That alias is already recorded against this record.",
          );
        }

        await sql`
          select audit.write(
            'entity.alias_added', 'intel.entities', ${input.entityId}, null, null,
            ${sql.json({ alias: input.alias, aliasType: input.aliasType })},
            null, null
          )
        `;
      });
    },

    async removeAlias(aliasId) {
      await tx(async (sql) => {
        const [removed] = await sql<{ entity_id: string; alias: string }[]>`
          delete from intel.entity_aliases where id = ${aliasId}::uuid
          returning entity_id, alias
        `;
        if (!removed) {
          throw new IntelError("not_found", "That alias no longer exists.");
        }

        await sql`
          select audit.write(
            'entity.alias_removed', 'intel.entities', ${removed.entity_id}, null,
            ${sql.json({ alias: removed.alias })}, null, null, null
          )
        `;
      });
    },

    async subjectOf(entityId) {
      return tx(async (sql) => {
        const rows = await sql<SubjectRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${SUBJECT_SELECT(sql)}
          where s.entity_id = ${entityId}::uuid
          order by s.created_at desc
        `;
        return rows.map(toSubject);
      });
    },

    /**
     * Similar records (PRD 8.4).
     *
     * Three ways of being similar, combined with `greatest` rather than
     * averaged: a record matching strongly on its registration number is a
     * strong match whatever its name looks like, and averaging would bury it.
     * Trigram similarity catches a spelling difference, the phonetic key
     * catches a name heard rather than read, and the registration number
     * catches a company recorded under two trading names.
     */
    async findSimilar(input) {
      return tx(async (sql) => {
        const threshold = input.threshold ?? 0.3;
        const limit = Math.min(input.limit ?? 10, 50);

        // Scored first, then loaded. One query that did both would need the
        // entity select nested inside a join, and the simpler pair is easier
        // to read and no slower: both run in the same transaction.
        const scored = await sql<
          { id: string; score: string; matched_on: string }[]
        >`
          with probe as (
            select
              crm.normalise_name(${input.name}) as normalised,
              crm.phonetic_key(${input.name}) as phonetic
          )
          select
            e.id,
            greatest(
              extensions.similarity(e.normalised_name, p.normalised),
              coalesce(
                (
                  select max(extensions.similarity(a.normalised_alias, p.normalised))
                  from intel.entity_aliases a where a.entity_id = e.id
                ),
                0
              ),
              -- A name heard rather than read: "Mensah" and "Mensa" share a
              -- phonetic key and score almost nothing on trigrams. Fixed at
              -- 0.85 rather than computed, because a phonetic match either
              -- holds or it does not.
              case
                when p.phonetic is not null
                  and crm.phonetic_key(e.name) = p.phonetic then 0.85
                else 0
              end
            ) as score,
            case
              when p.phonetic is not null
                and crm.phonetic_key(e.name) = p.phonetic then 'sounds the same'
              when exists (
                select 1 from intel.entity_aliases a
                where a.entity_id = e.id
                  and extensions.similarity(a.normalised_alias, p.normalised)
                      >= ${threshold}
              ) then 'an alias'
              else 'the name'
            end as matched_on
          from intel.entities e
          cross join probe p
          where e.deleted_at is null
            and e.resolution_status <> 'merged'
            and (
              ${input.entityId ?? null}::uuid is null
              or e.id <> ${input.entityId ?? null}::uuid
            )
            and (
              ${input.entityType ?? null}::text is null
              or e.entity_type = ${input.entityType ?? null}
            )
          order by score desc
          limit ${limit}
        `;

        const matched = scored.filter((row) => Number(row.score) >= threshold);
        if (matched.length === 0) return [];

        const rows = await sql<EntityRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${ENTITY_SELECT(sql)}
          where e.id = any(${matched.map((row) => row.id)}::uuid[])
        `;

        const byId = new Map(rows.map((row) => [row.id, toEntity(row)]));
        return matched
          .map((row) => ({
            entity: byId.get(row.id),
            score: Number(row.score),
            matchedOn: row.matched_on,
          }))
          .filter(
            (match): match is { entity: Entity; score: number; matchedOn: string } =>
              match.entity !== undefined,
          );
      });
    },

    /**
     * The tab bar's intelligence figures, in one statement.
     *
     * Eight numbers from six tables, which were four repository calls and
     * four pooler connections.
     */
    async tabCounts(caseId) {
      return tx(async (sql) => {
        const [row] = await sql<
          {
            subjects: string;
            flags: string;
            sources: string;
            information: string;
            uncorroborated: string;
            findings: string;
            awaiting_review: string;
            unsupported: string;
          }[]
        >`
          select
            (
              select count(*) from intel.case_subjects s
              join intel.entities e on e.id = s.entity_id
              where s.case_id = ${caseId}::uuid and s.removed_at is null
                and e.deleted_at is null
            ) as subjects,
            -- Each flag names two entities, so counting the pairs rather than
            -- the sides is what gives the number a reader expects.
            (
              select count(distinct f.id)
              from intel.entity_match_flags f
              join intel.case_subjects s
                on s.entity_id in (f.entity_a_id, f.entity_b_id)
              where s.case_id = ${caseId}::uuid and s.removed_at is null
                and f.status = 'open'
            ) as flags,
            (
              select count(*) from intel.sources s
              where s.case_id = ${caseId}::uuid and s.deleted_at is null
            ) as sources,
            (
              select count(*) from intel.information i
              where i.case_id = ${caseId}::uuid and i.deleted_at is null
            ) as information,
            (
              select count(*) from intel.information i
              where i.case_id = ${caseId}::uuid and i.deleted_at is null
                and not exists (
                  select 1 from intel.information_corroboration ic
                  where ic.information_id = i.id
                )
                and not exists (
                  select 1 from intel.information_evidence ie
                  where ie.information_id = i.id
                )
            ) as uncorroborated,
            (
              select count(*) from intel.findings f
              where f.case_id = ${caseId}::uuid and f.deleted_at is null
            ) as findings,
            (
              select count(*) from intel.findings f
              where f.case_id = ${caseId}::uuid and f.deleted_at is null
                and f.status = 'submitted'
            ) as awaiting_review,
            (
              select count(*) from intel.findings f
              where f.case_id = ${caseId}::uuid and f.deleted_at is null
                and not exists (
                  select 1 from intel.finding_links l
                  where l.finding_id = f.id
                    and (l.information_id is not null
                         or l.evidence_item_id is not null)
                )
            ) as unsupported
        `;

        return {
          subjects: Number(row.subjects),
          subjectFlags: Number(row.flags),
          sources: Number(row.sources),
          information: Number(row.information),
          uncorroborated: Number(row.uncorroborated),
          findings: Number(row.findings),
          findingsAwaitingReview: Number(row.awaiting_review),
          unsupportedFindings: Number(row.unsupported),
        };
      });
    },

    async summary(filter) {
      return tx(async (sql) => {
        const scope = filter.caseId
          ? sql`exists (
              select 1 from intel.case_subjects s
              where s.entity_id = e.id and s.case_id = ${filter.caseId}::uuid
                and s.removed_at is null
            )`
          : sql`true`;

        const [row] = await sql<
          {
            total: string;
            people: string;
            companies: string;
            unresolved: string;
            open_flags: string;
          }[]
        >`
          select
            count(*) as total,
            count(*) filter (where e.entity_type = 'person') as people,
            count(*) filter (where e.entity_type in ('company', 'organisation')) as companies,
            count(*) filter (where e.resolution_status = 'unresolved') as unresolved,
            coalesce(sum(
              (
                select count(*) from intel.entity_match_flags f
                where (f.entity_a_id = e.id or f.entity_b_id = e.id)
                  and f.status = 'open'
              )
            ), 0) as open_flags
          from intel.entities e
          where e.deleted_at is null
            and e.resolution_status <> 'merged'
            and ${scope}
        `;

        return {
          total: Number(row.total),
          people: Number(row.people),
          companies: Number(row.companies),
          unresolved: Number(row.unresolved),
          // Each flag names two entities, so summing per entity counts it
          // twice. Halved here rather than in the query, which would need a
          // separate pass over the flags.
          openFlags: Math.ceil(Number(row.open_flags) / 2),
        };
      });
    },
  };
}

export function createCaseSubjectRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): CaseSubjectRepository {
  const tx = transactor(actor, existing);

  const load = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<CaseSubject | null> => {
    const rows = await sql<SubjectRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${SUBJECT_SELECT(sql)}
      where s.id = ${id}::uuid
    `;
    return rows.length > 0 ? toSubject(rows[0]) : null;
  };

  return {
    async forCase(caseId, includeRemoved = false) {
      return tx(async (sql) => {
        const rows = await sql<SubjectRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${SUBJECT_SELECT(sql)}
          where s.case_id = ${caseId}::uuid
            and (${includeRemoved} or s.removed_at is null)
          order by
            case s.subject_role
              when 'primary_subject' then 0
              when 'secondary_subject' then 1
              when 'person_of_interest' then 2
              else 3
            end,
            e.name
        `;
        return rows.map(toSubject);
      });
    },

    async add(input) {
      return tx(async (sql) => {
        const existingRows = await sql<{ id: string; removed_at: string | null }[]>`
          select id, removed_at from intel.case_subjects
          where case_id = ${input.caseId}::uuid and entity_id = ${input.entityId}::uuid
        `;

        // Adding back somebody taken off the case earlier is the same row
        // returning, not a second one: the unique constraint says so, and a
        // second row would make the history unreadable.
        if (existingRows.length > 0) {
          if (existingRows[0].removed_at === null) {
            throw new IntelError(
              "conflict",
              "That subject is already on this case.",
            );
          }
          await sql`
            update intel.case_subjects set
              removed_at = null, removed_by = null, removal_reason = null,
              subject_role = ${input.subjectRole},
              relationship_to_case = ${input.relationshipToCase ?? null},
              updated_by = ${actor.userId}::uuid
            where id = ${existingRows[0].id}::uuid
          `;
          const restored = await load(sql, existingRows[0].id);
          await sql`
            select audit.write(
              'case_subject.added', 'intel.case_subjects', ${existingRows[0].id},
              ${input.caseId}::uuid, null,
              ${sql.json({ entityId: input.entityId, subjectRole: input.subjectRole })},
              'put back on the case', null
            )
          `;
          if (!restored) {
            throw new IntelError("not_found", "That subject cannot be read back.");
          }
          return restored;
        }

        const [created] = await sql<{ id: string }[]>`
          insert into intel.case_subjects (
            case_id, entity_id, subject_role, relationship_to_case,
            created_by, updated_by
          ) values (
            ${input.caseId}::uuid, ${input.entityId}::uuid, ${input.subjectRole},
            ${input.relationshipToCase ?? null},
            ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'case_subject.added', 'intel.case_subjects', ${created.id},
            ${input.caseId}::uuid, null,
            ${sql.json({ entityId: input.entityId, subjectRole: input.subjectRole })},
            null, null
          )
        `;

        const subject = await load(sql, created.id);
        if (!subject) {
          throw new IntelError("not_found", "That subject cannot be read back.");
        }
        return subject;
      });
    },

    async update(id, input, expectedVersion) {
      return tx(async (sql) => {
        const result = await sql`
          update intel.case_subjects set
            subject_role = coalesce(${input.subjectRole ?? null}, subject_role),
            relationship_to_case = ${input.relationshipToCase ?? null},
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${expectedVersion}
        `;
        if (result.count === 0) {
          throw new IntelError(
            "stale_version",
            "Somebody else changed this subject while you were editing it.",
          );
        }
        const subject = await load(sql, id);
        if (!subject) {
          throw new IntelError("not_found", "That subject no longer exists.");
        }
        return subject;
      });
    },

    async remove(id, reason) {
      await tx(async (sql) => {
        const existing = await sql<{ case_id: string; entity_id: string }[]>`
          select case_id, entity_id from intel.case_subjects
          where id = ${id}::uuid and removed_at is null
        `;
        const result = await sql`
          update intel.case_subjects set
            removed_at = now(), removed_by = ${actor.userId}::uuid,
            removal_reason = ${reason}, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and removed_at is null
        `;
        if (existing.length === 0 || result.count === 0) {
          throw new IntelError("not_found", "That subject is not on this case.");
        }

        await sql`
          select audit.write(
            'case_subject.removed', 'intel.case_subjects', ${id},
            ${existing[0].case_id}::uuid, null, null, ${reason}, null
          )
        `;
      });
    },

    async restore(id, reason) {
      await tx(async (sql) => {
        const result = await sql`
          update intel.case_subjects set
            removed_at = null, removed_by = null, removal_reason = null,
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and removed_at is not null
        `;
        if (result.count === 0) {
          throw new IntelError("not_found", "That subject was not removed.");
        }

        await sql`
          select audit.write(
            'case_subject.restored', 'intel.case_subjects', ${id}, null, null,
            null, ${reason}, null
          )
        `;
      });
    },
  };
}

export function createRelationshipRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): RelationshipRepository {
  const tx = transactor(actor, existing);

  const load = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Relationship | null> => {
    const rows = await sql<RelationshipRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${RELATIONSHIP_SELECT(sql)}
      where r.id = ${id}::uuid
    `;
    return rows.length > 0 ? toRelationship(rows[0]) : null;
  };

  return {
    async forEntity(entityId) {
      return tx(async (sql) => {
        const rows = await sql<RelationshipRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${RELATIONSHIP_SELECT(sql)}
          where r.deleted_at is null
            and (r.from_entity_id = ${entityId}::uuid
                 or r.to_entity_id = ${entityId}::uuid)
          order by r.relationship_type, te.name
        `;
        return rows.map(toRelationship);
      });
    },

    /**
     * The graph, walked in SQL to a capped depth.
     *
     * A recursive CTE rather than a round trip per hop: at depth two a
     * round-trip-per-hop walk is dozens of queries on a remote database, and
     * the measured cost of that on this platform is seconds.
     */
    async graph(input) {
      return tx(async (sql) => {
        if (input.entityIds.length === 0) {
          return { entities: [], relationships: [] };
        }
        const depth = input.depth ?? 1;

        const reachable = await sql<{ id: string }[]>`
          with recursive walk as (
            select id, 0 as hop
            from intel.entities
            where id = any(${input.entityIds}::uuid[])
          union
            select
              case when r.from_entity_id = w.id then r.to_entity_id
                   else r.from_entity_id end as id,
              w.hop + 1
            from walk w
            join intel.relationships r
              on (r.from_entity_id = w.id or r.to_entity_id = w.id)
             and r.deleted_at is null
            where w.hop < ${depth}
          )
          select distinct id from walk
        `;

        const ids = reachable.map((row) => row.id);
        if (ids.length === 0) return { entities: [], relationships: [] };

        const [entities, relationships] = await Promise.all([
          sql<EntityRow[]>`
            with directory as (${DIRECTORY(sql)})
            ${ENTITY_SELECT(sql)}
            where e.id = any(${ids}::uuid[]) and e.deleted_at is null
          `,
          sql<RelationshipRow[]>`
            with directory as (${DIRECTORY(sql)})
            ${RELATIONSHIP_SELECT(sql)}
            where r.deleted_at is null
              and r.from_entity_id = any(${ids}::uuid[])
              and r.to_entity_id = any(${ids}::uuid[])
          `,
        ]);

        return {
          entities: entities.map(toEntity),
          relationships: relationships.map(toRelationship),
        };
      });
    },

    async create(input) {
      return tx(async (sql) => {
        const [created] = await sql<{ id: string }[]>`
          insert into intel.relationships (
            from_entity_id, to_entity_id, relationship_type, description,
            percentage, held_from, held_to, source_id, evidence_item_id,
            confidence, created_by, updated_by
          ) values (
            ${input.fromEntityId}::uuid, ${input.toEntityId}::uuid,
            ${input.relationshipType}, ${input.description ?? null},
            ${input.percentage ?? null}, ${input.heldFrom ?? null}::date,
            ${input.heldTo ?? null}::date, ${input.sourceId ?? null}::uuid,
            ${input.evidenceItemId ?? null}::uuid, ${input.confidence},
            ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'relationship.created', 'intel.relationships', ${created.id}, null,
            null,
            ${sql.json({
              from: input.fromEntityId,
              to: input.toEntityId,
              relationshipType: input.relationshipType,
            })},
            null, null
          )
        `;

        const relationship = await load(sql, created.id);
        if (!relationship) {
          throw new IntelError(
            "not_found",
            "That relationship was written but cannot be read back, which means it reaches an entity you cannot see.",
          );
        }
        return relationship;
      });
    },

    async update(id, input, expectedVersion) {
      return tx(async (sql) => {
        const result = await sql`
          update intel.relationships set
            relationship_type = coalesce(${input.relationshipType ?? null}, relationship_type),
            description = ${input.description ?? null},
            percentage = ${input.percentage ?? null},
            held_from = ${input.heldFrom ?? null}::date,
            held_to = ${input.heldTo ?? null}::date,
            source_id = ${input.sourceId ?? null}::uuid,
            evidence_item_id = ${input.evidenceItemId ?? null}::uuid,
            confidence = coalesce(${input.confidence ?? null}, confidence),
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${expectedVersion}
        `;
        if (result.count === 0) {
          throw new IntelError(
            "stale_version",
            "Somebody else changed this relationship while you were editing it.",
          );
        }
        const relationship = await load(sql, id);
        if (!relationship) {
          throw new IntelError("not_found", "That relationship no longer exists.");
        }
        return relationship;
      });
    },

    async softDelete(id, reason) {
      await tx(async (sql) => {
        const result = await sql`
          update intel.relationships
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (result.count === 0) {
          throw new IntelError("not_found", "That relationship no longer exists.");
        }

        await sql`
          select audit.write(
            'relationship.removed', 'intel.relationships', ${id}, null, null,
            null, ${reason}, null
          )
        `;
      });
    },
  };
}

export function createResolutionRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): ResolutionRepository {
  const tx = transactor(actor, existing);

  const loadFlag = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<MatchFlag> => {
    const rows = await sql<FlagRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${FLAG_SELECT(sql)}
      where f.id = ${id}::uuid
    `;
    if (rows.length === 0) {
      throw new IntelError("not_found", "That flag no longer exists.");
    }
    return toFlag(rows[0]);
  };

  const loadMerge = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<EntityMerge> => {
    const rows = await sql<MergeRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${MERGE_SELECT(sql)}
      where m.id = ${id}::uuid
    `;
    if (rows.length === 0) {
      throw new IntelError("not_found", "That merge record no longer exists.");
    }
    return toMerge(rows[0]);
  };

  return {
    async flags(filter) {
      return tx(async (sql) => {
        const rows = await sql<FlagRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${FLAG_SELECT(sql)}
          where (${filter.entityId ?? null}::uuid is null
                 or f.entity_a_id = ${filter.entityId ?? null}::uuid
                 or f.entity_b_id = ${filter.entityId ?? null}::uuid)
            and (${filter.status ?? null}::text is null
                 or f.status = ${filter.status ?? null})
          order by
            case when f.status = 'open' then 0 else 1 end,
            f.similarity_score desc nulls last,
            f.created_at desc
          limit ${Math.min(filter.limit ?? 50, 200)}
        `;
        return rows.map(toFlag);
      });
    },

    async flag(input) {
      return tx(async (sql) => {
        const [a, b] = orderedPair(input.entityAId, input.entityBId);

        const [created] = await sql<{ id: string }[]>`
          insert into intel.entity_match_flags (
            entity_a_id, entity_b_id, flag_type, similarity_score, detected_by,
            notes, created_by, updated_by
          ) values (
            ${a}::uuid, ${b}::uuid, ${input.flagType},
            ${input.similarityScore ?? null}, ${input.detectedBy ?? "manual"},
            ${input.notes ?? null}, ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          on conflict (entity_a_id, entity_b_id) do update
            set flag_type = excluded.flag_type,
                similarity_score = coalesce(excluded.similarity_score,
                                            intel.entity_match_flags.similarity_score),
                updated_by = ${actor.userId}::uuid
          returning id
        `;

        await sql`
          select audit.write(
            'entity.match_flagged', 'intel.entity_match_flags', ${created.id},
            null, null,
            ${sql.json({ entityA: a, entityB: b, flagType: input.flagType })},
            ${input.notes ?? null}, null
          )
        `;

        return loadFlag(sql, created.id);
      });
    },

    async decide(input) {
      return tx(async (sql) => {
        const result = await sql`
          update intel.entity_match_flags set
            status = ${input.status},
            decided_by = ${actor.userId}::uuid,
            decided_at = now(),
            decision_reason = ${input.reason},
            updated_by = ${actor.userId}::uuid
          where id = ${input.flagId}::uuid and status = 'open'
        `;
        if (result.count === 0) {
          throw new IntelError(
            "conflict",
            "That flag has already been decided, or no longer exists.",
          );
        }

        await sql`
          select audit.write(
            'entity.match_decided', 'intel.entity_match_flags', ${input.flagId},
            null, null, ${sql.json({ status: input.status })},
            ${input.reason}, null
          )
        `;

        return loadFlag(sql, input.flagId);
      });
    },

    /**
     * The merge (PRD 8.4).
     *
     * Moves rather than copies, and records what it moved. The loser's name
     * becomes an alias of the survivor, which is the detail that makes the
     * register still usable afterwards: somebody searching for the name they
     * knew finds the record that absorbed it.
     *
     * Every `on conflict do nothing` here is deliberate. The two records may
     * already share a case or an alias, and the unique constraints say so; a
     * merge that failed because both records were on the same case would be a
     * merge that failed precisely when it was most obviously right.
     */
    async merge(input) {
      return tx(async (sql) => {
        const { survivingEntityId: keep, mergedEntityId: lose } = input;

        const [loser] = await sql<{ name: string; entity_id: string }[]>`
          select name, entity_id from intel.entities where id = ${lose}::uuid
        `;
        if (!loser) {
          throw new IntelError("not_found", "That record no longer exists.");
        }

        /*
         * Every row this merge touches is recorded by identity, because that
         * is the only thing a reversal can work from. `moved` below keeps the
         * counts, which are a summary for somebody reading the log; a count
         * cannot be put back. See migration 0048.
         */
        const touched: Array<{
          table: string;
          rowId: string;
          column: string;
          action: "repointed" | "withdrawn";
        }> = [];

        const note = (
          rows: ReadonlyArray<{ id: string }>,
          table: string,
          column: string,
          action: "repointed" | "withdrawn",
        ) => {
          for (const row of rows) {
            touched.push({ table, rowId: row.id, column, action });
          }
          return rows.length;
        };

        /*
         * NOTHING HERE DELETES ANYTHING, and that is the whole design.
         *
         * Each of these used to move what it could and destroy the remainder:
         * an alias the survivor already had, a case both records were
         * subjects of, a finding both were linked to. Every one of those was
         * a row a reversal could never put back, so PRD 8.4's "reversible"
         * and "never delete source records" were both untrue.
         *
         * The rule now is that a row the survivor cannot take simply stays
         * where it is. The loser's record still exists after a merge, as the
         * pointer PRD 8.4 requires it to remain, so a row left on it is not
         * orphaned: it is still attached to the thing it was always about,
         * and a reversal finds it exactly there.
         */
        const aliases = note(
          await sql<{ id: string }[]>`
            update intel.entity_aliases set entity_id = ${keep}::uuid
            where entity_id = ${lose}::uuid
              and normalised_alias not in (
                select normalised_alias from intel.entity_aliases
                where entity_id = ${keep}::uuid
              )
            returning id
          `,
          "entity_aliases",
          "entity_id",
          "repointed",
        );
        // A colliding alias is left on the loser. The survivor already has
        // that spelling, so a search finds it either way, and moving it is
        // impossible in any case: entity_aliases is unique on
        // (entity_id, normalised_alias).

        const nameAlias = await sql`
          insert into intel.entity_aliases (
            entity_id, alias, alias_type, source_note, created_by, updated_by
          ) values (
            ${keep}::uuid, ${loser.name}, 'former_name',
            ${`from ${loser.entity_id}, merged`},
            ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          on conflict (entity_id, normalised_alias) do nothing
        `;

        const subjects = note(
          await sql<{ id: string }[]>`
            update intel.case_subjects set entity_id = ${keep}::uuid
            where entity_id = ${lose}::uuid
              and case_id not in (
                select case_id from intel.case_subjects where entity_id = ${keep}::uuid
              )
            returning id
          `,
          "case_subjects",
          "entity_id",
          "repointed",
        );

        /*
         * A case both records were subjects of.
         *
         * The row cannot move, because case_subjects is unique on
         * (case_id, entity_id) and the survivor already occupies that slot.
         * It used to be deleted, which took the loser's own subject_role and
         * relationship_to_case with it. Two roles on one case is a genuine
         * disagreement between two pieces of recorded work, and discarding
         * one of them silently is not the platform's decision to make.
         *
         * So it is withdrawn where it stands, using the removal this table
         * already has. The role and the note survive and stay readable in
         * that case's history, the case stops listing a merged record among
         * its live subjects, and a reversal has something to restore.
         */
        note(
          await sql<{ id: string }[]>`
            update intel.case_subjects set
              removed_at = now(), removed_by = ${actor.userId}::uuid,
              removal_reason = ${`merged into ${keep}, which is already a subject of this case`},
              updated_by = ${actor.userId}::uuid
            where entity_id = ${lose}::uuid and removed_at is null
            returning id
          `,
          "case_subjects",
          "removed_at",
          "withdrawn",
        );

        // A relationship whose other end is the survivor would become a loop,
        // which the table refuses, so it is withdrawn.
        //
        // Soft-deleted, not deleted. `intel.relationships` carries
        // `deleted_at` and `iims_app` is deliberately granted no DELETE on
        // it, because a relationship is a record somebody asserted and PRD
        // 8.4 requires a merge to be reversible. A hard delete here would
        // have been a row the reversal could never put back, and it would
        // have failed outright for want of the privilege.
        note(
          await sql<{ id: string }[]>`
            update intel.relationships
            set deleted_at = now(), updated_by = ${actor.userId}::uuid
            where deleted_at is null
              and ((from_entity_id = ${lose}::uuid and to_entity_id = ${keep}::uuid)
                or (from_entity_id = ${keep}::uuid and to_entity_id = ${lose}::uuid))
            returning id
          `,
          "relationships",
          "deleted_at",
          "withdrawn",
        );
        const relationshipsFrom = note(
          await sql<{ id: string }[]>`
            update intel.relationships set from_entity_id = ${keep}::uuid
            where from_entity_id = ${lose}::uuid
            returning id
          `,
          "relationships",
          "from_entity_id",
          "repointed",
        );
        const relationshipsTo = note(
          await sql<{ id: string }[]>`
            update intel.relationships set to_entity_id = ${keep}::uuid
            where to_entity_id = ${lose}::uuid
            returning id
          `,
          "relationships",
          "to_entity_id",
          "repointed",
        );

        const information = note(
          await sql<{ id: string }[]>`
            update intel.information set entity_id = ${keep}::uuid
            where entity_id = ${lose}::uuid
            returning id
          `,
          "information",
          "entity_id",
          "repointed",
        );

        // All of them, with no deletion. finding_links has no unique
        // constraint, so nothing ever required the conditional move and the
        // delete that followed it. Two links from one finding are untidy at
        // worst and a reader can unlink one by hand, which is what that
        // table's DELETE grant is actually for.
        const findingLinks = note(
          await sql<{ id: string }[]>`
            update intel.finding_links set entity_id = ${keep}::uuid
            where entity_id = ${lose}::uuid
            returning id
          `,
          "finding_links",
          "entity_id",
          "repointed",
        );

        await sql`
          update intel.entities set
            resolution_status = 'merged', merged_into_id = ${keep}::uuid,
            updated_by = ${actor.userId}::uuid
          where id = ${lose}::uuid
        `;
        await sql`
          update intel.entities set
            resolution_status = 'resolved', updated_by = ${actor.userId}::uuid
          where id = ${keep}::uuid
        `;

        const moved = {
          aliases,
          caseSubjects: subjects,
          relationshipsFrom,
          relationshipsTo,
          information,
          findingLinks,
          nameAsAlias: nameAlias.count > 0 ? loser.name : undefined,
        };

        const [created] = await sql<{ id: string }[]>`
          insert into intel.entity_merges (
            surviving_entity_id, merged_entity_id, reason, moved, merged_by
          ) values (
            ${keep}::uuid, ${lose}::uuid, ${input.reason},
            ${sql.json(moved)}, ${actor.userId}::uuid
          )
          returning id
        `;

        // The part that makes the merge reversible, written in the same
        // transaction as the merge itself, so a log that exists is a log that
        // is complete.
        if (touched.length > 0) {
          await sql`
            insert into intel.entity_merge_rows ${sql(
              touched.map((row) => ({
                merge_id: created.id,
                table_name: row.table,
                row_id: row.rowId,
                column_name: row.column,
                action: row.action,
                previous_entity_id: row.action === "repointed" ? lose : null,
              })),
            )}
          `;
        }

        /*
         * The flag records that its decision was carried out.
         *
         * Without this it stayed `same_entity` for ever, so the screen went
         * on offering "Merge ENT-NNNN into this record" for a pair it had
         * already merged, and `assertMergeable` could only refuse it. The
         * reversal already assumed this state existed: it moves the flag to
         * `undecided` so the decision has to be made again, which is the
         * undoing of a closure that never happened. See migration 0049.
         */
        const [a, b] = orderedPair(keep, lose);
        await sql`
          update intel.entity_match_flags set
            status = 'merged', updated_by = ${actor.userId}::uuid
          where entity_a_id = ${a}::uuid and entity_b_id = ${b}::uuid
            and status = 'same_entity'
        `;

        await sql`
          select audit.write(
            'entity.merged', 'intel.entities', ${lose}, null, null,
            ${sql.json({ survivingEntityId: keep, moved })},
            ${input.reason}, null
          )
        `;

        return loadMerge(sql, created.id);
      });
    },

    /**
     * Reversing a merge (PRD 8.4).
     *
     * Reads the merge record rather than guessing. What it cannot do is put
     * back the rows that were dropped because the survivor already had them:
     * those were duplicates of what the survivor holds, so the survivor keeps
     * them and the reversal says so. That limit is honest and stated on the
     * screen, rather than pretended away.
     */
    async reverse(input) {
      return tx(async (sql) => {
        const merge = await loadMerge(sql, input.mergeId);
        if (merge.reversedAt !== null) {
          throw new IntelError("conflict", "That merge has already been reversed.");
        }

        const keep = merge.survivingEntityId;
        const lose = merge.mergedEntityId;

        // The loser's own name, put on the survivor as an alias, goes back.
        if (merge.moved.nameAsAlias) {
          await sql`
            delete from intel.entity_aliases
            where entity_id = ${keep}::uuid
              and normalised_alias = crm.normalise_name(${merge.moved.nameAsAlias})
              and alias_type = 'former_name'
          `;
        }

        /*
         * Everything the merge moved, put back by identity.
         *
         * This used to match aliases on the breadcrumb in their source_note
         * and leave the rest where they were, because the merge recorded only
         * how many rows it had moved and not which. So a reversal restored
         * the two records and their names while every statement, case link,
         * relationship and finding link stayed on the survivor, and said it
         * had succeeded. `information` is a hop in the chain this platform
         * exists to keep intact, so that was an attribution quietly left
         * wrong on exactly the records somebody had just decided were not the
         * same thing.
         *
         * `intel.entity_merge_rows` now holds the identities (migration
         * 0048). The table and column names come from that table's CHECK
         * constraints and are matched against literals here, never
         * interpolated as identifiers.
         */
        const moved = await sql<
          { id: string; table_name: string; column_name: string; action: string; row_id: string }[]
        >`
          select id, table_name, column_name, action, row_id
          from intel.entity_merge_rows
          where merge_id = ${input.mergeId}::uuid and restored_at is null
        `;

        const ids = (table: string, column: string, action: string) =>
          moved
            .filter(
              (row) =>
                row.table_name === table &&
                row.column_name === column &&
                row.action === action,
            )
            .map((row) => row.row_id);

        const aliasIds = ids("entity_aliases", "entity_id", "repointed");
        if (aliasIds.length > 0) {
          await sql`
            update intel.entity_aliases set entity_id = ${lose}::uuid
            where id = any(${aliasIds}::uuid[])
          `;
        }

        const subjectIds = ids("case_subjects", "entity_id", "repointed");
        if (subjectIds.length > 0) {
          await sql`
            update intel.case_subjects set
              entity_id = ${lose}::uuid, updated_by = ${actor.userId}::uuid
            where id = any(${subjectIds}::uuid[])
          `;
        }

        // The subject rows the merge withdrew because the survivor was
        // already on that case. Their role and notes were kept, so restoring
        // them is putting the removal back, not reconstructing a row.
        const withdrawnSubjects = ids("case_subjects", "removed_at", "withdrawn");
        if (withdrawnSubjects.length > 0) {
          await sql`
            update intel.case_subjects set
              removed_at = null, removed_by = null, removal_reason = null,
              updated_by = ${actor.userId}::uuid
            where id = any(${withdrawnSubjects}::uuid[])
          `;
        }

        for (const column of ["from_entity_id", "to_entity_id"] as const) {
          const rows = ids("relationships", column, "repointed");
          if (rows.length === 0) continue;
          // Two statements rather than one with a dynamic column: the column
          // is a literal in each, so nothing from the table reaches the SQL
          // as an identifier.
          if (column === "from_entity_id") {
            await sql`
              update intel.relationships set
                from_entity_id = ${lose}::uuid, updated_by = ${actor.userId}::uuid
              where id = any(${rows}::uuid[])
            `;
          } else {
            await sql`
              update intel.relationships set
                to_entity_id = ${lose}::uuid, updated_by = ${actor.userId}::uuid
              where id = any(${rows}::uuid[])
            `;
          }
        }

        const loops = ids("relationships", "deleted_at", "withdrawn");
        if (loops.length > 0) {
          await sql`
            update intel.relationships set
              deleted_at = null, updated_by = ${actor.userId}::uuid
            where id = any(${loops}::uuid[])
          `;
        }

        const informationIds = ids("information", "entity_id", "repointed");
        if (informationIds.length > 0) {
          await sql`
            update intel.information set
              entity_id = ${lose}::uuid, updated_by = ${actor.userId}::uuid
            where id = any(${informationIds}::uuid[])
          `;
        }

        const linkIds = ids("finding_links", "entity_id", "repointed");
        if (linkIds.length > 0) {
          await sql`
            update intel.finding_links set entity_id = ${lose}::uuid
            where id = any(${linkIds}::uuid[])
          `;
        }

        // Marked, not deleted: what a reversal put back is itself history.
        await sql`
          update intel.entity_merge_rows set restored_at = now()
          where merge_id = ${input.mergeId}::uuid and restored_at is null
        `;

        await sql`
          update intel.entities set
            resolution_status = 'disputed', merged_into_id = null,
            updated_by = ${actor.userId}::uuid
          where id = ${lose}::uuid
        `;

        await sql`
          update intel.entity_merges set
            reversed_at = now(), reversed_by = ${actor.userId}::uuid,
            reversal_reason = ${input.reason}
          where id = ${input.mergeId}::uuid
        `;

        // The flag that authorised it goes back to open, so the decision has
        // to be made again rather than silently standing.
        const [a, b] = orderedPair(keep, lose);
        await sql`
          update intel.entity_match_flags set
            status = 'undecided',
            decision_reason = ${`the merge was reversed: ${input.reason}`},
            decided_by = ${actor.userId}::uuid, decided_at = now(),
            updated_by = ${actor.userId}::uuid
          where entity_a_id = ${a}::uuid and entity_b_id = ${b}::uuid
        `;

        await sql`
          select audit.write(
            'entity.merge_reversed', 'intel.entities', ${lose}, null,
            ${sql.json({ survivingEntityId: keep })}, null,
            ${input.reason}, null
          )
        `;

        return loadMerge(sql, input.mergeId);
      });
    },

    async merges(filter) {
      return tx(async (sql) => {
        const rows = await sql<MergeRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${MERGE_SELECT(sql)}
          where (${filter.entityId ?? null}::uuid is null
                 or m.surviving_entity_id = ${filter.entityId ?? null}::uuid
                 or m.merged_entity_id = ${filter.entityId ?? null}::uuid)
          order by m.merged_at desc
          limit ${Math.min(filter.limit ?? 50, 200)}
        `;
        return rows.map(toMerge);
      });
    },
  };
}

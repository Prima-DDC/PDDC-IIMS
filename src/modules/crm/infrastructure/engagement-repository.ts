import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { CrmError } from "../domain/errors";
import type { Engagement, EngagementStatus } from "../domain/types";
import type {
  CreateEngagementInput,
  EngagementRepository,
  ListEngagementsFilter,
  Page,
  UpdateEngagementInput,
} from "../application/ports";

/**
 * Postgres implementation of EngagementRepository.
 *
 * The one thing here that is not bookkeeping is `conflictStatus`: it is read
 * from the most recent conflict check covering the engagement, and it is what
 * the approval gate in the domain layer reads. It is derived on every read
 * rather than cached, because a stale "cleared" would be the worst possible
 * thing to cache.
 *
 * An engagement inherits the clearance of the enquiry it came from, as well as
 * any check raised against itself. That is deliberate and follows PRD 4.1: the
 * enquiry's screening covered the same parties, and intake flows Enquiry to
 * Engagement, so making the manager screen the identical names twice would add
 * a step without adding information. An ENQUIRY, by contrast, reads only its
 * own checks, so a clearance obtained for one record cannot quietly satisfy
 * another.
 */

interface EngagementRow {
  id: string;
  engagement_id: string;
  client_id: string;
  client_name: string;
  client_reference: string;
  enquiry_id: string | null;
  enquiry_reference: string | null;
  title: string;
  engagement_type: Engagement["engagementType"];
  start_date: string | null;
  end_date: string | null;
  contract_reference: string | null;
  nda_reference: string | null;
  scope_of_services: string | null;
  commercial_terms: string | null;
  responsible_manager_id: string | null;
  responsible_manager_name: string | null;
  status: EngagementStatus;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  country_code: string | null;
  office_id: string | null;
  classification: Engagement["classification"];
  created_at: string;
  created_by: string | null;
  updated_at: string;
  version: number;
  deleted_at: string | null;
  conflict_status: Engagement["conflictStatus"];
  case_count: string;
}

function toEngagement(row: EngagementRow): Engagement {
  return {
    id: row.id,
    engagementId: row.engagement_id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientReference: row.client_reference,
    enquiryId: row.enquiry_id,
    enquiryReference: row.enquiry_reference,
    title: row.title,
    engagementType: row.engagement_type,
    startDate: row.start_date,
    endDate: row.end_date,
    contractReference: row.contract_reference,
    ndaReference: row.nda_reference,
    scopeOfServices: row.scope_of_services,
    commercialTerms: row.commercial_terms,
    responsibleManagerId: row.responsible_manager_id,
    responsibleManagerName: row.responsible_manager_name,
    status: row.status,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at,
    countryCode: row.country_code,
    officeId: row.office_id,
    classification: row.classification,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
    conflictStatus: row.conflict_status,
    caseCount: Number(row.case_count ?? 0),
  };
}

function auditShape(row: EngagementRow) {
  return {
    title: row.title,
    engagementType: row.engagement_type,
    startDate: row.start_date,
    endDate: row.end_date,
    contractReference: row.contract_reference,
    ndaReference: row.nda_reference,
    scopeOfServices: row.scope_of_services,
    commercialTerms: row.commercial_terms,
    responsibleManagerId: row.responsible_manager_id,
    status: row.status,
    classification: row.classification,
  };
}

/**
 * The select list every read uses.
 *
 * `case_count` is 0 until the casework schema exists in M3; it is read from a
 * scalar subquery then, and the column is here now so the domain rule that
 * uses it (assertEngagementRemovable) has something to read.
 */
async function loadEngagement(
  sql: postgres.TransactionSql,
  id: string,
): Promise<Engagement | null> {
  const rows = await sql<EngagementRow[]>`
    with directory as (
      select user_id, full_name
      from iam.profile_basics(
        (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
      )
    )
    select e.*,
           c.organisation_name as client_name,
           c.client_id as client_reference,
           q.enquiry_id as enquiry_reference,
           mgr.full_name as responsible_manager_name,
           apr.full_name as approved_by_name,
           (
             select ck.status from crm.conflict_checks ck
             where ck.engagement_id = e.id
                or (ck.enquiry_id is not null and ck.enquiry_id = e.enquiry_id)
             order by ck.created_at desc
             limit 1
           ) as conflict_status,
           0 as case_count
    from crm.engagements e
    join crm.clients c on c.id = e.client_id
    left join crm.enquiries q on q.id = e.enquiry_id
    left join directory mgr on mgr.user_id = e.responsible_manager_id
    left join directory apr on apr.user_id = e.approved_by
    where e.id = ${id}::uuid
  `;
  return rows.length > 0 ? toEngagement(rows[0]) : null;
}

export function createEngagementRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): EngagementRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  const reload = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Engagement> => {
    const engagement = await loadEngagement(sql, id);
    if (!engagement) {
      throw new CrmError(
        "not_found",
        "The engagement could not be read back after saving.",
      );
    }
    return engagement;
  };

  return {
    async list(filter: ListEngagementsFilter): Promise<Page<Engagement>> {
      const limit = Math.min(filter.limit ?? 25, 200);
      const offset = Math.max(filter.offset ?? 0, 0);
      const sort = filter.sort ?? "created";

      return tx(async (sql) => {
        const rows = await sql<(EngagementRow & { total_count: string })[]>`
          with directory as (
            select user_id, full_name
            from iam.profile_basics(
              (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
            )
          ),
          filtered as (
            select e.*,
                   c.organisation_name as client_name,
                   c.client_id as client_reference,
                   q.enquiry_id as enquiry_reference,
                   mgr.full_name as responsible_manager_name,
                   apr.full_name as approved_by_name,
                   (
                     select ck.status from crm.conflict_checks ck
                     where ck.engagement_id = e.id
                        or (ck.enquiry_id is not null and ck.enquiry_id = e.enquiry_id)
                     order by ck.created_at desc
                     limit 1
                   ) as conflict_status,
                   0 as case_count
            from crm.engagements e
            join crm.clients c on c.id = e.client_id
            left join crm.enquiries q on q.id = e.enquiry_id
            left join directory mgr on mgr.user_id = e.responsible_manager_id
            left join directory apr on apr.user_id = e.approved_by
            where (
                    ${filter.onlyDeleted ?? false} and e.deleted_at is not null
                    or ${filter.includeDeleted ?? false}
                    or (not ${filter.onlyDeleted ?? false} and e.deleted_at is null)
                  )
              and (${filter.clientId ?? null}::uuid is null or e.client_id = ${filter.clientId ?? null}::uuid)
              and (${filter.status ?? "all"} = 'all' or e.status = ${filter.status ?? "all"})
              and (${filter.engagementType ?? null}::text is null or e.engagement_type = ${filter.engagementType ?? null})
              and (${filter.responsibleManagerId ?? null}::uuid is null or e.responsible_manager_id = ${filter.responsibleManagerId ?? null}::uuid)
              and (
                ${filter.search ?? null}::text is null
                or e.title ilike '%' || ${filter.search ?? ""} || '%'
                or e.engagement_id ilike '%' || ${filter.search ?? ""} || '%'
                or c.organisation_name ilike '%' || ${filter.search ?? ""} || '%'
                or coalesce(e.contract_reference, '') ilike '%' || ${filter.search ?? ""} || '%'
              )
          )
          select f.*, count(*) over () as total_count
          from filtered f
          order by
            case when ${sort} = 'title'  then f.title end,
            case when ${sort} = 'status' then f.status end,
            case when ${sort} = 'start'  then f.start_date end desc nulls last,
            f.created_at desc
          limit ${limit} offset ${offset}
        `;

        return {
          rows: rows.map(toEngagement),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async findById(id: string): Promise<Engagement | null> {
      return tx(async (sql) => {
        const engagement = await loadEngagement(sql, id);
        if (engagement) {
          await sql`select audit.record_access('engagements', ${id}, null, 'view')`;
        }
        return engagement;
      });
    },

    async create(input: CreateEngagementInput): Promise<Engagement> {
      return tx(async (sql) => {
        const client = await sql<{ id: string; active_status: string }[]>`
          select id, active_status from crm.clients
          where id = ${input.clientId}::uuid and deleted_at is null
        `;
        if (client.length === 0) {
          throw new CrmError("not_found", "That client no longer exists.");
        }
        if (client[0].active_status === "closed") {
          throw new CrmError(
            "conflict",
            "That client is closed. Reopen the client before adding an engagement.",
          );
        }

        const inserted = await sql<{ id: string }[]>`
          insert into crm.engagements (
            client_id, enquiry_id, title, engagement_type, start_date, end_date,
            contract_reference, nda_reference, scope_of_services, commercial_terms,
            responsible_manager_id, country_code, office_id, classification, created_by
          ) values (
            ${input.clientId}::uuid, ${input.enquiryId ?? null}::uuid, ${input.title},
            ${input.engagementType}, ${input.startDate ?? null}::date,
            ${input.endDate ?? null}::date, ${input.contractReference ?? null},
            ${input.ndaReference ?? null}, ${input.scopeOfServices ?? null},
            ${input.commercialTerms ?? null}, ${input.responsibleManagerId ?? null}::uuid,
            ${input.countryCode ?? null}, ${input.officeId ?? null}::uuid,
            ${input.classification}, ${actor.userId}::uuid
          )
          returning id
        `;

        const id = inserted[0].id;
        const engagement = await reload(sql, id);

        await sql`
          select audit.write(
            'engagement.created', 'crm.engagements', ${id}, null, null,
            ${sql.json({
              engagementId: engagement.engagementId,
              clientId: input.clientId,
              title: input.title,
              engagementType: input.engagementType,
              classification: input.classification,
            })},
            null, ${input.classification}
          )
        `;

        return engagement;
      });
    },

    async update(id: string, input: UpdateEngagementInput): Promise<Engagement> {
      return tx(async (sql) => {
        const before = await sql<EngagementRow[]>`
          select e.*, '' as client_name, '' as client_reference,
                 null::text as enquiry_reference, null::text as responsible_manager_name,
                 null::text as approved_by_name, null::text as conflict_status,
                 0 as case_count
          from crm.engagements e
          where e.id = ${id}::uuid and e.deleted_at is null
        `;
        if (before.length === 0) {
          throw new CrmError("not_found", "That engagement no longer exists.");
        }
        if (before[0].version !== input.expectedVersion) {
          throw new CrmError(
            "stale_version",
            "This engagement changed since you opened it. Reload and try again.",
            { expected: input.expectedVersion, actual: before[0].version },
          );
        }

        // An approved engagement's commercial terms and scope are what was
        // signed off, so they are frozen. Changing them is a scope change,
        // which is its own controlled process in M3 (PRD 9).
        const frozen = before[0].status !== "draft" && before[0].status !== "pending_approval";
        if (
          frozen &&
          (input.scopeOfServices !== undefined || input.commercialTerms !== undefined)
        ) {
          throw new CrmError(
            "conflict",
            "The scope and commercial terms of an approved engagement cannot be edited here. Raise a scope change instead.",
            { status: before[0].status },
          );
        }

        const updated = await sql<EngagementRow[]>`
          update crm.engagements set
            title              = coalesce(${input.title ?? null}, title),
            engagement_type    = coalesce(${input.engagementType ?? null}, engagement_type),
            start_date         = ${input.startDate === undefined ? sql`start_date` : sql`${input.startDate}::date`},
            end_date           = ${input.endDate === undefined ? sql`end_date` : sql`${input.endDate}::date`},
            contract_reference = ${input.contractReference === undefined ? sql`contract_reference` : input.contractReference},
            nda_reference      = ${input.ndaReference === undefined ? sql`nda_reference` : input.ndaReference},
            scope_of_services  = ${input.scopeOfServices === undefined ? sql`scope_of_services` : input.scopeOfServices},
            commercial_terms   = ${input.commercialTerms === undefined ? sql`commercial_terms` : input.commercialTerms},
            responsible_manager_id = ${input.responsibleManagerId === undefined ? sql`responsible_manager_id` : sql`${input.responsibleManagerId}::uuid`},
            country_code       = ${input.countryCode === undefined ? sql`country_code` : input.countryCode},
            office_id          = ${input.officeId === undefined ? sql`office_id` : sql`${input.officeId}::uuid`},
            classification     = coalesce(${input.classification ?? null}, classification),
            enquiry_id         = ${input.enquiryId === undefined ? sql`enquiry_id` : sql`${input.enquiryId}::uuid`},
            updated_by         = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${input.expectedVersion}
          returning *, '' as client_name, '' as client_reference,
                    null::text as enquiry_reference, null::text as responsible_manager_name,
                    null::text as approved_by_name, null::text as conflict_status,
                    0 as case_count
        `;
        if (updated.length === 0) {
          throw new CrmError(
            "stale_version",
            "This engagement changed while saving. Reload and try again.",
          );
        }

        await sql`
          select audit.write(
            'engagement.updated', 'crm.engagements', ${id}, null,
            ${sql.json(auditShape(before[0]))},
            ${sql.json(auditShape(updated[0]))},
            null, ${updated[0].classification}
          )
        `;

        return reload(sql, id);
      });
    },

    async setStatus(input): Promise<Engagement> {
      return tx(async (sql) => {
        const before = await sql<{ status: EngagementStatus }[]>`
          select status from crm.engagements
          where id = ${input.id}::uuid and deleted_at is null
        `;
        if (before.length === 0) {
          throw new CrmError("not_found", "That engagement no longer exists.");
        }

        await sql`
          update crm.engagements set
            status = ${input.status},
            approved_by = ${input.approve ? sql`${actor.userId}::uuid` : sql`approved_by`},
            approved_at = ${input.approve ? sql`now()` : sql`approved_at`},
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid
        `;

        await sql`
          select audit.write(
            ${input.approve ? "engagement.approved" : "engagement.status_changed"},
            'crm.engagements', ${input.id}, null,
            ${sql.json({ status: before[0].status })},
            ${sql.json({ status: input.status })},
            ${input.reason}
          )
        `;

        return reload(sql, input.id);
      });
    },

    async softDelete(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        // No RETURNING. A soft delete hides the row, and most of these
        // tables have a SELECT policy that excludes hidden rows, so asking
        // the database to hand the row back is asking it to show something
        // it has just been told to conceal: Postgres refuses with "new row
        // violates row-level security policy", which reads like a permission
        // fault on the write. The row count says everything the caller needs.
        const rows = await sql`
          update crm.engagements
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (rows.count === 0) {
          throw new CrmError("not_found", "That engagement no longer exists.");
        }
        await sql`
          select audit.write(
            'engagement.removed', 'crm.engagements', ${id}, null, null, null, ${reason}
          )
        `;
      });
    },

    async restore(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        const rows = await sql`
          update crm.engagements
          set deleted_at = null, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is not null
          returning id
        `;
        if (rows.count === 0) {
          throw new CrmError("not_found", "That engagement is not in the recycle bin.");
        }
        await sql`
          select audit.write(
            'engagement.restored', 'crm.engagements', ${id}, null, null, null, ${reason}
          )
        `;
      });
    },
  };
}

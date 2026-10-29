import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { CrmError } from "../domain/errors";
import { assessKyc } from "../domain/policies";
import type {
  Client,
  ClientContact,
  ClientDocument,
  ClientStatus,
  KycRecord,
} from "../domain/types";
import type {
  ClientRepository,
  CreateClientInput,
  ListClientsFilter,
  Page,
  UpdateClientInput,
} from "../application/ports";

/**
 * Postgres implementation of ClientRepository.
 *
 * Follows the pattern established by the IAM repositories exactly: one
 * transaction per method through withActor, so the actor is published for RLS
 * and the audit triggers, and the audit row is written in the same transaction
 * as the change it describes. `existing` lets a test inject a transaction it
 * then rolls back.
 *
 * Names of people come from iam.profile_basics, never from a join to
 * public.profiles: that table's RLS keys on auth.uid(), which is null on this
 * connection, so the join silently matches nothing. See migration 0014.
 */

interface ClientRow {
  id: string;
  client_id: string;
  organisation_name: string;
  contact_person: string | null;
  position: string | null;
  telephone: string | null;
  email: string | null;
  address: string | null;
  country_code: string | null;
  country_name: string | null;
  office_id: string | null;
  office_name: string | null;
  industry: string | null;
  client_type: Client["clientType"];
  kyc_status: Client["kycStatus"];
  kyc_completed_at: string | null;
  client_risk_rating: Client["riskRating"];
  account_manager_id: string | null;
  account_manager_name: string | null;
  date_onboarded: string | null;
  active_status: ClientStatus;
  classification: Client["classification"];
  notes: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: string;
  version: number;
  deleted_at: string | null;
  engagement_count: string;
  contact_count: string;
}

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    clientId: row.client_id,
    organisationName: row.organisation_name,
    contactPerson: row.contact_person,
    position: row.position,
    telephone: row.telephone,
    email: row.email,
    address: row.address,
    countryCode: row.country_code,
    countryName: row.country_name,
    officeId: row.office_id,
    officeName: row.office_name,
    industry: row.industry,
    clientType: row.client_type,
    kycStatus: row.kyc_status,
    kycCompletedAt: row.kyc_completed_at,
    riskRating: row.client_risk_rating,
    accountManagerId: row.account_manager_id,
    accountManagerName: row.account_manager_name,
    dateOnboarded: row.date_onboarded,
    status: row.active_status,
    classification: row.classification,
    notes: row.notes,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
    engagementCount: Number(row.engagement_count ?? 0),
    contactCount: Number(row.contact_count ?? 0),
  };
}

/** The columns an audit entry records, so before and after are comparable. */
function auditShape(row: ClientRow) {
  return {
    organisationName: row.organisation_name,
    clientType: row.client_type,
    contactPerson: row.contact_person,
    telephone: row.telephone,
    email: row.email,
    address: row.address,
    countryCode: row.country_code,
    officeId: row.office_id,
    industry: row.industry,
    riskRating: row.client_risk_rating,
    accountManagerId: row.account_manager_id,
    dateOnboarded: row.date_onboarded,
    status: row.active_status,
    classification: row.classification,
    kycStatus: row.kyc_status,
  };
}

/**
 * One client with its joined labels and counts.
 *
 * Extracted so it can be called inside a transaction another statement has
 * already opened: a nested transaction on a small pool would wait for a
 * connection that only the outer transaction can release.
 */
async function loadClient(
  sql: postgres.TransactionSql,
  id: string,
): Promise<Client | null> {
  const rows = await sql<ClientRow[]>`
    with directory as (
      select user_id, full_name
      from iam.profile_basics(
        (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
      )
    )
    select c.*,
           co.name as country_name,
           o.name  as office_name,
           mgr.full_name as account_manager_name,
           crt.full_name as created_by_name,
           (select count(*) from crm.engagements e
             where e.client_id = c.id and e.deleted_at is null) as engagement_count,
           (select count(*) from crm.client_contacts cc
             where cc.client_id = c.id and cc.deleted_at is null) as contact_count
    from crm.clients c
    left join iam.countries co on co.code = c.country_code
    left join iam.offices   o  on o.id = c.office_id
    left join directory mgr on mgr.user_id = c.account_manager_id
    left join directory crt on crt.user_id = c.created_by
    where c.id = ${id}::uuid
  `;
  return rows.length > 0 ? toClient(rows[0]) : null;
}

export function createClientRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): ClientRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  /** Reloads a client after a write, failing loudly if it vanished. */
  const reload = async (sql: postgres.TransactionSql, id: string): Promise<Client> => {
    const client = await loadClient(sql, id);
    if (!client) {
      throw new CrmError("not_found", "The client could not be read back after saving.");
    }
    return client;
  };

  return {
    async list(filter: ListClientsFilter): Promise<Page<Client>> {
      const limit = Math.min(filter.limit ?? 25, 200);
      const offset = Math.max(filter.offset ?? 0, 0);
      const sort = filter.sort ?? "name";

      return tx(async (sql) => {
        const rows = await sql<(ClientRow & { total_count: string })[]>`
          with directory as (
            select user_id, full_name
            from iam.profile_basics(
              (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
            )
          ),
          filtered as (
            select c.*,
                   co.name as country_name,
                   o.name  as office_name,
                   mgr.full_name as account_manager_name,
                   crt.full_name as created_by_name,
                   (select count(*) from crm.engagements e
                     where e.client_id = c.id and e.deleted_at is null) as engagement_count,
                   (select count(*) from crm.client_contacts cc
                     where cc.client_id = c.id and cc.deleted_at is null) as contact_count
            from crm.clients c
            left join iam.countries co on co.code = c.country_code
            left join iam.offices   o  on o.id = c.office_id
            left join directory mgr on mgr.user_id = c.account_manager_id
            left join directory crt on crt.user_id = c.created_by
            where (
                    ${filter.onlyDeleted ?? false} and c.deleted_at is not null
                    or ${filter.includeDeleted ?? false}
                    or (not ${filter.onlyDeleted ?? false} and c.deleted_at is null)
                  )
              and (${filter.status ?? "all"} = 'all' or c.active_status = ${filter.status ?? "all"})
              and (${filter.clientType ?? null}::text is null or c.client_type = ${filter.clientType ?? null})
              and (${filter.kycStatus ?? null}::text is null or c.kyc_status = ${filter.kycStatus ?? null})
              and (${filter.riskRating ?? null}::text is null or c.client_risk_rating = ${filter.riskRating ?? null})
              and (${filter.accountManagerId ?? null}::uuid is null or c.account_manager_id = ${filter.accountManagerId ?? null}::uuid)
              and (${filter.countryCode ?? null}::text is null or c.country_code = ${filter.countryCode ?? null})
              and (${filter.officeId ?? null}::uuid is null or c.office_id = ${filter.officeId ?? null}::uuid)
              and (
                ${filter.search ?? null}::text is null
                or c.organisation_name ilike '%' || ${filter.search ?? ""} || '%'
                or c.client_id ilike '%' || ${filter.search ?? ""} || '%'
                or coalesce(c.contact_person, '') ilike '%' || ${filter.search ?? ""} || '%'
                or coalesce(c.email::text, '') ilike '%' || ${filter.search ?? ""} || '%'
              )
          )
          select f.*, count(*) over () as total_count
          from filtered f
          order by
            case when ${sort} = 'created' then f.created_at end desc,
            case when ${sort} = 'status'  then f.active_status end,
            case when ${sort} = 'kyc'     then f.kyc_status end,
            -- Highest risk first, which is the order a reviewer wants.
            case when ${sort} = 'risk' then
              case f.client_risk_rating
                when 'critical' then 1 when 'high' then 2
                when 'medium' then 3 else 4 end
            end,
            f.organisation_name
          limit ${limit} offset ${offset}
        `;

        return {
          rows: rows.map(toClient),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async findById(id: string): Promise<Client | null> {
      return tx(async (sql) => {
        const client = await loadClient(sql, id);
        if (client) {
          // Opening a client record is itself an access event (PRD 13).
          await sql`select audit.record_access('clients', ${id}, null, 'view')`;
        }
        return client;
      });
    },

    async findByReference(reference: string): Promise<Client | null> {
      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          select id from crm.clients where client_id = ${reference}
        `;
        if (rows.length === 0) return null;
        const client = await loadClient(sql, rows[0].id);
        if (client) {
          await sql`select audit.record_access('clients', ${rows[0].id}, null, 'view')`;
        }
        return client;
      });
    },

    async create(input: CreateClientInput): Promise<Client> {
      return tx(async (sql) => {
        // A near-identical name is a warning, not a bar: two genuinely
        // different clients can share a trading name, and the conflict screen
        // is where sameness is judged. So this only blocks an exact repeat.
        const duplicate = await sql<{ client_id: string }[]>`
          select client_id from crm.clients
          where organisation_name_normalised = crm.normalise_name(${input.organisationName})
            and organisation_name_normalised is not null
            and deleted_at is null
          limit 1
        `;
        if (duplicate.length > 0) {
          throw new CrmError(
            "conflict",
            `${duplicate[0].client_id} already has that organisation name. Open it instead, or add a distinguishing word.`,
            { existing: duplicate[0].client_id },
          );
        }

        const inserted = await sql<{ id: string }[]>`
          insert into crm.clients (
            organisation_name, client_type, contact_person, position, telephone,
            email, address, country_code, office_id, industry, client_risk_rating,
            account_manager_id, date_onboarded, active_status, classification,
            notes, created_by
          ) values (
            ${input.organisationName}, ${input.clientType}, ${input.contactPerson ?? null},
            ${input.position ?? null}, ${input.telephone ?? null}, ${input.email ?? null},
            ${input.address ?? null}, ${input.countryCode ?? null},
            ${input.officeId ?? null}::uuid, ${input.industry ?? null},
            ${input.riskRating}, ${input.accountManagerId ?? null}::uuid,
            ${input.dateOnboarded ?? null}::date, ${input.status},
            ${input.classification}, ${input.notes ?? null}, ${actor.userId}::uuid
          )
          returning id
        `;

        const id = inserted[0].id;
        const client = await reload(sql, id);

        await sql`
          select audit.write(
            'client.created', 'crm.clients', ${id}, null, null,
            ${sql.json({
              clientId: client.clientId,
              organisationName: client.organisationName,
              clientType: client.clientType,
              riskRating: client.riskRating,
              status: client.status,
              classification: client.classification,
            })},
            null, ${client.classification}
          )
        `;

        return client;
      });
    },

    async update(id: string, input: UpdateClientInput): Promise<Client> {
      return tx(async (sql) => {
        const before = await sql<ClientRow[]>`
          select c.*, null::text as country_name, null::text as office_name,
                 null::text as account_manager_name, null::text as created_by_name,
                 0 as engagement_count, 0 as contact_count
          from crm.clients c
          where c.id = ${id}::uuid and c.deleted_at is null
        `;
        if (before.length === 0) {
          throw new CrmError("not_found", "That client no longer exists.");
        }
        if (before[0].version !== input.expectedVersion) {
          throw new CrmError(
            "stale_version",
            "This client changed since you opened it. Reload and try again.",
            { expected: input.expectedVersion, actual: before[0].version },
          );
        }

        // `undefined` means "leave alone", `null` means "clear". The sql`` tag
        // on the left of the colon reuses the column's own value.
        const updated = await sql<ClientRow[]>`
          update crm.clients set
            organisation_name  = coalesce(${input.organisationName ?? null}, organisation_name),
            client_type        = coalesce(${input.clientType ?? null}, client_type),
            contact_person     = ${input.contactPerson === undefined ? sql`contact_person` : input.contactPerson},
            position           = ${input.position === undefined ? sql`position` : input.position},
            telephone          = ${input.telephone === undefined ? sql`telephone` : input.telephone},
            email              = ${input.email === undefined ? sql`email` : input.email},
            address            = ${input.address === undefined ? sql`address` : input.address},
            country_code       = ${input.countryCode === undefined ? sql`country_code` : input.countryCode},
            office_id          = ${input.officeId === undefined ? sql`office_id` : sql`${input.officeId}::uuid`},
            industry           = ${input.industry === undefined ? sql`industry` : input.industry},
            client_risk_rating = coalesce(${input.riskRating ?? null}, client_risk_rating),
            account_manager_id = ${input.accountManagerId === undefined ? sql`account_manager_id` : sql`${input.accountManagerId}::uuid`},
            date_onboarded     = ${input.dateOnboarded === undefined ? sql`date_onboarded` : sql`${input.dateOnboarded}::date`},
            active_status      = coalesce(${input.status ?? null}, active_status),
            classification     = coalesce(${input.classification ?? null}, classification),
            notes              = ${input.notes === undefined ? sql`notes` : input.notes},
            updated_by         = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${input.expectedVersion}
          returning *, null::text as country_name, null::text as office_name,
                    null::text as account_manager_name, null::text as created_by_name,
                    0 as engagement_count, 0 as contact_count
        `;
        if (updated.length === 0) {
          throw new CrmError(
            "stale_version",
            "This client changed while saving. Reload and try again.",
          );
        }

        await sql`
          select audit.write(
            'client.updated', 'crm.clients', ${id}, null,
            ${sql.json(auditShape(before[0]))},
            ${sql.json(auditShape(updated[0]))},
            null, ${updated[0].classification}
          )
        `;

        // The risk rating decides which KYC checks are required, so a change
        // to it can change whether KYC is still complete.
        if (
          input.riskRating !== undefined &&
          input.riskRating !== before[0].client_risk_rating
        ) {
          await refresh(sql, id);
        }

        return reload(sql, id);
      });
    },

    async setStatus(id: string, status: ClientStatus, reason: string): Promise<Client> {
      return tx(async (sql) => {
        const before = await sql<{ active_status: ClientStatus }[]>`
          select active_status from crm.clients
          where id = ${id}::uuid and deleted_at is null
        `;
        if (before.length === 0) {
          throw new CrmError("not_found", "That client no longer exists.");
        }
        if (before[0].active_status === status) {
          throw new CrmError("conflict", `The client is already ${status}.`);
        }

        await sql`
          update crm.clients
          set active_status = ${status}, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid
        `;

        await sql`
          select audit.write(
            'client.status_changed', 'crm.clients', ${id}, null,
            ${sql.json({ status: before[0].active_status })},
            ${sql.json({ status })}, ${reason}
          )
        `;

        return reload(sql, id);
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
          update crm.clients
          set deleted_at = now(), updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (rows.count === 0) {
          throw new CrmError("not_found", "That client no longer exists.");
        }
        await sql`
          select audit.write('client.removed', 'crm.clients', ${id}, null, null, null, ${reason})
        `;
      });
    },

    async restore(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        const rows = await sql`
          update crm.clients
          set deleted_at = null, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is not null
          returning id
        `;
        if (rows.count === 0) {
          throw new CrmError("not_found", "That client is not in the recycle bin.");
        }
        await sql`
          select audit.write('client.restored', 'crm.clients', ${id}, null, null, null, ${reason})
        `;
      });
    },

    /* ------------------------------------------------------------ contacts */

    async contacts(clientId: string): Promise<ClientContact[]> {
      return tx(async (sql) => {
        const rows = await sql<ContactRow[]>`
          select * from crm.client_contacts
          where client_id = ${clientId}::uuid and deleted_at is null
          order by is_primary desc, full_name
        `;
        return rows.map(toContact);
      });
    },

    async addContact(input): Promise<ClientContact> {
      return tx(async (sql) => {
        // At most one primary contact per client, which a partial unique index
        // also enforces. Demoting the incumbent first turns a constraint
        // violation into the behaviour the user expected.
        if (input.isPrimary) {
          await sql`
            update crm.client_contacts set is_primary = false
            where client_id = ${input.clientId}::uuid and is_primary and deleted_at is null
          `;
        }

        const rows = await sql<ContactRow[]>`
          insert into crm.client_contacts (
            client_id, full_name, position, email, telephone, is_primary, notes, created_by
          ) values (
            ${input.clientId}::uuid, ${input.fullName}, ${input.position ?? null},
            ${input.email ?? null}, ${input.telephone ?? null},
            ${input.isPrimary ?? false}, ${input.notes ?? null}, ${actor.userId}::uuid
          )
          returning *
        `;

        await sql`
          select audit.write(
            'client_contact.added', 'crm.client_contacts', ${rows[0].id},
            null, null, ${sql.json({ clientId: input.clientId, fullName: input.fullName })}, null
          )
        `;

        return toContact(rows[0]);
      });
    },

    async updateContact(id, input): Promise<ClientContact> {
      return tx(async (sql) => {
        const before = await sql<ContactRow[]>`
          select * from crm.client_contacts
          where id = ${id}::uuid and deleted_at is null
        `;
        if (before.length === 0) {
          throw new CrmError("not_found", "That contact no longer exists.");
        }
        if (before[0].version !== input.expectedVersion) {
          throw new CrmError(
            "stale_version",
            "This contact changed since you opened it. Reload and try again.",
          );
        }

        if (input.isPrimary) {
          await sql`
            update crm.client_contacts set is_primary = false
            where client_id = ${before[0].client_id}::uuid
              and is_primary and deleted_at is null and id <> ${id}::uuid
          `;
        }

        const rows = await sql<ContactRow[]>`
          update crm.client_contacts set
            full_name  = coalesce(${input.fullName ?? null}, full_name),
            position   = ${input.position === undefined ? sql`position` : input.position},
            email      = ${input.email === undefined ? sql`email` : input.email},
            telephone  = ${input.telephone === undefined ? sql`telephone` : input.telephone},
            is_primary = coalesce(${input.isPrimary ?? null}, is_primary),
            notes      = ${input.notes === undefined ? sql`notes` : input.notes},
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${input.expectedVersion}
          returning *
        `;
        if (rows.length === 0) {
          throw new CrmError(
            "stale_version",
            "This contact changed while saving. Reload and try again.",
          );
        }

        await sql`
          select audit.write(
            'client_contact.updated', 'crm.client_contacts', ${id}, null,
            ${sql.json(contactShape(before[0]))}, ${sql.json(contactShape(rows[0]))}, null
          )
        `;

        return toContact(rows[0]);
      });
    },

    async removeContact(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        const rows = await sql`
          update crm.client_contacts
          set deleted_at = now(), is_primary = false, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and deleted_at is null
        `;
        if (rows.count === 0) {
          throw new CrmError("not_found", "That contact no longer exists.");
        }
        await sql`
          select audit.write(
            'client_contact.removed', 'crm.client_contacts', ${id}, null, null, null, ${reason}
          )
        `;
      });
    },

    /* ----------------------------------------------------------- documents */

    async documents(clientId: string): Promise<ClientDocument[]> {
      return tx(async (sql) => {
        const rows = await sql<DocumentRow[]>`
          with directory as (
            select user_id, full_name
            from iam.profile_basics(
              (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
            )
          )
          select d.*, up.full_name as uploaded_by_name
          from crm.client_documents d
          left join directory up on up.user_id = d.uploaded_by
          where d.client_id = ${clientId}::uuid and d.deleted_at is null
          order by d.uploaded_at desc
        `;
        return rows.map(toDocument);
      });
    },

    async addDocument(input): Promise<ClientDocument> {
      return tx(async (sql) => {
        const rows = await sql<DocumentRow[]>`
          insert into crm.client_documents (
            client_id, document_type, title, file_name, mime_type, file_size,
            sha256_hash, storage_key, classification, expires_at, uploaded_by
          ) values (
            ${input.clientId}::uuid, ${input.documentType}, ${input.title},
            ${input.fileName ?? null}, ${input.mimeType ?? null},
            ${input.fileSize ?? null}, ${input.sha256Hash ?? null},
            ${input.storageKey ?? null}, ${input.classification},
            ${input.expiresAt ?? null}::date, ${actor.userId}::uuid
          )
          returning *, null::text as uploaded_by_name
        `;

        await sql`
          select audit.write(
            'client_document.added', 'crm.client_documents', ${rows[0].id}, null, null,
            ${sql.json({
              clientId: input.clientId,
              documentType: input.documentType,
              title: input.title,
              sha256Hash: input.sha256Hash ?? null,
            })},
            null, ${input.classification}
          )
        `;

        return toDocument(rows[0]);
      });
    },

    async removeDocument(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        const rows = await sql`
          update crm.client_documents set deleted_at = now()
          where id = ${id}::uuid and deleted_at is null
        `;
        if (rows.count === 0) {
          throw new CrmError("not_found", "That document no longer exists.");
        }
        await sql`
          select audit.write(
            'client_document.removed', 'crm.client_documents', ${id}, null, null, null, ${reason}
          )
        `;
      });
    },

    /* ----------------------------------------------------------------- KYC */

    async kycRecords(clientId: string): Promise<KycRecord[]> {
      return tx(async (sql) => {
        const rows = await sql<KycRow[]>`
          with directory as (
            select user_id, full_name
            from iam.profile_basics(
              (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
            )
          )
          select k.*, p.full_name as performed_by_name
          from crm.kyc_records k
          left join directory p on p.user_id = k.performed_by
          where k.client_id = ${clientId}::uuid
          -- Newest first: assessKyc takes the first record of each type as the
          -- one in force.
          order by k.created_at desc
        `;
        return rows.map(toKyc);
      });
    },

    async addKycRecord(input): Promise<KycRecord> {
      return tx(async (sql) => {
        const rows = await sql<KycRow[]>`
          insert into crm.kyc_records (
            client_id, check_type, outcome, summary, evidence_document_id,
            performed_by, performed_at, expires_at, created_by
          ) values (
            ${input.clientId}::uuid, ${input.checkType}, ${input.outcome},
            ${input.summary ?? null}, ${input.evidenceDocumentId ?? null}::uuid,
            ${actor.userId}::uuid,
            coalesce(${input.performedAt ?? null}::timestamptz, now()),
            ${input.expiresAt ?? null}::date, ${actor.userId}::uuid
          )
          returning *, null::text as performed_by_name
        `;

        await sql`
          select audit.write(
            'kyc.recorded', 'crm.kyc_records', ${rows[0].id}, null, null,
            ${sql.json({
              clientId: input.clientId,
              checkType: input.checkType,
              outcome: input.outcome,
            })},
            ${input.summary ?? null}
          )
        `;

        await refresh(sql, input.clientId);
        return toKyc(rows[0]);
      });
    },

    async updateKycRecord(id, input): Promise<KycRecord> {
      return tx(async (sql) => {
        const before = await sql<KycRow[]>`
          select *, null::text as performed_by_name from crm.kyc_records
          where id = ${id}::uuid
        `;
        if (before.length === 0) {
          throw new CrmError("not_found", "That KYC record no longer exists.");
        }
        if (before[0].version !== input.expectedVersion) {
          throw new CrmError(
            "stale_version",
            "This record changed since you opened it. Reload and try again.",
          );
        }

        const rows = await sql<KycRow[]>`
          update crm.kyc_records set
            outcome    = coalesce(${input.outcome ?? null}, outcome),
            summary    = ${input.summary === undefined ? sql`summary` : input.summary},
            expires_at = ${input.expiresAt === undefined ? sql`expires_at` : sql`${input.expiresAt}::date`},
            performed_by = ${actor.userId}::uuid,
            performed_at = now(),
            updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${input.expectedVersion}
          returning *, null::text as performed_by_name
        `;
        if (rows.length === 0) {
          throw new CrmError(
            "stale_version",
            "This record changed while saving. Reload and try again.",
          );
        }

        await sql`
          select audit.write(
            'kyc.updated', 'crm.kyc_records', ${id}, null,
            ${sql.json({ outcome: before[0].outcome, summary: before[0].summary })},
            ${sql.json({ outcome: rows[0].outcome, summary: rows[0].summary })},
            null
          )
        `;

        await refresh(sql, before[0].client_id);
        return toKyc(rows[0]);
      });
    },

    async refreshKycStatus(clientId: string): Promise<Client> {
      return tx(async (sql) => {
        await refresh(sql, clientId);
        return reload(sql, clientId);
      });
    },

    /* -------------------------------------------------------------- counts */

    async activeEngagementCount(clientId: string): Promise<number> {
      return tx(async (sql) => {
        const rows = await sql<{ n: string }[]>`
          select count(*) as n from crm.engagements
          where client_id = ${clientId}::uuid
            and deleted_at is null
            and status not in ('completed', 'cancelled')
        `;
        return Number(rows[0]?.n ?? 0);
      });
    },

    async summary() {
      return tx(async (sql) => {
        const rows = await sql<
          {
            total: string;
            active: string;
            prospects: string;
            kyc_outstanding: string;
            high_risk: string;
          }[]
        >`
          select
            count(*) as total,
            count(*) filter (where active_status = 'active') as active,
            count(*) filter (where active_status = 'prospect') as prospects,
            count(*) filter (where kyc_status <> 'completed') as kyc_outstanding,
            count(*) filter (where client_risk_rating in ('high','critical')) as high_risk
          from crm.clients
          where deleted_at is null
        `;
        const row = rows[0];
        return {
          total: Number(row?.total ?? 0),
          active: Number(row?.active ?? 0),
          prospects: Number(row?.prospects ?? 0),
          kycOutstanding: Number(row?.kyc_outstanding ?? 0),
          highRisk: Number(row?.high_risk ?? 0),
        };
      });
    },
  };
}

/**
 * Recomputes and stores a client's KYC status.
 *
 * The rule lives in the domain layer (assessKyc) rather than in SQL, so there
 * is one definition of "complete" and the tests can drive it without a
 * database. This only caches the answer.
 */
async function refresh(sql: postgres.TransactionSql, clientId: string): Promise<void> {
  // Both reads in one round trip. postgres.js pipelines queries issued
  // together on a transaction, so this is one network round trip rather than
  // two, which matters on a path that runs on every KYC write.
  const [records, client] = await Promise.all([
    sql<{ check_type: KycRecord["checkType"]; outcome: KycRecord["outcome"]; expires_at: string | null }[]>`
      select check_type, outcome, expires_at from crm.kyc_records
      where client_id = ${clientId}::uuid
      order by created_at desc
    `,
    sql<{ client_risk_rating: string; kyc_status: string }[]>`
      select client_risk_rating, kyc_status from crm.clients where id = ${clientId}::uuid
    `,
  ]);

  if (client.length === 0) return;

  const assessment = assessKyc(
    records.map((r) => ({
      checkType: r.check_type,
      outcome: r.outcome,
      expiresAt: r.expires_at,
    })),
    client[0].client_risk_rating,
  );

  if (assessment.status === client[0].kyc_status) return;

  await sql`
    update crm.clients
    set kyc_status = ${assessment.status},
        kyc_completed_at = ${assessment.status === "completed" ? sql`now()` : null}
    where id = ${clientId}::uuid
  `;

  await sql`
    select audit.write(
      'client.kyc_status_changed', 'crm.clients', ${clientId}, null,
      ${sql.json({ kycStatus: client[0].kyc_status })},
      ${sql.json({ kycStatus: assessment.status, missing: assessment.missing })},
      'derived from the KYC records on file'
    )
  `;
}

/* ------------------------------------------------------------- row mapping */

interface ContactRow {
  id: string;
  client_id: string;
  full_name: string;
  position: string | null;
  email: string | null;
  telephone: string | null;
  is_primary: boolean;
  notes: string | null;
  created_at: string;
  version: number;
  deleted_at: string | null;
}

function toContact(row: ContactRow): ClientContact {
  return {
    id: row.id,
    clientId: row.client_id,
    fullName: row.full_name,
    position: row.position,
    email: row.email,
    telephone: row.telephone,
    isPrimary: row.is_primary,
    notes: row.notes,
    createdAt: row.created_at,
    version: row.version,
    deletedAt: row.deleted_at,
  };
}

function contactShape(row: ContactRow) {
  return {
    fullName: row.full_name,
    position: row.position,
    email: row.email,
    telephone: row.telephone,
    isPrimary: row.is_primary,
  };
}

interface DocumentRow {
  id: string;
  client_id: string;
  document_type: ClientDocument["documentType"];
  title: string;
  file_name: string | null;
  mime_type: string | null;
  file_size: string | null;
  sha256_hash: string | null;
  storage_key: string | null;
  classification: ClientDocument["classification"];
  expires_at: string | null;
  uploaded_at: string;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  deleted_at: string | null;
}

function toDocument(row: DocumentRow): ClientDocument {
  return {
    id: row.id,
    clientId: row.client_id,
    documentType: row.document_type,
    title: row.title,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: row.file_size === null ? null : Number(row.file_size),
    sha256Hash: row.sha256_hash,
    storageKey: row.storage_key,
    classification: row.classification,
    expiresAt: row.expires_at,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by_name,
    deletedAt: row.deleted_at,
  };
}

interface KycRow {
  id: string;
  client_id: string;
  check_type: KycRecord["checkType"];
  outcome: KycRecord["outcome"];
  summary: string | null;
  evidence_document_id: string | null;
  performed_by: string | null;
  performed_by_name: string | null;
  performed_at: string | null;
  expires_at: string | null;
  created_at: string;
  version: number;
}

function toKyc(row: KycRow): KycRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    checkType: row.check_type,
    outcome: row.outcome,
    summary: row.summary,
    evidenceDocumentId: row.evidence_document_id,
    performedBy: row.performed_by,
    performedByName: row.performed_by_name,
    performedAt: row.performed_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    version: row.version,
  };
}

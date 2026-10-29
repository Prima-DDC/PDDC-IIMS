import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { CrmError } from "../domain/errors";
import type {
  ConflictCandidate,
  ConflictCheck,
  ConflictMatch,
  Enquiry,
  EnquiryStatus,
} from "../domain/types";
import type {
  CreateEnquiryInput,
  IntakeRepository,
  ListEnquiriesFilter,
  Page,
  UpdateEnquiryInput,
} from "../application/ports";

/**
 * Postgres implementation of IntakeRepository: enquiries and conflict
 * screening.
 *
 * Two things in here carry the weight of PRD 8.3, and both are deliberate:
 *
 *   `screen` only reads. It calls crm.find_conflicts, which scores candidates
 *   and returns them. It writes nothing, merges nothing and decides nothing,
 *   so running a screening can never change a record.
 *
 *   `recordCheck` stores the search and its results so the check is
 *   reproducible: an engagement approved on the strength of a clearance has to
 *   be able to show what was searched for, what came back, who decided and
 *   why. `decideCheck` writes the decision once; the database refuses a
 *   second one through a trigger, and the repository checks first so the
 *   message is readable rather than a constraint name.
 */

/* ------------------------------------------------------------------ rows */

interface EnquiryRow {
  id: string;
  enquiry_id: string;
  received_at: string;
  received_via: Enquiry["receivedVia"];
  client_id: string | null;
  client_name: string | null;
  client_reference: string | null;
  prospect_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  subject: string;
  summary: string | null;
  requested_service: string | null;
  urgency: Enquiry["urgency"];
  status: EnquiryStatus;
  decline_reason: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  country_code: string | null;
  office_id: string | null;
  classification: Enquiry["classification"];
  created_at: string;
  updated_at: string;
  version: number;
  conflict_status: Enquiry["conflictStatus"];
  engagement_id: string | null;
  engagement_reference: string | null;
}

function toEnquiry(row: EnquiryRow): Enquiry {
  return {
    id: row.id,
    enquiryId: row.enquiry_id,
    receivedAt: row.received_at,
    receivedVia: row.received_via,
    clientId: row.client_id,
    clientName: row.client_name,
    clientReference: row.client_reference,
    prospectName: row.prospect_name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    subject: row.subject,
    summary: row.summary,
    requestedService: row.requested_service,
    urgency: row.urgency,
    status: row.status,
    declineReason: row.decline_reason,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    countryCode: row.country_code,
    officeId: row.office_id,
    classification: row.classification,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    conflictStatus: row.conflict_status,
    engagementId: row.engagement_id,
    engagementReference: row.engagement_reference,
  };
}

function enquiryShape(row: EnquiryRow) {
  return {
    subject: row.subject,
    summary: row.summary,
    receivedVia: row.received_via,
    clientId: row.client_id,
    prospectName: row.prospect_name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    requestedService: row.requested_service,
    urgency: row.urgency,
    status: row.status,
    assignedTo: row.assigned_to,
    classification: row.classification,
  };
}

interface CheckRow {
  id: string;
  check_id: string;
  enquiry_id: string | null;
  enquiry_reference: string | null;
  engagement_id: string | null;
  engagement_reference: string | null;
  client_id: string | null;
  client_name: string | null;
  searched_terms: string[];
  status: ConflictCheck["status"];
  decision: ConflictCheck["decision"];
  decision_reason: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  match_count: number;
  highest_score: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  version: number;
}

interface MatchRow {
  id: string;
  check_id: string;
  searched_term: string;
  matched_table: string;
  matched_id: string;
  matched_label: string;
  similarity: string;
  phonetic_match: boolean;
  match_reason: string | null;
  created_at: string;
}

function toMatch(row: MatchRow): ConflictMatch {
  return {
    id: row.id,
    checkId: row.check_id,
    searchedTerm: row.searched_term,
    matchedTable: row.matched_table,
    matchedId: row.matched_id,
    matchedLabel: row.matched_label,
    similarity: Number(row.similarity),
    phoneticMatch: row.phonetic_match,
    matchReason: row.match_reason,
    createdAt: row.created_at,
  };
}

function toCheck(row: CheckRow, matches: MatchRow[]): ConflictCheck {
  return {
    id: row.id,
    checkId: row.check_id,
    enquiryId: row.enquiry_id,
    enquiryReference: row.enquiry_reference,
    engagementId: row.engagement_id,
    engagementReference: row.engagement_reference,
    clientId: row.client_id,
    clientName: row.client_name,
    searchedTerms: row.searched_terms ?? [],
    status: row.status,
    decision: row.decision,
    decisionReason: row.decision_reason,
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at,
    matchCount: Number(row.match_count ?? 0),
    highestScore: row.highest_score === null ? null : Number(row.highest_score),
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    version: row.version,
    matches: matches.map(toMatch),
  };
}

/* --------------------------------------------------------------- loaders */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

async function loadEnquiry(
  sql: postgres.TransactionSql,
  id: string,
): Promise<Enquiry | null> {
  const rows = await sql<EnquiryRow[]>`
    with directory as (${DIRECTORY(sql)})
    select q.*,
           c.organisation_name as client_name,
           c.client_id as client_reference,
           asg.full_name as assigned_to_name,
           (
             select ck.status from crm.conflict_checks ck
             where ck.enquiry_id = q.id
             order by ck.created_at desc limit 1
           ) as conflict_status,
           e.id as engagement_id,
           e.engagement_id as engagement_reference
    from crm.enquiries q
    left join crm.clients c on c.id = q.client_id
    left join directory asg on asg.user_id = q.assigned_to
    left join crm.engagements e
      on e.enquiry_id = q.id and e.deleted_at is null
    where q.id = ${id}::uuid
    order by e.created_at desc
    limit 1
  `;
  return rows.length > 0 ? toEnquiry(rows[0]) : null;
}

async function loadCheck(
  sql: postgres.TransactionSql,
  id: string,
): Promise<ConflictCheck | null> {
  const rows = await sql<CheckRow[]>`
    with directory as (${DIRECTORY(sql)})
    select ck.*,
           q.enquiry_id as enquiry_reference,
           e.engagement_id as engagement_reference,
           c.organisation_name as client_name,
           dec.full_name as decided_by_name,
           crt.full_name as created_by_name
    from crm.conflict_checks ck
    left join crm.enquiries q on q.id = ck.enquiry_id
    left join crm.engagements e on e.id = ck.engagement_id
    left join crm.clients c on c.id = ck.client_id
    left join directory dec on dec.user_id = ck.decided_by
    left join directory crt on crt.user_id = ck.created_by
    where ck.id = ${id}::uuid
  `;
  if (rows.length === 0) return null;

  const matches = await sql<MatchRow[]>`
    select * from crm.conflict_matches
    where check_id = ${id}::uuid
    order by similarity desc, matched_label
  `;
  return toCheck(rows[0], matches);
}

/* ------------------------------------------------------------ repository */

export function createIntakeRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): IntakeRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  const reloadEnquiry = async (
    sql: postgres.TransactionSql,
    id: string,
  ): Promise<Enquiry> => {
    const enquiry = await loadEnquiry(sql, id);
    if (!enquiry) {
      throw new CrmError("not_found", "The enquiry could not be read back after saving.");
    }
    return enquiry;
  };

  return {
    async listEnquiries(filter: ListEnquiriesFilter): Promise<Page<Enquiry>> {
      const limit = Math.min(filter.limit ?? 25, 200);
      const offset = Math.max(filter.offset ?? 0, 0);
      const sort = filter.sort ?? "received";

      return tx(async (sql) => {
        const rows = await sql<(EnquiryRow & { total_count: string })[]>`
          with directory as (${DIRECTORY(sql)}),
          filtered as (
            select q.*,
                   c.organisation_name as client_name,
                   c.client_id as client_reference,
                   asg.full_name as assigned_to_name,
                   (
                     select ck.status from crm.conflict_checks ck
                     where ck.enquiry_id = q.id
                     order by ck.created_at desc limit 1
                   ) as conflict_status,
                   (
                     select e.id from crm.engagements e
                     where e.enquiry_id = q.id and e.deleted_at is null
                     order by e.created_at desc limit 1
                   ) as engagement_id,
                   (
                     select e.engagement_id from crm.engagements e
                     where e.enquiry_id = q.id and e.deleted_at is null
                     order by e.created_at desc limit 1
                   ) as engagement_reference
            from crm.enquiries q
            left join crm.clients c on c.id = q.client_id
            left join directory asg on asg.user_id = q.assigned_to
            where (${filter.status ?? "all"} = 'all' or q.status = ${filter.status ?? "all"})
              and (${filter.urgency ?? null}::text is null or q.urgency = ${filter.urgency ?? null})
              and (${filter.assignedTo ?? null}::uuid is null or q.assigned_to = ${filter.assignedTo ?? null}::uuid)
              and (${filter.clientId ?? null}::uuid is null or q.client_id = ${filter.clientId ?? null}::uuid)
              and (
                ${filter.search ?? null}::text is null
                or q.subject ilike '%' || ${filter.search ?? ""} || '%'
                or q.enquiry_id ilike '%' || ${filter.search ?? ""} || '%'
                or coalesce(q.prospect_name, '') ilike '%' || ${filter.search ?? ""} || '%'
                or coalesce(q.contact_name, '') ilike '%' || ${filter.search ?? ""} || '%'
                or coalesce(c.organisation_name, '') ilike '%' || ${filter.search ?? ""} || '%'
              )
          )
          select f.*, count(*) over () as total_count
          from filtered f
          order by
            -- Most urgent first when sorting by urgency, not alphabetically.
            case when ${sort} = 'urgency' then
              case f.urgency when 'urgent' then 1 when 'high' then 2
                             when 'normal' then 3 else 4 end
            end,
            case when ${sort} = 'status' then f.status end,
            f.received_at desc
          limit ${limit} offset ${offset}
        `;

        return {
          rows: rows.map(toEnquiry),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async findEnquiry(id: string): Promise<Enquiry | null> {
      return tx(async (sql) => {
        const enquiry = await loadEnquiry(sql, id);
        if (enquiry) {
          await sql`select audit.record_access('enquiries', ${id}, null, 'view')`;
        }
        return enquiry;
      });
    },

    async createEnquiry(input: CreateEnquiryInput): Promise<Enquiry> {
      return tx(async (sql) => {
        if (!input.clientId && !(input.prospectName ?? "").trim()) {
          throw new CrmError(
            "validation_failed",
            "Name the party: either pick an existing client or give the prospect's name.",
          );
        }

        const inserted = await sql<{ id: string }[]>`
          insert into crm.enquiries (
            received_at, received_via, client_id, prospect_name, contact_name,
            contact_email, contact_phone, subject, summary, requested_service,
            urgency, assigned_to, country_code, office_id, classification, created_by
          ) values (
            coalesce(${input.receivedAt ?? null}::timestamptz, now()),
            ${input.receivedVia}, ${input.clientId ?? null}::uuid,
            ${input.prospectName ?? null}, ${input.contactName ?? null},
            ${input.contactEmail ?? null}, ${input.contactPhone ?? null},
            ${input.subject}, ${input.summary ?? null}, ${input.requestedService ?? null},
            ${input.urgency}, ${input.assignedTo ?? null}::uuid,
            ${input.countryCode ?? null}, ${input.officeId ?? null}::uuid,
            ${input.classification}, ${actor.userId}::uuid
          )
          returning id
        `;

        const id = inserted[0].id;
        const enquiry = await reloadEnquiry(sql, id);

        await sql`
          select audit.write(
            'enquiry.received', 'crm.enquiries', ${id}, null, null,
            ${sql.json({
              enquiryId: enquiry.enquiryId,
              subject: input.subject,
              receivedVia: input.receivedVia,
              urgency: input.urgency,
              clientId: input.clientId ?? null,
              prospectName: input.prospectName ?? null,
            })},
            null, ${input.classification}
          )
        `;

        return enquiry;
      });
    },

    async updateEnquiry(id: string, input: UpdateEnquiryInput): Promise<Enquiry> {
      return tx(async (sql) => {
        const before = await sql<EnquiryRow[]>`
          select q.*, null::text as client_name, null::text as client_reference,
                 null::text as assigned_to_name, null::text as conflict_status,
                 null::uuid as engagement_id, null::text as engagement_reference
          from crm.enquiries q where q.id = ${id}::uuid
        `;
        if (before.length === 0) {
          throw new CrmError("not_found", "That enquiry no longer exists.");
        }
        if (before[0].version !== input.expectedVersion) {
          throw new CrmError(
            "stale_version",
            "This enquiry changed since you opened it. Reload and try again.",
            { expected: input.expectedVersion, actual: before[0].version },
          );
        }

        const updated = await sql<EnquiryRow[]>`
          update crm.enquiries set
            received_via      = coalesce(${input.receivedVia ?? null}, received_via),
            client_id         = ${input.clientId === undefined ? sql`client_id` : sql`${input.clientId}::uuid`},
            prospect_name     = ${input.prospectName === undefined ? sql`prospect_name` : input.prospectName},
            contact_name      = ${input.contactName === undefined ? sql`contact_name` : input.contactName},
            contact_email     = ${input.contactEmail === undefined ? sql`contact_email` : input.contactEmail},
            contact_phone     = ${input.contactPhone === undefined ? sql`contact_phone` : input.contactPhone},
            subject           = coalesce(${input.subject ?? null}, subject),
            summary           = ${input.summary === undefined ? sql`summary` : input.summary},
            requested_service = ${input.requestedService === undefined ? sql`requested_service` : input.requestedService},
            urgency           = coalesce(${input.urgency ?? null}, urgency),
            assigned_to       = ${input.assignedTo === undefined ? sql`assigned_to` : sql`${input.assignedTo}::uuid`},
            country_code      = ${input.countryCode === undefined ? sql`country_code` : input.countryCode},
            office_id         = ${input.officeId === undefined ? sql`office_id` : sql`${input.officeId}::uuid`},
            classification    = coalesce(${input.classification ?? null}, classification),
            updated_by        = ${actor.userId}::uuid
          where id = ${id}::uuid and version = ${input.expectedVersion}
          returning *, null::text as client_name, null::text as client_reference,
                    null::text as assigned_to_name, null::text as conflict_status,
                    null::uuid as engagement_id, null::text as engagement_reference
        `;
        if (updated.length === 0) {
          throw new CrmError(
            "stale_version",
            "This enquiry changed while saving. Reload and try again.",
          );
        }

        await sql`
          select audit.write(
            'enquiry.updated', 'crm.enquiries', ${id}, null,
            ${sql.json(enquiryShape(before[0]))},
            ${sql.json(enquiryShape(updated[0]))},
            null, ${updated[0].classification}
          )
        `;

        return reloadEnquiry(sql, id);
      });
    },

    async setEnquiryStatus(input): Promise<Enquiry> {
      return tx(async (sql) => {
        const before = await sql<{ status: EnquiryStatus }[]>`
          select status from crm.enquiries where id = ${input.id}::uuid
        `;
        if (before.length === 0) {
          throw new CrmError("not_found", "That enquiry no longer exists.");
        }

        await sql`
          update crm.enquiries set
            status = ${input.status},
            decline_reason = ${
              input.status === "declined"
                ? sql`${input.reason ?? null}`
                : sql`decline_reason`
            },
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid
        `;

        await sql`
          select audit.write(
            'enquiry.stage_changed', 'crm.enquiries', ${input.id}, null,
            ${sql.json({ status: before[0].status })},
            ${sql.json({ status: input.status })},
            ${input.reason ?? null}
          )
        `;

        return reloadEnquiry(sql, input.id);
      });
    },

    async assignEnquiry(id: string, userId: string | null, reason: string) {
      return tx(async (sql) => {
        const before = await sql<{ assigned_to: string | null }[]>`
          select assigned_to from crm.enquiries where id = ${id}::uuid
        `;
        if (before.length === 0) {
          throw new CrmError("not_found", "That enquiry no longer exists.");
        }

        await sql`
          update crm.enquiries
          set assigned_to = ${userId}::uuid, updated_by = ${actor.userId}::uuid
          where id = ${id}::uuid
        `;

        await sql`
          select audit.write(
            'enquiry.assigned', 'crm.enquiries', ${id}, null,
            ${sql.json({ assignedTo: before[0].assigned_to })},
            ${sql.json({ assignedTo: userId })}, ${reason}
          )
        `;

        return reloadEnquiry(sql, id);
      });
    },

    /* ------------------------------------------------------- screening */

    async screen(terms: string[], threshold = 0.3): Promise<ConflictCandidate[]> {
      if (terms.length === 0) return [];

      return tx(async (sql) => {
        const rows = await sql<
          {
            searched_term: string;
            matched_table: string;
            matched_id: string;
            matched_label: string;
            similarity: string;
            phonetic_match: boolean;
            match_reason: string;
          }[]
        >`
          select * from crm.find_conflicts(${terms}::text[], ${threshold}, 50)
        `;

        return rows.map((r) => ({
          searchedTerm: r.searched_term,
          matchedTable: r.matched_table,
          matchedId: r.matched_id,
          matchedLabel: r.matched_label,
          similarity: Number(r.similarity),
          phoneticMatch: r.phonetic_match,
          matchReason: r.match_reason,
        }));
      });
    },

    async recordCheck(input): Promise<ConflictCheck> {
      if (input.terms.length === 0) {
        throw new CrmError(
          "validation_failed",
          "There is nothing to screen. Add at least one name.",
        );
      }
      if (!input.enquiryId && !input.engagementId && !input.clientId) {
        throw new CrmError(
          "validation_failed",
          "Choose which client, enquiry or engagement this check is about. A check that belongs to no record could never be acted on.",
        );
      }

      return tx(async (sql) => {
        const candidates = await sql<
          {
            searched_term: string;
            matched_table: string;
            matched_id: string;
            matched_label: string;
            similarity: string;
            phonetic_match: boolean;
            match_reason: string;
          }[]
        >`
          select * from crm.find_conflicts(
            ${input.terms}::text[], ${input.threshold ?? 0.3}, 50
          )
        `;

        const highest =
          candidates.length === 0
            ? null
            : Math.max(...candidates.map((c) => Number(c.similarity)));

        const inserted = await sql<{ id: string; check_id: string }[]>`
          insert into crm.conflict_checks (
            enquiry_id, engagement_id, client_id, searched_terms,
            match_count, highest_score, created_by
          ) values (
            ${input.enquiryId ?? null}::uuid, ${input.engagementId ?? null}::uuid,
            ${input.clientId ?? null}::uuid, ${input.terms}::text[],
            ${candidates.length}, ${highest}, ${actor.userId}::uuid
          )
          returning id, check_id
        `;
        const id = inserted[0].id;

        for (const c of candidates) {
          await sql`
            insert into crm.conflict_matches (
              check_id, searched_term, matched_table, matched_id, matched_label,
              similarity, phonetic_match, match_reason
            ) values (
              ${id}::uuid, ${c.searched_term}, ${c.matched_table},
              ${c.matched_id}::uuid, ${c.matched_label}, ${c.similarity},
              ${c.phonetic_match}, ${c.match_reason}
            )
          `;
        }

        await sql`
          select audit.write(
            'conflict_check.run', 'crm.conflict_checks', ${id}, null, null,
            ${sql.json({
              checkId: inserted[0].check_id,
              searchedTerms: input.terms,
              matchCount: candidates.length,
              highestScore: highest,
            })},
            'screening run; no decision recorded'
          )
        `;

        const check = await loadCheck(sql, id);
        if (!check) {
          throw new CrmError("not_found", "The conflict check could not be read back.");
        }
        return check;
      });
    },

    async findCheck(id: string): Promise<ConflictCheck | null> {
      return tx(async (sql) => {
        const check = await loadCheck(sql, id);
        if (check) {
          await sql`select audit.record_access('conflicts', ${id}, null, 'view')`;
        }
        return check;
      });
    },

    async listChecks(filter): Promise<Page<ConflictCheck>> {
      const limit = Math.min(filter.limit ?? 25, 200);
      const offset = Math.max(filter.offset ?? 0, 0);

      return tx(async (sql) => {
        const rows = await sql<(CheckRow & { total_count: string })[]>`
          with directory as (${DIRECTORY(sql)})
          select ck.*,
                 q.enquiry_id as enquiry_reference,
                 e.engagement_id as engagement_reference,
                 c.organisation_name as client_name,
                 dec.full_name as decided_by_name,
                 crt.full_name as created_by_name,
                 count(*) over () as total_count
          from crm.conflict_checks ck
          left join crm.enquiries q on q.id = ck.enquiry_id
          left join crm.engagements e on e.id = ck.engagement_id
          left join crm.clients c on c.id = ck.client_id
          left join directory dec on dec.user_id = ck.decided_by
          left join directory crt on crt.user_id = ck.created_by
          where (${filter.status ?? "all"} = 'all' or ck.status = ${filter.status ?? "all"})
            and (${filter.clientId ?? null}::uuid is null or ck.client_id = ${filter.clientId ?? null}::uuid)
            and (${filter.enquiryId ?? null}::uuid is null or ck.enquiry_id = ${filter.enquiryId ?? null}::uuid)
            and (${filter.engagementId ?? null}::uuid is null or ck.engagement_id = ${filter.engagementId ?? null}::uuid)
          order by ck.created_at desc
          limit ${limit} offset ${offset}
        `;

        // The list shows the count and the top score, not every match, so the
        // matches are not loaded here.
        return {
          rows: rows.map((r) => toCheck(r, [])),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async decideCheck(input): Promise<ConflictCheck> {
      return tx(async (sql) => {
        const before = await sql<{ decision: string | null; check_id: string }[]>`
          select decision, check_id from crm.conflict_checks
          where id = ${input.id}::uuid
        `;
        if (before.length === 0) {
          throw new CrmError("not_found", "That conflict check no longer exists.");
        }
        // Checked here for the message; the trigger in migration 0019 is what
        // makes it true.
        if (before[0].decision !== null) {
          throw new CrmError(
            "decision_immutable",
            `${before[0].check_id} has already been decided, and a decision cannot be changed. Raise a new check instead.`,
            { decision: before[0].decision },
          );
        }

        await sql`
          update crm.conflict_checks set
            decision = ${input.decision},
            decision_reason = ${input.reason},
            decided_by = ${actor.userId}::uuid,
            decided_at = now(),
            status = ${input.decision},
            updated_by = ${actor.userId}::uuid
          where id = ${input.id}::uuid
        `;

        await sql`
          select audit.write(
            'conflict_check.decided', 'crm.conflict_checks', ${input.id}, null,
            ${sql.json({ decision: null, status: "open" })},
            ${sql.json({ decision: input.decision, status: input.decision })},
            ${input.reason}
          )
        `;

        const check = await loadCheck(sql, input.id);
        if (!check) {
          throw new CrmError("not_found", "The conflict check could not be read back.");
        }
        return check;
      });
    },

    async latestCheckFor(subject): Promise<ConflictCheck | null> {
      if (!subject.enquiryId && !subject.engagementId) return null;

      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          select id from crm.conflict_checks
          where (${subject.enquiryId ?? null}::uuid is not null
                 and enquiry_id = ${subject.enquiryId ?? null}::uuid)
             or (${subject.engagementId ?? null}::uuid is not null
                 and engagement_id = ${subject.engagementId ?? null}::uuid)
          order by created_at desc
          limit 1
        `;
        if (rows.length === 0) return null;
        return loadCheck(sql, rows[0].id);
      });
    },

    async summary() {
      return tx(async (sql) => {
        const rows = await sql<
          {
            open_enquiries: string;
            awaiting_conflict_decision: string;
            quoted: string;
            urgent: string;
          }[]
        >`
          select
            (select count(*) from crm.enquiries
              where status in ('new','assessing','conflict_check')) as open_enquiries,
            (select count(*) from crm.conflict_checks
              where decision is null) as awaiting_conflict_decision,
            (select count(*) from crm.enquiries where status = 'quoted') as quoted,
            (select count(*) from crm.enquiries
              where urgency = 'urgent'
                and status in ('new','assessing','conflict_check','quoted')) as urgent
        `;
        const row = rows[0];
        return {
          openEnquiries: Number(row?.open_enquiries ?? 0),
          awaitingConflictDecision: Number(row?.awaiting_conflict_decision ?? 0),
          quoted: Number(row?.quoted ?? 0),
          urgent: Number(row?.urgent ?? 0),
        };
      });
    },
  };
}

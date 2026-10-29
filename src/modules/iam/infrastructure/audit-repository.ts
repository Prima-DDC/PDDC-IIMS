import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { IamError } from "../domain/errors";
import type { AccessChangeRequest, AuditEntry } from "../domain/types";
import type { AccessRequestRepository, AuditRepository } from "../application/ports";

export function createAuditRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): AuditRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  return {
    async read(filter): Promise<AuditEntry[]> {
      return tx(async (sql) => {
        // Goes through the SECURITY DEFINER reader, which checks the audit
        // permission and records the read in audit.access_log. iims_app has no
        // SELECT on the table itself.
        const rows = await sql<AuditRow[]>`
          select * from audit.read_audit_log(
            ${filter.caseId ?? null}::uuid,
            ${filter.actorUserId ?? null}::uuid,
            ${filter.action ?? null},
            ${filter.from ?? null}::timestamptz,
            ${filter.to ?? null}::timestamptz,
            ${Math.min(filter.limit ?? 100, 500)},
            ${filter.beforeSeq ?? null}::bigint
          )
        `;
        return rows.map(toEntry);
      });
    },

    async verifyChain() {
      return tx(async (sql) => {
        const rows = await sql<
          { checked: string; ok: boolean; first_bad_seq: string | null }[]
        >`select checked::text, ok, first_bad_seq::text from audit.verify_chain(0)`;
        return {
          checked: Number(rows[0].checked),
          ok: rows[0].ok,
          firstBadSeq: rows[0].first_bad_seq,
        };
      });
    },

    async distinctActions(): Promise<string[]> {
      return tx(async (sql) => {
        // Through the SECURITY DEFINER function: iims_app holds INSERT only on
        // audit.audit_log, so selecting from it directly is denied.
        const rows = await sql<{ action: string }[]>`
          select audit.distinct_actions() as action
        `;
        return rows.map((r) => r.action).filter(Boolean);
      });
    },
  };
}

export function createAccessRequestRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): AccessRequestRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  return {
    async list(filter): Promise<AccessChangeRequest[]> {
      return tx(async (sql) => {
        // Display names come from iam.profile_basics, not a join on
        // public.profiles, which the website's RLS would filter out.
        const rows = await sql<RequestRow[]>`
          with involved as (
            select distinct id from (
              select target_user_id as id from iam.access_change_requests
              union all select requested_by from iam.access_change_requests
              union all select decided_by from iam.access_change_requests
            ) ids where id is not null
          ),
          names as (
            select user_id, email, full_name
            from iam.profile_basics(
              (select coalesce(array_agg(id), '{}'::uuid[]) from involved)
            )
          )
          select r.*,
                 tp.full_name as target_name, tp.email as target_email,
                 rp.full_name as requester_name,
                 dp.full_name as decider_name
          from iam.access_change_requests r
          left join names tp on tp.user_id = r.target_user_id
          left join names rp on rp.user_id = r.requested_by
          left join names dp on dp.user_id = r.decided_by
          where (${filter.status ?? null}::text is null or r.status = ${filter.status ?? null})
          order by
            case when r.status = 'pending' then 0 else 1 end,
            r.requested_at desc
          limit ${Math.min(filter.limit ?? 100, 200)}
        `;
        return rows.map(toRequest);
      });
    },

    async findById(id): Promise<AccessChangeRequest | null> {
      return tx(async (sql) => {
        const rows = await sql<RequestRow[]>`
          with involved as (
            select distinct x from (
              select target_user_id as x from iam.access_change_requests where id = ${id}::uuid
              union all select requested_by from iam.access_change_requests where id = ${id}::uuid
              union all select decided_by from iam.access_change_requests where id = ${id}::uuid
            ) ids where x is not null
          ),
          names as (
            select user_id, email, full_name
            from iam.profile_basics(
              (select coalesce(array_agg(x), '{}'::uuid[]) from involved)
            )
          )
          select r.*,
                 tp.full_name as target_name, tp.email as target_email,
                 rp.full_name as requester_name,
                 dp.full_name as decider_name
          from iam.access_change_requests r
          left join names tp on tp.user_id = r.target_user_id
          left join names rp on rp.user_id = r.requested_by
          left join names dp on dp.user_id = r.decided_by
          where r.id = ${id}::uuid
        `;
        return rows.length > 0 ? toRequest(rows[0]) : null;
      });
    },

    async create(input): Promise<AccessChangeRequest> {
      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          insert into iam.access_change_requests
            (kind, target_user_id, target_record, payload, reason, requested_by)
          values (${input.kind}, ${input.targetUserId ?? null}::uuid,
                  ${input.targetRecord ?? null}, ${JSON.stringify(input.payload)}::jsonb,
                  ${input.reason}, ${actor.userId}::uuid)
          returning id
        `;

        await sql`
          select audit.write('access_request.created', 'iam.access_change_requests',
                             ${rows[0].id}, null, null,
                             ${sql.json({ kind: input.kind, targetUserId: input.targetUserId ?? null })},
                             ${input.reason})
        `;

        const created = await this.findById(rows[0].id);
        if (!created) throw new IamError("not_found", "Request not found after creation.");
        return created;
      });
    },

    async decide(input): Promise<AccessChangeRequest> {
      return tx(async (sql) => {
        const existingRow = await sql<{ requested_by: string; status: string }[]>`
          select requested_by, status from iam.access_change_requests
          where id = ${input.id}::uuid
        `;
        if (existingRow.length === 0) {
          throw new IamError("not_found", "Request not found.");
        }
        if (existingRow[0].status !== "pending") {
          throw new IamError(
            "conflict",
            `This request has already been ${existingRow[0].status}.`,
          );
        }
        // The table constraint enforces this too; checking here produces a
        // readable message instead of a constraint violation.
        if (existingRow[0].requested_by === actor.userId) {
          throw new IamError(
            "self_approval_forbidden",
            "A high-risk change must be approved by a different administrator.",
          );
        }

        await sql`
          update iam.access_change_requests
          set status = ${input.approve ? "approved" : "rejected"},
              decided_by = ${actor.userId}::uuid,
              decided_at = now(),
              decision_note = ${input.note ?? null}
          where id = ${input.id}::uuid
        `;

        await sql`
          select audit.write(
            ${input.approve ? "access_request.approved" : "access_request.rejected"},
            'iam.access_change_requests', ${input.id}, null, null,
            ${sql.json({ note: input.note ?? null })}, ${input.note ?? null}
          )
        `;

        const after = await this.findById(input.id);
        if (!after) throw new IamError("not_found", "Request not found after decision.");
        return after;
      });
    },

    async markApplied(id): Promise<void> {
      await tx(async (sql) => {
        await sql`
          update iam.access_change_requests
          set status = 'applied', applied_at = now()
          where id = ${id}::uuid and status = 'approved'
        `;
        await sql`
          select audit.write('access_request.applied', 'iam.access_change_requests',
                             ${id}, null, null, null, null)
        `;
      });
    },
  };
}

/* ------------------------------------------------------------------ mapping */

interface AuditRow {
  audit_id: string;
  seq: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  occurred_at: string;
  record_type: string | null;
  record_id: string | null;
  case_id: string | null;
  ip: string | null;
  user_agent: string | null;
  before_value: unknown;
  after_value: unknown;
  reason: string | null;
  correlation_id: string | null;
  classification: string | null;
  prev_hash: string;
  row_hash: string;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    auditId: row.audit_id,
    seq: String(row.seq),
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    action: row.action,
    occurredAt: row.occurred_at,
    recordType: row.record_type,
    recordId: row.record_id,
    caseId: row.case_id,
    ip: row.ip,
    userAgent: row.user_agent,
    beforeValue: row.before_value,
    afterValue: row.after_value,
    reason: row.reason,
    correlationId: row.correlation_id,
    classification: row.classification,
    prevHash: row.prev_hash,
    rowHash: row.row_hash,
  };
}

interface RequestRow {
  id: string;
  kind: AccessChangeRequest["kind"];
  target_user_id: string | null;
  target_name: string | null;
  target_email: string | null;
  target_record: string | null;
  payload: Record<string, unknown>;
  reason: string;
  requested_by: string;
  requester_name: string | null;
  requested_at: string;
  status: AccessChangeRequest["status"];
  decided_by: string | null;
  decider_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  expires_at: string;
}

function toRequest(row: RequestRow): AccessChangeRequest {
  return {
    id: row.id,
    kind: row.kind,
    targetUserId: row.target_user_id,
    targetUserName: row.target_name ?? row.target_email,
    targetRecord: row.target_record,
    payload: row.payload,
    reason: row.reason,
    requestedBy: row.requested_by,
    requestedByName: row.requester_name,
    requestedAt: row.requested_at,
    status: row.status,
    decidedBy: row.decided_by,
    decidedByName: row.decider_name,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    expiresAt: row.expires_at,
  };
}

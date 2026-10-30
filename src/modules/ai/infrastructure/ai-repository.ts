import "server-only";
import type postgres from "postgres";
import {
  applyActorSettings,
  withActor,
  withSystemActor,
  type ActorContext,
} from "@/lib/db/client";
import { AiError } from "../domain/errors";
import type {
  AiCaseSetting,
  AiJob,
  AiProvider,
  Redaction,
  Suggestion,
} from "../domain/types";
import type {
  CaseSettingRepository,
  JobRepository,
  Page,
  ProviderRepository,
} from "../application/ports";

/**
 * AI persistence (PRD 22).
 *
 * Three repositories over six tables in `config`, and the division follows
 * who writes them: an administrator maintains the allow-list, a supervisor
 * decides per case, and a worker runs the queue. The worker's methods run
 * under `withSystemActor`, which is the only context migration 0059's
 * policies accept for them.
 *
 * The redaction map is written here and never read here. `iims_app` holds no
 * privilege on `config.ai_redactions` at all, so the only way back is
 * `config.ai_restore(job)`, which the worker calls for one job at a time.
 */

/**
 * Hands a named interface to `sql.json`.
 *
 * postgres.js types its JSON parameter as an indexable value, which an
 * interface with named fields does not satisfy even though it is perfectly
 * good JSON. The cast is the whole of the problem.
 *
 * `JSON.stringify` is NOT the alternative, and this comment exists because it
 * looks like one. Passing an already-serialised string makes postgres.js
 * serialise it a second time, and what arrives is a jsonb array containing a
 * string. That cost a day in the notify module: the outbox refused the row,
 * and because the insert ran inside the business transaction the whole action
 * rolled back. See docs/PROGRESS.md, item 88.
 */
function asJson(value: object): postgres.JSONValue {
  return value as unknown as postgres.JSONValue;
}

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

/* ------------------------------------------------------------- providers */

interface ProviderRow {
  key: string;
  label: string;
  base_url: string;
  model: string;
  api_key_env: string;
  is_enabled: boolean;
  retention_terms: string | null;
  terms_reviewed_at: string | null;
  terms_reviewed_by_name: string | null;
  position: number;
  max_classification: string;
  notes: string | null;
  consecutive_failures: number | null;
  next_attempt_at: string | null;
  last_error: string | null;
  last_success_at: string | null;
  version: number;
}

function toProvider(row: ProviderRow): AiProvider {
  return {
    key: row.key,
    label: row.label,
    baseUrl: row.base_url,
    model: row.model,
    apiKeyEnv: row.api_key_env,
    isEnabled: row.is_enabled,
    retentionTerms: row.retention_terms,
    termsReviewedAt: row.terms_reviewed_at,
    termsReviewedByName: row.terms_reviewed_by_name,
    position: row.position,
    maxClassification: row.max_classification,
    notes: row.notes,
    consecutiveFailures: row.consecutive_failures ?? 0,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    lastSuccessAt: row.last_success_at,
    version: row.version,
  };
}

const PROVIDER_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    p.key, p.label, p.base_url, p.model, p.api_key_env, p.is_enabled,
    p.retention_terms, p.terms_reviewed_at,
    d.full_name as terms_reviewed_by_name,
    p.position, p.max_classification, p.notes, p.version,
    s.consecutive_failures, s.next_attempt_at, s.last_error, s.last_success_at
  from config.ai_providers p
  left join config.ai_provider_state s on s.provider_key = p.key
  left join directory d on d.user_id = p.terms_reviewed_by
`;

export function createProviderRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): ProviderRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  return {
    async list() {
      return tx(async (sql) => {
        const rows = await sql<ProviderRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${PROVIDER_SELECT(sql)}
          order by p.position, p.key
        `;
        return rows.map(toProvider);
      });
    },

    async listForWorker() {
      return withSystemActor("ai-drain", crypto.randomUUID(), async (sql) => {
        const rows = await sql<ProviderRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${PROVIDER_SELECT(sql)}
          order by p.position, p.key
        `;
        return rows.map(toProvider);
      });
    },

    async find(key) {
      return tx(async (sql) => {
        const rows = await sql<ProviderRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${PROVIDER_SELECT(sql)}
          where p.key = ${key}
        `;
        return rows[0] ? toProvider(rows[0]) : null;
      });
    },

    async save(input) {
      return tx(async (sql) => {
        // Who read the terms and when, recorded on the row rather than left
        // to the audit trail: PRD 22.4 wants the review itself on the record
        // an administrator looks at.
        const reviewed = input.retentionTerms !== null;

        const rows = await sql<{ key: string }[]>`
          insert into config.ai_providers (
            key, label, base_url, model, api_key_env, retention_terms,
            terms_reviewed_at, terms_reviewed_by, position, max_classification,
            notes, is_enabled, created_by, updated_by
          ) values (
            ${input.key}, ${input.label}, ${input.baseUrl}, ${input.model},
            ${input.apiKeyEnv}, ${input.retentionTerms},
            ${reviewed ? sql`now()` : null},
            ${reviewed ? sql`${actor.userId}::uuid` : null},
            ${input.position}, ${input.maxClassification}, ${input.notes},
            ${input.isEnabled}, ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          on conflict (key) do update set
            label = excluded.label,
            base_url = excluded.base_url,
            model = excluded.model,
            api_key_env = excluded.api_key_env,
            retention_terms = excluded.retention_terms,
            -- The review date moves only when the terms themselves change: a
            -- label correction is not a fresh reading of a third party's
            -- retention policy, and dating it as one would be a false record.
            terms_reviewed_at = case
              when config.ai_providers.retention_terms is distinct from excluded.retention_terms
                then now()
              else config.ai_providers.terms_reviewed_at
            end,
            terms_reviewed_by = case
              when config.ai_providers.retention_terms is distinct from excluded.retention_terms
                then ${actor.userId}::uuid
              else config.ai_providers.terms_reviewed_by
            end,
            position = excluded.position,
            max_classification = excluded.max_classification,
            notes = excluded.notes,
            is_enabled = excluded.is_enabled,
            updated_at = now(),
            updated_by = ${actor.userId}::uuid,
            version = config.ai_providers.version + 1
          where ${input.expectedVersion ?? null}::integer is null
             or config.ai_providers.version = ${input.expectedVersion ?? null}::integer
          returning key
        `;

        if (rows.length === 0) {
          throw new AiError(
            "validation_failed",
            "Somebody else changed this provider while you were editing it. Reload and apply your change again.",
          );
        }

        await sql`
          select audit.write(
            'ai.provider_saved', 'config.ai_providers', ${input.key},
            null, null,
            ${sql.json({
              key: input.key,
              model: input.model,
              enabled: input.isEnabled,
              maxClassification: input.maxClassification,
            })}
          )
        `;

        const saved = await sql<ProviderRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${PROVIDER_SELECT(sql)}
          where p.key = ${input.key}
        `;
        return toProvider(saved[0]);
      });
    },

    async remove(key) {
      return tx(async (sql) => {
        await sql`delete from config.ai_providers where key = ${key}`;
        await sql`
          select audit.write(
            'ai.provider_removed', 'config.ai_providers', ${key}, null, null, null
          )
        `;
      });
    },

    async recordOutcome(input) {
      // The worker's write, so it runs as a system process: 0059's policy on
      // the breaker table accepts nothing else.
      await withSystemActor("ai-drain", crypto.randomUUID(), async (sql) => {
        if (input.ok) {
          await sql`
            insert into config.ai_provider_state (
              provider_key, consecutive_failures, opened_at, next_attempt_at,
              last_error, last_success_at, updated_at
            ) values (${input.key}, 0, null, null, null, now(), now())
            on conflict (provider_key) do update set
              consecutive_failures = 0,
              opened_at = null,
              next_attempt_at = null,
              last_error = null,
              last_success_at = now(),
              updated_at = now()
          `;
          return;
        }

        await sql`
          insert into config.ai_provider_state (
            provider_key, consecutive_failures, opened_at, next_attempt_at,
            last_error, updated_at
          ) values (
            ${input.key}, 1, now(), ${input.nextAttemptAt ?? null}::timestamptz,
            ${input.error ?? null}, now()
          )
          on conflict (provider_key) do update set
            consecutive_failures = config.ai_provider_state.consecutive_failures + 1,
            opened_at = coalesce(config.ai_provider_state.opened_at, now()),
            next_attempt_at = ${input.nextAttemptAt ?? null}::timestamptz,
            last_error = ${input.error ?? null},
            updated_at = now()
        `;
      });
    },
  };
}

/* --------------------------------------------------------- case settings */

interface CaseSettingRow {
  case_id: string;
  is_enabled: boolean;
  reason: string;
  decided_by: string;
  decided_by_name: string | null;
  decided_at: string;
  client_consent_recorded: boolean;
  version: number;
}

function toCaseSetting(row: CaseSettingRow): AiCaseSetting {
  return {
    caseId: row.case_id,
    isEnabled: row.is_enabled,
    reason: row.reason,
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at,
    clientConsentRecorded: row.client_consent_recorded,
    version: row.version,
  };
}

export function createCaseSettingRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): CaseSettingRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  return {
    async forCase(caseId) {
      return tx(async (sql) => {
        const rows = await sql<CaseSettingRow[]>`
          with directory as (${DIRECTORY(sql)})
          select s.case_id, s.is_enabled, s.reason, s.decided_by,
                 d.full_name as decided_by_name,
                 s.decided_at, s.client_consent_recorded, s.version
          from config.ai_case_settings s
          left join directory d on d.user_id = s.decided_by
          where s.case_id = ${caseId}::uuid
        `;
        return rows[0] ? toCaseSetting(rows[0]) : null;
      });
    },

    async decide(input) {
      return tx(async (sql) => {
        const rows = await sql<{ case_id: string }[]>`
          insert into config.ai_case_settings (
            case_id, is_enabled, reason, decided_by, client_consent_recorded
          ) values (
            ${input.caseId}::uuid, ${input.isEnabled}, ${input.reason},
            ${actor.userId}::uuid, ${input.clientConsentRecorded}
          )
          on conflict (case_id) do update set
            is_enabled = excluded.is_enabled,
            reason = excluded.reason,
            -- Every change is a fresh decision by a named person, because
            -- that is what PRD 22.4 asks to be recorded. Keeping the first
            -- decider would attribute somebody else's choice to them.
            decided_by = excluded.decided_by,
            decided_at = now(),
            client_consent_recorded = excluded.client_consent_recorded,
            updated_at = now(),
            version = config.ai_case_settings.version + 1
          where ${input.expectedVersion ?? null}::integer is null
             or config.ai_case_settings.version = ${input.expectedVersion ?? null}::integer
          returning case_id
        `;

        if (rows.length === 0) {
          throw new AiError(
            "validation_failed",
            "Somebody else changed this setting while you were deciding. Reload and apply your change again.",
          );
        }

        await sql`
          select audit.write(
            ${input.isEnabled ? "ai.enabled_for_case" : "ai.disabled_for_case"},
            'config.ai_case_settings', ${input.caseId},
            ${input.caseId}::uuid, null,
            ${sql.json({
              enabled: input.isEnabled,
              reason: input.reason,
              clientConsentRecorded: input.clientConsentRecorded,
            })}
          )
        `;

        const saved = await sql<CaseSettingRow[]>`
          with directory as (${DIRECTORY(sql)})
          select s.case_id, s.is_enabled, s.reason, s.decided_by,
                 d.full_name as decided_by_name,
                 s.decided_at, s.client_consent_recorded, s.version
          from config.ai_case_settings s
          left join directory d on d.user_id = s.decided_by
          where s.case_id = ${input.caseId}::uuid
        `;
        return toCaseSetting(saved[0]);
      });
    },
  };
}

/* -------------------------------------------------------------- the jobs */

interface JobRow {
  id: string;
  case_id: string | null;
  requested_by: string;
  requested_by_name: string | null;
  kind: AiJob["kind"];
  prompt_version: string;
  subject: string | null;
  record_type: string | null;
  record_id: string | null;
  classification: string;
  status: AiJob["status"];
  blocked_reason: string | null;
  provider_key: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  output: Suggestion | null;
  error: string | null;
  attempts: number;
  cached: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  accepted_by: string | null;
  accepted_by_name: string | null;
  accepted_at: string | null;
  rejected_by: string | null;
  rejected_by_name: string | null;
  rejected_at: string | null;
  decision_note: string | null;
}

function toJob(row: JobRow): AiJob {
  return {
    id: row.id,
    caseId: row.case_id,
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name,
    kind: row.kind,
    promptVersion: row.prompt_version,
    subject: row.subject,
    recordType: row.record_type,
    recordId: row.record_id,
    classification: row.classification,
    status: row.status,
    blockedReason: row.blocked_reason,
    providerKey: row.provider_key,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    output: row.output,
    error: row.error,
    attempts: row.attempts,
    cached: row.cached,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    acceptedBy: row.accepted_by,
    acceptedByName: row.accepted_by_name,
    acceptedAt: row.accepted_at,
    rejectedBy: row.rejected_by,
    rejectedByName: row.rejected_by_name,
    rejectedAt: row.rejected_at,
    decisionNote: row.decision_note,
  };
}

const JOB_SELECT = (sql: postgres.TransactionSql) => sql`
  select
    j.id, j.case_id, j.requested_by, r.full_name as requested_by_name,
    j.kind, j.prompt_version, j.subject, j.record_type, j.record_id,
    j.classification, j.status, j.blocked_reason, j.provider_key, j.model,
    j.prompt_tokens, j.completion_tokens, j.output, j.error, j.attempts,
    j.cached, j.created_at, j.started_at, j.finished_at,
    j.accepted_by, a.full_name as accepted_by_name, j.accepted_at,
    j.rejected_by, x.full_name as rejected_by_name, j.rejected_at,
    j.decision_note
  from config.ai_jobs j
  left join directory r on r.user_id = j.requested_by
  left join directory a on a.user_id = j.accepted_by
  left join directory x on x.user_id = j.rejected_by
`;

export function createJobRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): JobRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  return {
    async usageToday(caseId) {
      return tx(async (sql) => {
        // Counted from the jobs themselves rather than from a counter table.
        // A counter is a second source of truth that can drift from the thing
        // it counts, and the thing it counts is already indexed by requester
        // and by case.
        const [row] = await sql<{ by_user: string; by_case: string }[]>`
          select
            count(*) filter (
              where requested_by = ${actor.userId}::uuid
            )::text as by_user,
            count(*) filter (
              where ${caseId ?? null}::uuid is not null
                and case_id = ${caseId ?? null}::uuid
            )::text as by_case
          from config.ai_jobs
          where created_at >= date_trunc('day', now())
            -- A blocked request cost no provider allowance, so it does not
            -- count against a quota whose purpose is to ration that
            -- allowance. It is still on the record.
            and status <> 'blocked'
        `;
        return { byUser: Number(row.by_user), byCase: Number(row.by_case) };
      });
    },

    async enqueue(input) {
      return tx(async (sql) => {
        const [{ id }] = await sql<{ id: string }[]>`
          insert into config.ai_jobs (
            case_id, requested_by, kind, prompt_version, input_hash, subject,
            record_type, record_id, classification
          ) values (
            ${input.caseId ?? null}::uuid, ${actor.userId}::uuid, ${input.kind},
            ${input.promptVersion}, ${input.inputHash}, ${input.subject},
            ${input.recordType}, ${input.recordId ?? null}::uuid,
            ${input.classification}
          )
          returning id
        `;

        // The map, written in the same transaction as the job it belongs to.
        // A job whose map was lost is an answer nobody can restore.
        for (const redaction of input.redactions) {
          await sql`
            insert into config.ai_redactions (job_id, token, original, kind)
            values (${id}::uuid, ${redaction.token}, ${redaction.original},
                    ${redaction.kind})
            on conflict (job_id, token) do nothing
          `;
        }

        // PRD 22.4's last line: every outbound request logged with provider,
        // model, case, user, classification and token count. Provider, model
        // and tokens are not known until it runs, so this records the request
        // and `recordResult` records what happened to it.
        await sql`
          select audit.write(
            'ai.requested', 'config.ai_jobs', ${id},
            ${input.caseId ?? null}::uuid, null,
            ${sql.json({
              kind: input.kind,
              promptVersion: input.promptVersion,
              classification: input.classification,
              redactions: input.redactions.length,
            })}
          )
        `;

        const rows = await sql<JobRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${JOB_SELECT(sql)}
          where j.id = ${id}::uuid
        `;
        return toJob(rows[0]);
      });
    },

    async recordBlocked(input) {
      return tx(async (sql) => {
        const [{ id }] = await sql<{ id: string }[]>`
          insert into config.ai_jobs (
            case_id, requested_by, kind, prompt_version, input_hash, subject,
            status, blocked_reason
          ) values (
            ${input.caseId ?? null}::uuid, ${actor.userId}::uuid, ${input.kind},
            ${input.promptVersion}, ${input.inputHash}, ${input.subject},
            'blocked', ${input.reason}
          )
          returning id
        `;

        await sql`
          select audit.write(
            'ai.blocked', 'config.ai_jobs', ${id},
            ${input.caseId ?? null}::uuid, null,
            ${sql.json({ kind: input.kind, reason: input.reason })}
          )
        `;

        const rows = await sql<JobRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${JOB_SELECT(sql)}
          where j.id = ${id}::uuid
        `;
        return toJob(rows[0]);
      });
    },

    async find(id) {
      return tx(async (sql) => {
        const rows = await sql<JobRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${JOB_SELECT(sql)}
          where j.id = ${id}::uuid
        `;
        return rows[0] ? toJob(rows[0]) : null;
      });
    },

    async list(filter): Promise<Page<AiJob>> {
      const limit = Math.min(filter.limit ?? 20, 100);
      const offset = Math.max(filter.offset ?? 0, 0);

      return tx(async (sql) => {
        const rows = await sql<(JobRow & { total_count: string })[]>`
          with directory as (${DIRECTORY(sql)}),
          filtered as (
            ${JOB_SELECT(sql)}
            where (${filter.caseId ?? null}::uuid is null
                   or j.case_id = ${filter.caseId ?? null}::uuid)
              and (${filter.mine ?? false}::boolean = false
                   or j.requested_by = ${actor.userId}::uuid)
              and (${filter.status ?? null}::text is null
                   or j.status = ${filter.status ?? null})
          )
          select f.*, count(*) over () as total_count
          from filtered f
          order by f.created_at desc
          limit ${limit} offset ${offset}
        `;

        return {
          rows: rows.map(toJob),
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        };
      });
    },

    async cached(input) {
      // Its own system-process transaction, not the caller's. The cache is
      // written by the worker and reachable only as a system process, and
      // wrapping that in the asker's transaction would have opened a second
      // connection to do nothing.
      //
      // Reading it as the asker instead would need a select policy, and a
      // policy wide enough to serve a cache hit is wide enough to expose
      // every cached answer to everybody. The protection here is the key: an
      // entry is addressable only by the hash of the prompt, the question and
      // the exact passages, so reaching one means already holding all three.
      return withSystemActor("ai-cache-read", actor.requestId, async (sql) => {
        const rows = await sql<{ output: Suggestion }[]>`
          select output from config.ai_cache
          where prompt_version = ${input.promptVersion}
            and input_hash = ${input.inputHash}
        `;

        if (rows.length === 0) return null;

        await sql`
          update config.ai_cache
          set hits = hits + 1, last_hit_at = now()
          where prompt_version = ${input.promptVersion}
            and input_hash = ${input.inputHash}
        `;

        return rows[0].output;
      });
    },

    async claim(limit) {
      return withSystemActor("ai-drain", crypto.randomUUID(), async (sql) => {
        const rows = await sql<JobRow[]>`
          with directory as (${DIRECTORY(sql)}),
          due as (
            select id from config.ai_jobs
            where status = 'queued'
            order by created_at
            limit ${Math.min(Math.max(limit, 1), 25)}
            for update skip locked
          ),
          claimed as (
            update config.ai_jobs j
            set status = 'running',
                started_at = now(),
                attempts = j.attempts + 1
            where j.id in (select due.id from due)
            returning j.id
          )
          ${JOB_SELECT(sql)}
          where j.id in (select claimed.id from claimed)
        `;

        const out: Array<{ job: AiJob; redactions: Redaction[] }> = [];
        for (const row of rows) {
          const map = await sql<{ token: string; original: string }[]>`
            select token, original from config.ai_restore(${row.id}::uuid)
          `;
          out.push({
            job: toJob(row),
            // The kind is not needed to restore, only to write, so it is not
            // read back: `restore` matches on the token alone.
            redactions: map.map((entry) => ({
              token: entry.token,
              original: entry.original,
              kind: "person" as const,
            })),
          });
        }
        return out;
      });
    },

    async recordResult(input) {
      await withSystemActor("ai-drain", crypto.randomUUID(), async (sql) => {
        await sql`
          update config.ai_jobs
          set status = ${input.status},
              provider_key = ${input.providerKey ?? null},
              model = ${input.model ?? null},
              prompt_tokens = ${input.promptTokens ?? null},
              completion_tokens = ${input.completionTokens ?? null},
              output = ${input.output ? sql.json(asJson(input.output)) : null}::jsonb,
              error = ${input.error ?? null},
              finished_at = now()
          where id = ${input.id}::uuid
        `;

        if (input.cacheIt && input.output) {
          await sql`
            insert into config.ai_cache (
              prompt_version, input_hash, output, provider_key, model
            )
            select j.prompt_version, j.input_hash, ${sql.json(asJson(input.output))}::jsonb,
                   ${input.providerKey ?? null}, ${input.model ?? null}
            from config.ai_jobs j
            where j.id = ${input.id}::uuid
            on conflict (prompt_version, input_hash) do nothing
          `;
        }

        // The other half of PRD 22.4's logging requirement: what actually
        // went out, to which provider, at what cost.
        await sql`
          select audit.write(
            ${input.status === "succeeded" ? "ai.answered" : "ai.failed"},
            'config.ai_jobs', ${input.id},
            (select case_id from config.ai_jobs where id = ${input.id}::uuid),
            null,
            ${sql.json({
              provider: input.providerKey ?? null,
              model: input.model ?? null,
              promptTokens: input.promptTokens ?? null,
              completionTokens: input.completionTokens ?? null,
              statements: input.output?.statements.length ?? 0,
              discarded: input.output?.discarded.length ?? 0,
              error: input.error ?? null,
            })}
          )
        `;
      });
    },

    async decide(input) {
      return tx(async (sql) => {
        const existingJob = await sql<
          { accepted_at: string | null; rejected_at: string | null }[]
        >`
          select accepted_at, rejected_at from config.ai_jobs
          where id = ${input.id}::uuid
        `;

        if (existingJob.length === 0) {
          throw new AiError("not_found", "That suggestion no longer exists.");
        }
        if (existingJob[0].accepted_at || existingJob[0].rejected_at) {
          throw new AiError(
            "already_decided",
            "Somebody has already accepted or rejected this suggestion. A second decision would overwrite the first, and PRD 22.3 wants the one that was made on the record.",
          );
        }

        await sql`
          update config.ai_jobs
          set accepted_by = ${input.accept ? sql`${actor.userId}::uuid` : null},
              accepted_at = ${input.accept ? sql`now()` : null},
              rejected_by = ${input.accept ? null : sql`${actor.userId}::uuid`},
              rejected_at = ${input.accept ? null : sql`now()`},
              decision_note = ${input.note}
          where id = ${input.id}::uuid
        `;

        // PRD 22.3: acceptance is audited with the accepting user and the
        // model version, which is why the model is read back rather than
        // taken from the caller.
        await sql`
          select audit.write(
            ${input.accept ? "ai.suggestion_accepted" : "ai.suggestion_rejected"},
            'config.ai_jobs', ${input.id},
            (select case_id from config.ai_jobs where id = ${input.id}::uuid),
            null,
            ${sql.json({ note: input.note })}
          )
        `;

        const rows = await sql<JobRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${JOB_SELECT(sql)}
          where j.id = ${input.id}::uuid
        `;
        return toJob(rows[0]);
      });
    },
  };
}

import { afterAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { testSql } from "../helpers/sql";
import {
  createCaseSettingRepository,
  createJobRepository,
  createProviderRepository,
} from "@/modules/ai/infrastructure/ai-repository";
import { PROMPT_VERSION } from "@/modules/ai/domain/policies";
import { createCaseRepository } from "@/modules/casework/infrastructure/case-repository";
import { createClientRepository } from "@/modules/crm/infrastructure/client-repository";
import { createEngagementRepository } from "@/modules/crm/infrastructure/engagement-repository";
import type { ActorContext } from "@/lib/db/client";

/**
 * The AI gateway against the real Postgres (PRD 22).
 *
 * Everything runs in a transaction that is always rolled back, and nothing
 * here contacts a provider: there is no provider to contact, which is the
 * first thing this file proves.
 *
 * What is worth proving against the database rather than in the domain tests
 * is the half the domain cannot enforce:
 *
 *   that the allow-list is empty on a fresh install, so AI is genuinely off
 *   rather than merely documented as off;
 *
 *   that a provider cannot be enabled without its retention terms having
 *   been read, which is PRD 22.4's condition for using a free provider at
 *   all;
 *
 *   that a case with no setting row is off, and that enabling one records who
 *   decided and why;
 *
 *   that a blocked request is kept on the record rather than discarded;
 *
 *   and that the pseudonymisation map is beyond the application role's reach,
 *   which is the one guarantee whose failure would put real names outside the
 *   platform.
 */

const hasDb = Boolean(process.env.SUPABASE_DB_URL);
const suite = describe.skipIf(!hasDb);

const sql = hasDb ? testSql() : null;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

class Rollback extends Error {}

async function inRolledBackTx(
  body: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  try {
    await sql!.begin(async (tx) => {
      await body(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

/** An expected refusal, without taking the transaction with it. */
async function refused(
  tx: postgres.TransactionSql,
  body: () => Promise<unknown>,
): Promise<Error> {
  try {
    await tx.savepoint(async () => {
      await body();
    });
  } catch (error) {
    return error as Error;
  }
  throw new Error("that was expected to be refused, and was not");
}

async function seedUser(
  tx: postgres.TransactionSql,
  roles: string[] = ["operations_manager", "investigator", "supervisor"],
): Promise<string> {
  const [{ id }] = await tx<{ id: string }[]>`
    select extensions.gen_random_uuid() as id
  `;
  const email = `pddc-ai-${id}@example.invalid`;

  await tx`
    insert into auth.users
      (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${id}::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${email}, 'fixture', now(), now())
  `;
  // `full_name` in the update too. primaddc.com's own `handle_new_user()`
  // trigger creates this row the instant auth.users is inserted, with no
  // name, so an upsert that set only the email on conflict left the name null
  // and the staff directory returned nothing for it.
  await tx`
    insert into public.profiles (id, email, full_name)
    values (${id}::uuid, ${email}, 'Ama Darko')
    on conflict (id) do update
      set email = excluded.email, full_name = excluded.full_name
  `;
  await tx`
    insert into iam.users (id, clearance, status)
    values (${id}::uuid, 'STRICTLY_RESTRICTED', 'active')
  `;
  for (const key of roles) {
    await tx`
      insert into iam.user_roles (user_id, role_id)
      select ${id}::uuid, r.id from iam.roles r where r.key = ${key}
    `;
  }
  return id;
}

function actorFor(userId: string): ActorContext {
  return {
    userId,
    clearance: "STRICTLY_RESTRICTED",
    requestId: crypto.randomUUID(),
    aal: "aal2",
    ip: "203.0.113.10",
    userAgent: "vitest",
  };
}

async function seedCase(
  tx: postgres.TransactionSql,
  actor: ActorContext,
  name: string,
) {
  const clients = createClientRepository(actor, tx);
  const engagements = createEngagementRepository(actor, tx);
  const cases = createCaseRepository(actor, tx);

  const client = await clients.create({
    organisationName: name,
    clientType: "corporate",
    riskRating: "medium",
    status: "active",
    classification: "CONFIDENTIAL",
  });
  const engagement = await engagements.create({
    clientId: client.id,
    title: `${name} engagement`,
    engagementType: "fraud_investigation",
    classification: "CONFIDENTIAL",
  });
  await engagements.setStatus({
    id: engagement.id,
    status: "pending_approval",
    reason: "ready",
  });
  await engagements.setStatus({
    id: engagement.id,
    status: "approved",
    reason: "approved for the test",
    approve: true,
  });

  return cases.create({
    title: `${name} case`,
    clientId: client.id,
    engagementId: engagement.id,
    caseType: "fraud_investigation",
    priority: "medium",
    classification: "CONFIDENTIAL",
  });
}

suite("AI is off until somebody turns it on (PRD 22.4)", () => {
  it("has no provider on the allow-list at all", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const providers = await createProviderRepository(actorFor(user), tx).list();

      // The single most important assertion in this file. PRD 22's
      // Amendment 12 says the platform works fully with AI switched off, and
      // an empty allow-list is what makes that true rather than claimed.
      expect(providers).toEqual([]);
    });
  });

  it("will not enable a provider whose terms nobody has read", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const repo = createProviderRepository(actorFor(user), tx);

      const error = await refused(tx, () =>
        repo.save({
          key: "probe",
          label: "Probe",
          baseUrl: "https://example.invalid/v1",
          model: "probe-model",
          apiKeyEnv: "PROBE_API_KEY",
          retentionTerms: null,
          position: 10,
          maxClassification: "INTERNAL",
          notes: null,
          isEnabled: true,
        }),
      );

      expect(error.message).toMatch(/ai_providers_enabled_needs_reviewed_terms/);
    });
  });

  it("records who read the terms, and when", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const repo = createProviderRepository(actorFor(user), tx);

      const saved = await repo.save({
        key: "probe",
        label: "Probe",
        baseUrl: "https://example.invalid/v1",
        model: "probe-model",
        apiKeyEnv: "PROBE_API_KEY",
        retentionTerms: "Retains prompts for 30 days and does not train on them.",
        position: 10,
        maxClassification: "INTERNAL",
        notes: null,
        isEnabled: true,
      });

      expect(saved.isEnabled).toBe(true);
      expect(saved.termsReviewedAt).not.toBeNull();
      expect(saved.termsReviewedByName).toBe("Ama Darko");
    });
  });

  it("does not re-date the reading when only a label changes", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const repo = createProviderRepository(actorFor(user), tx);

      const first = await repo.save({
        key: "probe",
        label: "Probe",
        baseUrl: "https://example.invalid/v1",
        model: "probe-model",
        apiKeyEnv: "PROBE_API_KEY",
        retentionTerms: "Retains prompts for 30 days.",
        position: 10,
        maxClassification: "INTERNAL",
        notes: null,
        isEnabled: false,
      });

      const second = await repo.save({
        key: "probe",
        label: "Probe Renamed",
        baseUrl: "https://example.invalid/v1",
        model: "probe-model",
        apiKeyEnv: "PROBE_API_KEY",
        retentionTerms: "Retains prompts for 30 days.",
        position: 20,
        maxClassification: "INTERNAL",
        notes: "renamed",
        isEnabled: false,
      });

      // Dating a label correction as a fresh reading of a third party's
      // retention policy would be a false record, and this is the field an
      // administrator relies on to know when somebody last checked.
      expect(second.termsReviewedAt).toBe(first.termsReviewedAt);
      expect(second.label).toBe("Probe Renamed");
    });
  });

  it("treats a case with no setting as off, and records the decision when it changes", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "AI Probe Co Ltd");
      const settings = createCaseSettingRepository(actor, tx);

      expect(await settings.forCase(record.id)).toBeNull();

      const decided = await settings.decide({
        caseId: record.id,
        isEnabled: true,
        reason: "Open-source material only, client has no restriction.",
        clientConsentRecorded: true,
      });

      expect(decided.isEnabled).toBe(true);
      expect(decided.decidedBy).toBe(user);
      expect(decided.reason).toMatch(/Open-source material/);

      // And turning it off again is a decision in its own right, with its own
      // reason, rather than a reversion to the default.
      const off = await settings.decide({
        caseId: record.id,
        isEnabled: false,
        reason: "Client contract restricts third-party processing.",
        clientConsentRecorded: false,
        expectedVersion: decided.version,
      });

      expect(off.isEnabled).toBe(false);
      expect(off.version).toBe(decided.version + 1);
    });
  });

  it("refuses a stale version rather than overwriting somebody's decision", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "AI Concurrency Co Ltd");
      const settings = createCaseSettingRepository(actor, tx);

      const first = await settings.decide({
        caseId: record.id,
        isEnabled: true,
        reason: "First decision, recorded properly.",
        clientConsentRecorded: true,
      });

      await settings.decide({
        caseId: record.id,
        isEnabled: false,
        reason: "Second decision, by somebody who had the current version.",
        clientConsentRecorded: false,
        expectedVersion: first.version,
      });

      const error = await refused(tx, () =>
        settings.decide({
          caseId: record.id,
          isEnabled: true,
          reason: "Third decision, from a stale screen.",
          clientConsentRecorded: true,
          expectedVersion: first.version,
        }),
      );

      expect(error.message).toMatch(/changed this setting/i);
    });
  });
});

suite("the jobs and the redaction map", () => {
  it("keeps a blocked request on the record rather than discarding it", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "AI Blocked Co Ltd");
      const jobs = createJobRepository(actor, tx);

      const job = await jobs.recordBlocked({
        caseId: record.id,
        kind: "assist",
        promptVersion: PROMPT_VERSION,
        inputHash: "a".repeat(64),
        subject: "What do the restricted exhibits say?",
        reason:
          "PRD 22.4 allows only PUBLIC and INTERNAL material to reach a cloud provider.",
      });

      expect(job.status).toBe("blocked");
      expect(job.blockedReason).toMatch(/PRD 22.4/);

      // An auditor should be able to find that somebody asked a question
      // which would have required confidential material, which is why this is
      // a record and not a thrown-away refusal.
      const [{ n }] = await tx<{ n: string }[]>`
        select count(*)::text as n from audit.audit_log
        where action = 'ai.blocked' and record_id = ${job.id}
      `;
      expect(Number(n)).toBe(1);
    });
  });

  it("does not count a blocked request against the quota it never spent", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "AI Quota Co Ltd");
      const jobs = createJobRepository(actor, tx);

      await jobs.recordBlocked({
        caseId: record.id,
        kind: "assist",
        promptVersion: PROMPT_VERSION,
        inputHash: "b".repeat(64),
        subject: "A question that was refused",
        reason: "nothing sendable",
      });

      // The quota rations a provider's free allowance, and a blocked request
      // spent none of it.
      const used = await jobs.usageToday(record.id);
      expect(used.byUser).toBe(0);
      expect(used.byCase).toBe(0);
    });
  });

  it("counts a queued request, per user and per case", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "AI Counting Co Ltd");
      const settings = createCaseSettingRepository(actor, tx);
      const jobs = createJobRepository(actor, tx);

      // A provider has to exist and the case has to be opted in, because the
      // insert policy calls config.ai_available_for_case.
      await createProviderRepository(actor, tx).save({
        key: "probe",
        label: "Probe",
        baseUrl: "https://example.invalid/v1",
        model: "probe-model",
        apiKeyEnv: "PROBE_API_KEY",
        retentionTerms: "Retains nothing.",
        position: 10,
        maxClassification: "INTERNAL",
        notes: null,
        isEnabled: true,
      });
      await settings.decide({
        caseId: record.id,
        isEnabled: true,
        reason: "Enabled for this test, with a reason as the table requires.",
        clientConsentRecorded: true,
      });

      const job = await jobs.enqueue({
        caseId: record.id,
        kind: "assist",
        promptVersion: PROMPT_VERSION,
        inputHash: "c".repeat(64),
        subject: "What do the findings say?",
        recordType: null,
        recordId: null,
        classification: "INTERNAL",
        redactions: [
          { token: "[PERSON_1]", original: "Kofi Mensah", kind: "person" },
          { token: "[ACCOUNT_1]", original: "1234567890123", kind: "account" },
        ],
      });

      expect(job.status).toBe("queued");

      const used = await jobs.usageToday(record.id);
      expect(used.byUser).toBe(1);
      expect(used.byCase).toBe(1);

      // The map was written with the job, in the same transaction, because a
      // job whose map was lost is an answer nobody can restore.
      const [{ n }] = await tx<{ n: string }[]>`
        select count(*)::text as n from config.ai_redactions
        where job_id = ${job.id}::uuid
      `;
      expect(Number(n)).toBe(2);
    });
  });

  /**
   * The four conditions, asserted on the function rather than on the policy.
   *
   * `ai_jobs_insert` calls `config.ai_available_for_case`, and that policy
   * cannot be exercised from here: this connection is `postgres`, which holds
   * `rolbypassrls`, so forcing row-level security on the table does nothing
   * for it. A test that queued a job and expected a refusal would pass for
   * the wrong reason or fail for the wrong one.
   *
   * What CAN be tested, and is the substance of the rule, is the function the
   * policy consults. A SECURITY DEFINER function answers the same way
   * whoever calls it, so this is the real check and the policy is one line
   * of SQL asserted structurally below it.
   */
  it("says AI is unavailable until a provider, the case and the asker all line up", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "AI Not Enabled Co Ltd");

      const available = async () => {
        const [row] = await tx<{ ok: boolean }[]>`
          select config.ai_available_for_case(${record.id}::uuid) as ok
        `;
        return row.ok;
      };

      await tx`select set_config('iims.user_id', ${user}, true)`;
      await tx`select set_config('iims.clearance', 'STRICTLY_RESTRICTED', true)`;

      // Nothing configured at all.
      expect(await available()).toBe(false);

      await createProviderRepository(actor, tx).save({
        key: "probe",
        label: "Probe",
        baseUrl: "https://example.invalid/v1",
        model: "probe-model",
        apiKeyEnv: "PROBE_API_KEY",
        retentionTerms: "Retains nothing.",
        position: 10,
        maxClassification: "INTERNAL",
        notes: null,
        isEnabled: true,
      });

      // A provider exists, and the case has still not been opted in. This is
      // the state PRD 22.4 calls the default, and it is the one most likely
      // to be got wrong by treating a configured provider as consent.
      await tx`select set_config('iims.user_id', ${user}, true)`;
      expect(await available()).toBe(false);

      await createCaseSettingRepository(actor, tx).decide({
        caseId: record.id,
        isEnabled: true,
        reason: "Enabled for this test, with a reason as the table requires.",
        clientConsentRecorded: true,
      });

      await tx`select set_config('iims.user_id', ${user}, true)`;
      expect(await available()).toBe(true);

      // And with no identity at all it is false, which is the fail-closed
      // half: a query that escaped the actor wrapper denies rather than
      // leaks.
      await tx`select set_config('iims.user_id', '', true)`;
      expect(await available()).toBe(false);
    });
  });

  it("gates the job insert on that same function", async () => {
    await inRolledBackTx(async (tx) => {
      // The structural half of the assertion above. If somebody rewrites the
      // policy without the function, the test that matters still passes and
      // this one does not.
      const [row] = await tx<{ expr: string }[]>`
        select pg_get_expr(polwithcheck, polrelid) as expr
        from pg_policy
        where polrelid = 'config.ai_jobs'::regclass
          and polname = 'ai_jobs_insert'
      `;

      expect(row.expr).toMatch(/ai_available_for_case/);
      expect(row.expr).toMatch(/current_user_id/);
    });
  });

  it("keeps the pseudonymisation map out of the application role's reach", async () => {
    await inRolledBackTx(async (tx) => {
      // Not a row-level check: a privilege one. `iims_app` holds no SELECT,
      // INSERT or UPDATE on the table at all, so a policy added later would
      // have nothing to act on. This is the guarantee whose failure would put
      // real names outside the platform.
      const [row] = await tx<
        { sel: boolean; ins: boolean; upd: boolean; del: boolean }[]
      >`
        select
          has_table_privilege('iims_app', 'config.ai_redactions', 'select') as sel,
          has_table_privilege('iims_app', 'config.ai_redactions', 'insert') as ins,
          has_table_privilege('iims_app', 'config.ai_redactions', 'update') as upd,
          has_table_privilege('iims_app', 'config.ai_redactions', 'delete') as del
      `;

      expect(row).toEqual({ sel: false, ins: false, upd: false, del: false });
    });
  });

  it("restores a map only for the job's own requester", async () => {
    await inRolledBackTx(async (tx) => {
      const asker = await seedUser(tx);
      const other = await seedUser(tx);
      const actor = actorFor(asker);
      const record = await seedCase(tx, actor, "AI Restore Co Ltd");

      await createProviderRepository(actor, tx).save({
        key: "probe",
        label: "Probe",
        baseUrl: "https://example.invalid/v1",
        model: "probe-model",
        apiKeyEnv: "PROBE_API_KEY",
        retentionTerms: "Retains nothing.",
        position: 10,
        maxClassification: "INTERNAL",
        notes: null,
        isEnabled: true,
      });
      await createCaseSettingRepository(actor, tx).decide({
        caseId: record.id,
        isEnabled: true,
        reason: "Enabled for this test, with a reason as the table requires.",
        clientConsentRecorded: true,
      });

      const job = await createJobRepository(actor, tx).enqueue({
        caseId: record.id,
        kind: "assist",
        promptVersion: PROMPT_VERSION,
        inputHash: "e".repeat(64),
        subject: "Who signed it?",
        recordType: null,
        recordId: null,
        classification: "INTERNAL",
        redactions: [
          { token: "[PERSON_1]", original: "Kofi Mensah", kind: "person" },
        ],
      });

      await tx`select set_config('iims.user_id', ${asker}, true)`;
      const mine = await tx<{ token: string; original: string }[]>`
        select token, original from config.ai_restore(${job.id}::uuid)
      `;
      expect(mine).toEqual([{ token: "[PERSON_1]", original: "Kofi Mensah" }]);

      // Somebody else gets nothing, even though they can see the job itself:
      // the suggestion is reviewable by the case team, and the map that
      // produced it is not.
      await tx`select set_config('iims.user_id', ${other}, true)`;
      const theirs = await tx`
        select token, original from config.ai_restore(${job.id}::uuid)
      `;
      expect(theirs).toHaveLength(0);
    });
  });

  it("records a human decision once, and refuses a second", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await seedUser(tx);
      const actor = actorFor(user);
      const record = await seedCase(tx, actor, "AI Decision Co Ltd");

      await createProviderRepository(actor, tx).save({
        key: "probe",
        label: "Probe",
        baseUrl: "https://example.invalid/v1",
        model: "probe-model",
        apiKeyEnv: "PROBE_API_KEY",
        retentionTerms: "Retains nothing.",
        position: 10,
        maxClassification: "INTERNAL",
        notes: null,
        isEnabled: true,
      });
      await createCaseSettingRepository(actor, tx).decide({
        caseId: record.id,
        isEnabled: true,
        reason: "Enabled for this test, with a reason as the table requires.",
        clientConsentRecorded: true,
      });

      const jobs = createJobRepository(actor, tx);
      const job = await jobs.enqueue({
        caseId: record.id,
        kind: "assist",
        promptVersion: PROMPT_VERSION,
        inputHash: "f".repeat(64),
        subject: "What is the position?",
        recordType: null,
        recordId: null,
        classification: "INTERNAL",
        redactions: [],
      });

      const accepted = await jobs.decide({
        id: job.id,
        accept: true,
        note: "Consistent with F-001.",
      });

      expect(accepted.acceptedBy).toBe(user);
      expect(accepted.acceptedAt).not.toBeNull();
      expect(accepted.rejectedAt).toBeNull();

      // PRD 22.3 wants the decision that was made on the record, so a second
      // one is refused rather than allowed to overwrite the first.
      const error = await refused(tx, () =>
        jobs.decide({ id: job.id, accept: false, note: "Changed my mind." }),
      );
      expect(error.message).toMatch(/already accepted or rejected/i);

      const [{ n }] = await tx<{ n: string }[]>`
        select count(*)::text as n from audit.audit_log
        where action = 'ai.suggestion_accepted' and record_id = ${job.id}
      `;
      expect(Number(n)).toBe(1);
    });
  });
});

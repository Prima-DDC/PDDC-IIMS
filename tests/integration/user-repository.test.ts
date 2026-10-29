import { afterAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { testSql } from "../helpers/sql";
import { createUserRepository } from "@/modules/iam/infrastructure/user-repository";
import { isIamError } from "@/modules/iam/domain/errors";
import type { ActorContext } from "@/lib/db/client";

/**
 * The user repository, exercised against the real Postgres.
 *
 * Everything runs inside a transaction that is rolled back, so the shared
 * production database is never written to. The repository accepts the
 * transaction for exactly this reason.
 *
 * Fixtures connect as `postgres` because they must insert into auth.users.
 * That means RLS is not exercised here; it is covered separately by
 * app-role-containment.test.ts, which connects as iims_app.
 */

const hasDb = Boolean(process.env.SUPABASE_DB_URL);
const suite = describe.skipIf(!hasDb);

const sql = hasDb
  ? testSql()
  : null;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

class Rollback extends Error {}

/** Runs the body in a transaction that is always rolled back. */
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

/** Creates an auth.users row plus the IIMS record, and returns the id. */
async function seedUser(
  tx: postgres.TransactionSql,
  opts: { roles?: string[]; clearance?: string; status?: string } = {},
): Promise<string> {
  const [{ id }] = await tx<{ id: string }[]>`
    select extensions.gen_random_uuid() as id
  `;

  await tx`
    insert into auth.users
      (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${id}::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${`pddc-repo-${id}@example.invalid`}, 'fixture', now(), now())
  `;

  await tx`
    insert into iam.users (id, clearance, status)
    values (${id}::uuid, ${opts.clearance ?? "CONFIDENTIAL"}, ${opts.status ?? "active"})
  `;

  for (const key of opts.roles ?? []) {
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

suite("user repository", () => {
  it("provisions a user, and the baseline role is added automatically", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      const [{ id: target }] = await tx<{ id: string }[]>`
        select extensions.gen_random_uuid() as id
      `;
      await tx`
        insert into auth.users
          (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
        values (${target}::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
                'authenticated', ${`pddc-repo-${target}@example.invalid`}, 'fixture', now(), now())
      `;

      const repo = createUserRepository(actorFor(admin), tx);
      const [{ id: roleId }] = await tx<{ id: string }[]>`
        select id from iam.roles where key = 'investigator'
      `;

      const created = await repo.create({
        userId: target,
        clearance: "CONFIDENTIAL",
        status: "invited",
        employeeId: "EMP-TEST-1",
        jobTitle: "Field Investigator",
        roleIds: [roleId],
      });

      expect(created.id).toBe(target);
      expect(created.status).toBe("invited");
      expect(created.employeeId).toBe("EMP-TEST-1");

      // Investigator plus the baseline Employee role (PRD 3.1).
      const keys = created.roles.map((r) => r.roleKey).sort();
      expect(keys).toContain("investigator");
      expect(keys).toContain("employee");
    });
  });

  it("refuses to provision somebody who already has access", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      const existing = await seedUser(tx);

      const repo = createUserRepository(actorFor(admin), tx);

      await expect(
        repo.create({
          userId: existing,
          clearance: "INTERNAL",
          status: "active",
          roleIds: [],
        }),
      ).rejects.toSatisfy(
        (e: unknown) => isIamError(e) && e.code === "conflict",
      );
    });
  });

  it("writes an audit row in the same transaction as the change", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      const target = await seedUser(tx);
      const repo = createUserRepository(actorFor(admin), tx);

      await repo.setStatus(target, "suspended", "under investigation");

      const rows = await tx<
        { action: string; actor: string; reason: string; after: unknown }[]
      >`
        select action, actor_user_id as actor, reason, after_value as after
        from audit.audit_log
        where record_id = ${target} and action = 'user.status_changed'
        order by seq desc limit 1
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0].actor).toBe(admin);
      expect(rows[0].reason).toBe("under investigation");
      expect(rows[0].after).toEqual({ status: "suspended" });
    });
  });

  it("records the caller IP and user agent on the audit row", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      const target = await seedUser(tx);
      const repo = createUserRepository(actorFor(admin), tx);

      await repo.setStatus(target, "suspended", "test");

      const [row] = await tx<{ ip: string | null; ua: string | null }[]>`
        select host(ip) as ip, user_agent as ua
        from audit.audit_log
        where record_id = ${target} order by seq desc limit 1
      `;

      // PRD 13 requires the audit record to carry IP and device. The
      // repository establishes the actor context on the transaction it is
      // given, so this is the same code path production uses.
      expect(row.ip).toBe("203.0.113.10");
      expect(row.ua).toBe("vitest");
    });
  });

  it("enforces optimistic concurrency on update", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      const target = await seedUser(tx);
      const repo = createUserRepository(actorFor(admin), tx);

      const before = await repo.findById(target);
      expect(before).not.toBeNull();

      const updated = await repo.update(target, {
        jobTitle: "Senior Investigator",
        expectedVersion: before!.version,
      });
      expect(updated.jobTitle).toBe("Senior Investigator");
      expect(updated.version).toBeGreaterThan(before!.version);

      // Replaying the same expected version must be rejected (PRD 21.7).
      await expect(
        repo.update(target, {
          jobTitle: "Someone else's edit",
          expectedVersion: before!.version,
        }),
      ).rejects.toSatisfy(
        (e: unknown) => isIamError(e) && e.code === "stale_version",
      );
    });
  });

  it("soft-deletes and restores, never hard-deleting", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      const target = await seedUser(tx);
      const repo = createUserRepository(actorFor(admin), tx);

      await repo.softDelete(target, "left the company");

      const [row] = await tx<{ deleted_at: string | null; status: string }[]>`
        select deleted_at, status from iam.users where id = ${target}::uuid
      `;
      expect(row.deleted_at).not.toBeNull();
      expect(row.status).toBe("archived");

      await repo.restore(target, "rejoined");
      const [after] = await tx<{ deleted_at: string | null; status: string }[]>`
        select deleted_at, status from iam.users where id = ${target}::uuid
      `;
      expect(after.deleted_at).toBeNull();
      expect(after.status).toBe("deactivated");
    });
  });

  it("assigns and removes roles, and keeps one primary role", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      const target = await seedUser(tx);
      const repo = createUserRepository(actorFor(admin), tx);

      const roles = await tx<{ id: string; key: string }[]>`
        select id, key from iam.roles where key in ('investigator', 'qa_reviewer')
      `;

      for (const role of roles) {
        await repo.assignRole({
          userId: target,
          roleId: role.id,
          scopeType: "all",
          isPrimary: role.key === "investigator",
        });
      }

      let user = await repo.findById(target);
      expect(user!.roles).toHaveLength(2);
      expect(user!.roles.filter((r) => r.isPrimary)).toHaveLength(1);
      expect(user!.roles.find((r) => r.isPrimary)!.roleKey).toBe("investigator");

      // Switching the primary role must not leave two.
      const qa = user!.roles.find((r) => r.roleKey === "qa_reviewer")!;
      await repo.setPrimaryRole(target, qa.id);
      user = await repo.findById(target);
      expect(user!.roles.filter((r) => r.isPrimary)).toHaveLength(1);
      expect(user!.roles.find((r) => r.isPrimary)!.roleKey).toBe("qa_reviewer");

      await repo.removeRole(qa.id, "no longer reviewing");
      user = await repo.findById(target);
      expect(user!.roles.map((r) => r.roleKey)).not.toContain("qa_reviewer");
    });
  });

  it("resolves effective permissions with their source", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      const target = await seedUser(tx, { roles: ["investigator"] });
      const repo = createUserRepository(actorFor(admin), tx);

      const perms = await repo.effectivePermissions(target);

      expect(perms.length).toBeGreaterThan(0);
      const cases = perms.find((p) => p.resource === "cases" && p.action === "view");
      expect(cases).toBeDefined();
      expect(cases!.source).toBe("role:investigator");
      expect(cases!.scope).toBe("assigned");
    });
  });

  it("adds and removes a permission override", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      const target = await seedUser(tx, { roles: ["investigator"] });
      const repo = createUserRepository(actorFor(admin), tx);

      const [perm] = await tx<{ id: string }[]>`
        select id from iam.permissions
        where resource = 'evidence' and action = 'upload' limit 1
      `;

      await repo.addOverride({
        userId: target,
        permissionId: perm.id,
        effect: "deny",
        reason: "pending disciplinary review",
      });

      let overrides = await repo.listOverrides(target);
      expect(overrides).toHaveLength(1);
      expect(overrides[0].effect).toBe("deny");
      expect(overrides[0].reason).toBe("pending disciplinary review");

      // The deny must actually take effect.
      const [{ ok }] = await tx<{ ok: boolean }[]>`
        select iam.has_permission('evidence', 'upload', null, ${target}::uuid) as ok
      `;
      expect(ok).toBe(false);

      await repo.removeOverride(overrides[0].id, "review closed");
      overrides = await repo.listOverrides(target);
      expect(overrides).toHaveLength(0);
    });
  });

  it("sets and clears a feature override", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      const target = await seedUser(tx, { roles: ["investigator"] });
      const repo = createUserRepository(actorFor(admin), tx);

      await repo.setFeatureOverride({
        userId: target,
        featureKey: "ai.assist",
        enabled: true,
        reason: "pilot participant",
      });

      const list = await repo.listFeatureOverrides(target);
      expect(list).toHaveLength(1);
      expect(list[0].enabled).toBe(true);

      const [{ ok }] = await tx<{ ok: boolean }[]>`
        select iam.has_feature('ai.assist', ${target}::uuid) as ok
      `;
      expect(ok).toBe(true);

      await repo.clearFeatureOverride(target, "ai.assist");
      expect(await repo.listFeatureOverrides(target)).toHaveLength(0);
    });
  });

  it("lists and filters users", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      await seedUser(tx, { roles: ["investigator"], status: "active" });
      await seedUser(tx, { roles: ["investigator"], status: "suspended" });
      const repo = createUserRepository(actorFor(admin), tx);

      const all = await repo.list({ limit: 200 });
      expect(all.total).toBeGreaterThanOrEqual(3);
      expect(all.rows.length).toBeLessThanOrEqual(200);

      const suspended = await repo.list({ status: "suspended", limit: 200 });
      expect(suspended.rows.every((u) => u.status === "suspended")).toBe(true);

      const byRole = await repo.list({ roleKey: "investigator", limit: 200 });
      expect(byRole.total).toBeGreaterThanOrEqual(2);
      expect(
        byRole.rows.every((u) => u.roles.some((r) => r.roleKey === "investigator")),
      ).toBe(true);
    });
  });

  it("excludes soft-deleted users by default and finds them in the recycle bin", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      const target = await seedUser(tx);
      const repo = createUserRepository(actorFor(admin), tx);

      await repo.softDelete(target, "test");

      const normal = await repo.list({ limit: 200 });
      expect(normal.rows.map((u) => u.id)).not.toContain(target);

      const bin = await repo.list({ onlyDeleted: true, limit: 200 });
      expect(bin.rows.map((u) => u.id)).toContain(target);
    });
  });

  it("reports administration statistics", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      await seedUser(tx, { status: "suspended" });
      const repo = createUserRepository(actorFor(admin), tx);

      const stats = await repo.stats();
      expect(stats.total).toBeGreaterThanOrEqual(2);
      expect(stats.suspended).toBeGreaterThanOrEqual(1);
      expect(stats.administrators).toBeGreaterThanOrEqual(1);
    });
  });

  it("reads the shared directory and flags who has IIMS access", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      await tx`select set_config('iims.user_id', ${admin}, true)`;
      const repo = createUserRepository(actorFor(admin), tx);

      const page = await repo.directory({ limit: 50 });
      // The fixture users have profiles created by the website's trigger.
      expect(page.rows.length).toBeGreaterThan(0);
      const me = page.rows.find((r) => r.userId === admin);
      expect(me?.hasIimsAccess).toBe(true);
    });
  });

  it("returns login history and sessions for a user", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await seedUser(tx, { roles: ["administrator"] });
      await tx`select set_config('iims.user_id', ${admin}, true)`;
      const repo = createUserRepository(actorFor(admin), tx);

      await tx`
        select iam.register_login_attempt(
          ${`pddc-repo-${admin}@example.invalid`}, ${admin}::uuid, false, 'bad_password'
        )
      `;

      const history = await repo.loginHistory(admin, 10);
      expect(history).toHaveLength(1);
      expect(history[0].succeeded).toBe(false);
      expect(history[0].failureKind).toBe("bad_password");

      // No real Supabase session exists for a fixture user, so this is empty
      // rather than erroring, which is what the admin screen needs.
      const sessions = await repo.sessions(admin);
      expect(Array.isArray(sessions)).toBe(true);
    });
  });
});

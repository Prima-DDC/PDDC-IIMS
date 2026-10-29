import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { adminClient, asActor, can, makeUser, setOverride } from "../helpers/db";

/**
 * The authorization engine (PRD 3.2, 3.4, 3.5, 14, 16).
 *
 * Every test runs inside a transaction that is rolled back afterwards, so the
 * live database is never modified.
 */

let db: pg.Client;

// These assertions run against the real database. Without credentials the
// suite skips rather than fails, so a checkout with no .env.local is still
// green on the unit tests.
const hasDb = Boolean(process.env.SUPABASE_DB_URL);
const suite = describe.skipIf(!hasDb);

beforeAll(async () => {
  if (!hasDb) return;
  db = adminClient();
  await db.connect();
});

afterAll(async () => {
  if (!hasDb) return;
  await db.end();
});

beforeEach(async () => {
  if (!hasDb) return;
  await db.query("begin");
});

afterEach(async () => {
  if (!hasDb) return;
  await db.query("rollback");
});

suite("effective permissions", () => {
  it("grants what a single role grants", async () => {
    const user = await makeUser(db, { roles: ["investigator"] });

    expect(await can(db, user, "cases", "view")).toBe(true);
    expect(await can(db, user, "evidence", "upload")).toBe(true);
    // An investigator cannot approve their own work (PRD 3.1 limits).
    expect(await can(db, user, "reports", "approve")).toBe(false);
    expect(await can(db, user, "users", "create")).toBe(false);
  });

  it("takes the union of several roles at once", async () => {
    // "A user can hold any number of roles at once, for example Supervisor +
    //  QA Reviewer" (PRD 3.2).
    const user = await makeUser(db, { roles: ["investigator", "qa_reviewer"] });

    expect(await can(db, user, "evidence", "upload")).toBe(true);   // investigator
    expect(await can(db, user, "qa", "create")).toBe(true);         // qa reviewer
    expect(await can(db, user, "reports", "approve")).toBe(true);   // qa reviewer
  });

  it("applies a user-specific allow on top of roles", async () => {
    const user = await makeUser(db, { roles: ["investigator"] });
    expect(await can(db, user, "financials", "view")).toBe(false);

    await setOverride(db, user, "financials", "view", "allow");
    expect(await can(db, user, "financials", "view")).toBe(true);
  });

  it("lets an explicit deny override an allow", async () => {
    // "An explicit deny always overrides an allow" (PRD 3.2).
    const user = await makeUser(db, { roles: ["investigator"] });
    expect(await can(db, user, "evidence", "upload")).toBe(true);

    await setOverride(db, user, "evidence", "upload", "deny");
    expect(await can(db, user, "evidence", "upload")).toBe(false);
  });

  it("lets a deny beat a grant held at a different scope", async () => {
    // A deny must remove the resource/action entirely. A narrower surviving
    // grant would make the deny look applied while leaving a hole.
    const user = await makeUser(db, { roles: ["operations_manager"] });
    expect(await can(db, user, "cases", "edit")).toBe(true);

    // Operations Manager holds cases:edit at scope 'all'; deny at 'assigned'.
    await setOverride(db, user, "cases", "edit", "deny", { scope: "assigned" });
    expect(await can(db, user, "cases", "edit")).toBe(false);
  });

  it("ignores an expired override", async () => {
    const user = await makeUser(db, { roles: ["investigator"] });
    await setOverride(db, user, "evidence", "upload", "deny", {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(await can(db, user, "evidence", "upload")).toBe(true);
  });

  it("ignores a role assignment that has expired", async () => {
    // Role assignments carry start and end dates for temporary cover (3.2).
    const user = await makeUser(db, {
      roles: ["supervisor"],
      validFrom: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      validTo: new Date(Date.now() - 86_400_000).toISOString(),
    });

    expect(await can(db, user, "plans", "approve")).toBe(false);
  });

  it("ignores a role assignment that has not started", async () => {
    const user = await makeUser(db, {
      roles: ["supervisor"],
      validFrom: new Date(Date.now() + 86_400_000).toISOString(),
    });

    expect(await can(db, user, "plans", "approve")).toBe(false);
  });

  it("reports the broadest scope held for a resource and action", async () => {
    const user = await makeUser(db, { roles: ["investigator", "operations_manager"] });

    const { rows } = await db.query<{ scope: string }>(
      "select iam.permission_scope('cases', 'view', $1) as scope",
      [user],
    );
    // investigator grants 'assigned', operations_manager grants 'all'.
    expect(rows[0].scope).toBe("all");
  });

  it("resolves permissions from the session actor when no user is passed", async () => {
    const user = await makeUser(db, { roles: ["investigator"] });

    await asActor(db, user, async () => {
      const { rows } = await db.query<{ ok: boolean }>(
        "select iam.has_permission('cases', 'view') as ok",
      );
      expect(rows[0].ok).toBe(true);
    });
  });

  it("denies everything when no actor is identified", async () => {
    // Policies and checks must fail closed if a query escapes withActor().
    const { rows } = await db.query<{ ok: boolean }>(
      "select iam.has_permission('cases', 'view') as ok",
    );
    expect(rows[0].ok).toBe(false);
  });
});

suite("classification and clearance", () => {
  it("caps a permission at the user's own clearance", async () => {
    // "Classification clearance is assigned per user and is not granted by a
    //  role alone" (PRD 3.2).
    const user = await makeUser(db, {
      roles: ["supervisor"],       // supervisor ceiling is RESTRICTED
      clearance: "CONFIDENTIAL",   // but this person is only cleared to CONFIDENTIAL
    });

    expect(await can(db, user, "cases", "view", "CONFIDENTIAL")).toBe(true);
    expect(await can(db, user, "cases", "view", "RESTRICTED")).toBe(false);
    expect(await can(db, user, "cases", "view", "STRICTLY_RESTRICTED")).toBe(false);
  });

  it("respects the permission ceiling even when clearance is higher", async () => {
    const user = await makeUser(db, {
      roles: ["investigator"],            // ceiling CONFIDENTIAL
      clearance: "STRICTLY_RESTRICTED",   // personally cleared higher
    });

    expect(await can(db, user, "cases", "view", "CONFIDENTIAL")).toBe(true);
    expect(await can(db, user, "cases", "view", "RESTRICTED")).toBe(false);
  });

  it("denies an unknown classification level", async () => {
    const user = await makeUser(db, { roles: ["investigator"], clearance: "STRICTLY_RESTRICTED" });
    expect(await can(db, user, "cases", "view", "NOT_A_LEVEL")).toBe(false);
  });

  it("reports clearance correctly through has_clearance", async () => {
    const user = await makeUser(db, { clearance: "RESTRICTED" });

    const { rows } = await db.query<{ a: boolean; b: boolean; c: boolean }>(
      `select iam.has_clearance('CONFIDENTIAL', $1) as a,
              iam.has_clearance('RESTRICTED', $1) as b,
              iam.has_clearance('STRICTLY_RESTRICTED', $1) as c`,
      [user],
    );
    expect(rows[0]).toEqual({ a: true, b: true, c: false });
  });
});

suite("administrator", () => {
  it("holds every action on every resource through the wildcard grant", async () => {
    const admin = await makeUser(db, { roles: ["administrator"], clearance: "INTERNAL" });

    expect(await can(db, admin, "cases", "delete")).toBe(true);
    expect(await can(db, admin, "evidence", "download")).toBe(true);
    expect(await can(db, admin, "settings", "configure")).toBe(true);
    expect(await can(db, admin, "audit", "view")).toBe(true);
  });

  it("covers a resource that did not exist when the role was created", async () => {
    // "Any new module, resource or feature added later automatically receives
    //  a full Administrator grant" (PRD 3.5). This is why the grant is a
    //  wildcard rather than an enumeration.
    const admin = await makeUser(db, { roles: ["administrator"] });

    expect(await can(db, admin, "some_module_invented_in_2027", "configure")).toBe(true);
  });

  it("carries every clearance level regardless of the stored value", async () => {
    // "except that the Administrator role carries every clearance level" (3.2).
    const admin = await makeUser(db, { roles: ["administrator"], clearance: "PUBLIC" });

    expect(await can(db, admin, "evidence", "view", "STRICTLY_RESTRICTED")).toBe(true);
  });

  it("does not leak the wildcard to a non-administrator", async () => {
    const user = await makeUser(db, { roles: ["investigator"] });
    expect(await can(db, user, "some_module_invented_in_2027", "configure")).toBe(false);
  });
});

suite("account state gates every permission", () => {
  it("strips all permissions from a suspended user", async () => {
    // Suspension must take effect immediately, not at next login.
    const user = await makeUser(db, { roles: ["operations_manager"], status: "suspended" });
    expect(await can(db, user, "cases", "view")).toBe(false);
  });

  it("strips all permissions from a deactivated user", async () => {
    const user = await makeUser(db, { roles: ["operations_manager"], status: "deactivated" });
    expect(await can(db, user, "cases", "view")).toBe(false);
  });

  it("strips all permissions from an invited user who has not enrolled", async () => {
    const user = await makeUser(db, { roles: ["investigator"], status: "invited" });
    expect(await can(db, user, "cases", "view")).toBe(false);
  });

  it("strips all permissions while an account is locked out", async () => {
    const user = await makeUser(db, {
      roles: ["investigator"],
      lockedUntil: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(await can(db, user, "cases", "view")).toBe(false);
  });

  it("restores permissions once the lockout has expired", async () => {
    const user = await makeUser(db, {
      roles: ["investigator"],
      lockedUntil: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await can(db, user, "cases", "view")).toBe(true);
  });

  it("suspending an administrator removes their administrator powers", async () => {
    await makeUser(db, { roles: ["administrator"] });  // keeps one admin alive
    const admin = await makeUser(db, { roles: ["administrator"] });

    await db.query("update iam.users set status = 'suspended' where id = $1", [admin]);

    const { rows } = await db.query<{ ok: boolean }>(
      "select iam.is_administrator($1) as ok",
      [admin],
    );
    expect(rows[0].ok).toBe(false);
  });
});

suite("permission changes take effect without re-login (PRD 3.4)", () => {
  async function versionOf(user: string): Promise<string> {
    const { rows } = await db.query<{ v: string }>(
      "select permissions_version::text as v from iam.users where id = $1",
      [user],
    );
    return rows[0].v;
  }

  it("bumps the user's permissions version when a role is granted", async () => {
    const user = await makeUser(db);
    const before = await versionOf(user);

    await db.query(
      `insert into iam.user_roles (user_id, role_id)
       select $1, id from iam.roles where key = 'investigator'`,
      [user],
    );

    expect(await versionOf(user)).not.toBe(before);
  });

  it("bumps the version when a role is revoked", async () => {
    const user = await makeUser(db, { roles: ["investigator"] });
    const before = await versionOf(user);

    await db.query("delete from iam.user_roles where user_id = $1", [user]);

    expect(await versionOf(user)).not.toBe(before);
  });

  it("bumps the version when an override is added", async () => {
    const user = await makeUser(db, { roles: ["investigator"] });
    const before = await versionOf(user);

    await setOverride(db, user, "financials", "view", "allow");

    expect(await versionOf(user)).not.toBe(before);
  });

  it("bumps every holder of a role when that role's permissions change", async () => {
    const a = await makeUser(db, { roles: ["investigator"] });
    const b = await makeUser(db, { roles: ["investigator"] });
    const beforeA = await versionOf(a);
    const beforeB = await versionOf(b);

    await db.query(
      `insert into iam.role_permissions (role_id, permission_id)
       select r.id, p.id
       from iam.roles r, iam.permissions p
       where r.key = 'investigator'
         and p.resource = 'financials' and p.action = 'view'
       limit 1
       on conflict do nothing`,
    );

    expect(await versionOf(a)).not.toBe(beforeA);
    expect(await versionOf(b)).not.toBe(beforeB);
  });
});

suite("administration safeguards (PRD 3.4)", () => {
  it("refuses to suspend the last active administrator", async () => {
    // Clear the field so the fixture administrator really is the last one.
    await db.query(
      `delete from iam.user_roles
       where role_id = (select id from iam.roles where key = 'administrator')`,
    );
    const onlyAdmin = await makeUser(db, { roles: ["administrator"] });

    await expect(
      db.query("update iam.users set status = 'suspended' where id = $1", [onlyAdmin]),
    ).rejects.toThrow(/last active administrator/i);
  });

  it("allows suspending an administrator while another remains", async () => {
    await db.query(
      `delete from iam.user_roles
       where role_id = (select id from iam.roles where key = 'administrator')`,
    );
    await makeUser(db, { roles: ["administrator"] });
    const second = await makeUser(db, { roles: ["administrator"] });

    await expect(
      db.query("update iam.users set status = 'suspended' where id = $1", [second]),
    ).resolves.toBeTruthy();
  });

  it("refuses to soft-delete the last active administrator", async () => {
    await db.query(
      `delete from iam.user_roles
       where role_id = (select id from iam.roles where key = 'administrator')`,
    );
    const onlyAdmin = await makeUser(db, { roles: ["administrator"] });

    await expect(
      db.query("update iam.users set deleted_at = now() where id = $1", [onlyAdmin]),
    ).rejects.toThrow(/last active administrator/i);
  });

  it("forbids approving your own access-change request", async () => {
    // The two-person rule is the whole point, so it is a table constraint
    // rather than a service-layer check.
    const admin = await makeUser(db, { roles: ["administrator"] });
    const target = await makeUser(db);

    const { rows } = await db.query<{ id: string }>(
      `insert into iam.access_change_requests
         (kind, target_user_id, reason, requested_by)
       values ('grant_administrator', $2, 'promotion', $1)
       returning id`,
      [admin, target],
    );

    await expect(
      db.query(
        `update iam.access_change_requests
         set status = 'approved', decided_by = $2, decided_at = now()
         where id = $1`,
        [rows[0].id, admin],
      ),
    ).rejects.toThrow(/two_person_distinct|violates check constraint/i);
  });

  it("allows a second administrator to approve the request", async () => {
    const requester = await makeUser(db, { roles: ["administrator"] });
    const approver = await makeUser(db, { roles: ["administrator"] });
    const target = await makeUser(db);

    const { rows } = await db.query<{ id: string }>(
      `insert into iam.access_change_requests
         (kind, target_user_id, reason, requested_by)
       values ('grant_administrator', $2, 'promotion', $1)
       returning id`,
      [requester, target],
    );

    await expect(
      db.query(
        `update iam.access_change_requests
         set status = 'approved', decided_by = $2, decided_at = now()
         where id = $1`,
        [rows[0].id, approver],
      ),
    ).resolves.toBeTruthy();
  });
});

suite("account lockout (PRD 14)", () => {
  it("locks the account after the failure threshold and clears on success", async () => {
    // Supabase Auth rate-limits per IP and has no account lockout at all, so
    // this has to be ours.
    const user = await makeUser(db);
    const email = `pddc-fixture-${user}@example.invalid`;

    let locked: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const { rows } = await db.query<{ locked_until: string | null }>(
        "select iam.register_login_attempt($1, $2, false, 'bad_password') as locked_until",
        [email, user],
      );
      locked = rows[0].locked_until;
    }
    expect(locked).not.toBeNull();

    const { rows: state } = await db.query<{ n: number; until: string | null }>(
      "select failed_login_count as n, locked_until as until from iam.users where id = $1",
      [user],
    );
    expect(state[0].n).toBe(5);
    expect(state[0].until).not.toBeNull();

    // The lockout gates permissions too, not just the login form.
    expect(await can(db, user, "profile", "view")).toBe(false);

    await db.query(
      "select iam.register_login_attempt($1, $2, true)",
      [email, user],
    );
    const { rows: after } = await db.query<{ n: number; until: string | null }>(
      "select failed_login_count as n, locked_until as until from iam.users where id = $1",
      [user],
    );
    expect(after[0].n).toBe(0);
    expect(after[0].until).toBeNull();
  });

  it("records an attempt for an unknown email without locking anything", async () => {
    const { rows } = await db.query<{ locked_until: string | null }>(
      "select iam.register_login_attempt('nobody@example.invalid', null, false, 'bad_password') as locked_until",
    );
    expect(rows[0].locked_until).toBeNull();

    const { rows: logged } = await db.query<{ n: number }>(
      "select count(*)::int as n from iam.login_attempts where email = 'nobody@example.invalid'",
    );
    expect(logged[0].n).toBe(1);
  });
});

suite("feature flags (PRD 3.3)", () => {
  it("enables a feature from the role default", async () => {
    const user = await makeUser(db, { roles: ["investigator"] });

    const { rows } = await db.query<{ ok: boolean }>(
      "select iam.has_feature('module.safety', $1) as ok",
      [user],
    );
    expect(rows[0].ok).toBe(true);
  });

  it("lets a per-user override disable a role-enabled feature", async () => {
    const user = await makeUser(db, { roles: ["investigator"] });

    await db.query(
      `insert into iam.user_features (user_id, feature_key, enabled, reason)
       values ($1, 'module.safety', false, 'integration test')`,
      [user],
    );

    const { rows } = await db.query<{ ok: boolean }>(
      "select iam.has_feature('module.safety', $1) as ok",
      [user],
    );
    expect(rows[0].ok).toBe(false);
  });

  it("lets a per-user override enable a feature no role grants", async () => {
    const user = await makeUser(db, { roles: ["investigator"] });

    await db.query(
      `insert into iam.user_features (user_id, feature_key, enabled, reason)
       values ($1, 'ai.assist', true, 'integration test')`,
      [user],
    );

    const { rows } = await db.query<{ ok: boolean }>(
      "select iam.has_feature('ai.assist', $1) as ok",
      [user],
    );
    expect(rows[0].ok).toBe(true);
  });

  it("reports false for a feature nobody granted", async () => {
    const user = await makeUser(db, { roles: ["investigator"] });

    const { rows } = await db.query<{ ok: boolean }>(
      "select iam.has_feature('api.access', $1) as ok",
      [user],
    );
    expect(rows[0].ok).toBe(false);
  });
});

suite("audit trail integrity", () => {
  it("writes an audit row with the session actor and advances the chain", async () => {
    const user = await makeUser(db, { roles: ["investigator"] });

    await asActor(db, user, async () => {
      await db.query(
        `select audit.write('case.viewed', 'case', 'PDDC-2026-000001', null,
                             null, null, null, 'CONFIDENTIAL')`,
      );
    });

    const { rows } = await db.query<{ actor: string; action: string; hash: string }>(
      `select actor_user_id as actor, action, row_hash as hash
       from audit.audit_log order by seq desc limit 1`,
    );
    expect(rows[0].actor).toBe(user);
    expect(rows[0].action).toBe("case.viewed");
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the actor's email, not just their id", async () => {
    // An audit row that names nobody readable is close to useless years
    // later, when the uuid means nothing and the person may have left. The
    // address was previously left null, and the audit screen rendered that as
    // "system", so human actions looked like the platform's own.
    const user = await makeUser(db);
    const { rows: identity } = await db.query<{ email: string }>(
      "select email::text as email from auth.users where id = $1",
      [user],
    );
    const email = identity[0].email;

    await asActor(db, user, async () => {
      await db.query("select audit.write('test.actor_email', 'test', '1')");
    });

    const { rows } = await db.query<{ actor_email: string | null }>(
      `select actor_email from audit.audit_log
       where action = 'test.actor_email' order by seq desc limit 1`,
    );
    expect(rows[0].actor_email).toBe(email);
  });

  it("labels a system action as such rather than leaving it blank", async () => {
    await db.query(
      "select set_config('iims.system_process', 'outbox-drain', true)",
    );
    try {
      await db.query("select audit.write('test.system', 'test', '1')");

      const { rows } = await db.query<{ actor_email: string | null }>(
        `select actor_email from audit.audit_log
         where action = 'test.system' order by seq desc limit 1`,
      );
      expect(rows[0].actor_email).toBe("system:outbox-drain");
    } finally {
      await db.query("select set_config('iims.system_process', '', true)");
    }
  });

  it("refuses to write an audit row with no identified actor", async () => {
    await expect(
      db.query("select audit.write('case.viewed', 'case', 'x')"),
    ).rejects.toThrow(/identified actor/i);
  });

  it("keeps the chain unbroken across many sequential appends", async () => {
    const user = await makeUser(db);

    await asActor(db, user, async () => {
      for (let i = 0; i < 25; i += 1) {
        await db.query("select audit.write('test.bulk', 'test', $1)", [String(i)]);
      }
    });

    const { rows } = await db.query<{ ok: boolean; checked: string }>(
      "select ok, checked::text as checked from audit.verify_chain(0)",
    );
    expect(rows[0].ok).toBe(true);
  });

  it("rejects an UPDATE even from the table owner", async () => {
    // This connection is `postgres`, which OWNS audit.audit_log. The row
    // trigger still fires for the owner, so the trail is immutable in normal
    // operation for every role, not only for the application role.
    const user = await makeUser(db);
    await asActor(db, user, async () => {
      await db.query("select audit.write('test.immutable', 'test', '1')");
    });

    await expect(
      db.query("update audit.audit_log set action = 'tampered'"),
    ).rejects.toThrow(/append-only/i);
  });

  it("detects tampering once the guard trigger is removed", async () => {
    // The documented residual risk: `postgres` owns these tables and can
    // disable the trigger, so prevention is not absolute. What the hash chain
    // guarantees is DETECTION, and that is what is asserted here. Everything
    // happens inside a transaction that is rolled back.
    const user = await makeUser(db);
    await asActor(db, user, async () => {
      await db.query("select audit.write('test.tamper', 'test', '1')");
      await db.query("select audit.write('test.tamper', 'test', '2')");
    });

    const { rows: before } = await db.query<{ ok: boolean }>(
      "select ok from audit.verify_chain(0)",
    );
    expect(before[0].ok).toBe(true);

    await db.query("alter table audit.audit_log disable trigger audit_log_no_mutate");
    await db.query(
      `update audit.audit_log set after_value = '{"tampered":true}'::jsonb
       where seq = (select max(seq) from audit.audit_log)`,
    );
    await db.query("alter table audit.audit_log enable trigger audit_log_no_mutate");

    const { rows: after } = await db.query<{ ok: boolean; first_bad_seq: string }>(
      "select ok, first_bad_seq::text as first_bad_seq from audit.verify_chain(0)",
    );
    expect(after[0].ok).toBe(false);
    expect(after[0].first_bad_seq).not.toBeNull();
  });
});

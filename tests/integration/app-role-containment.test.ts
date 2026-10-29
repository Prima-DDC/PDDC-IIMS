import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { SUPABASE_ROOT_CA } from "@/lib/db/supabase-ca";

/**
 * The keystone security test.
 *
 * Everything else in this platform rests on one claim: the role the
 * application actually connects as cannot read, alter or destroy the audit
 * trail, and cannot reach the live primaddc.com website's data. Asserting the
 * GRANTs (scripts/check-coexistence.mjs) is necessary but not sufficient: * this connects as `iims_app` over the real pooler and tries to do the
 * forbidden things.
 *
 * Requires IIMS_APP_DB_URL. Run with:
 *   npx vitest run --mode development tests/integration
 * (dotenv is loaded by the npm script via --env-file.)
 */

const url = process.env.IIMS_APP_DB_URL;

const sql = postgres(url ?? "", {
  prepare: false, // mandatory on the transaction-mode pooler
  max: 1,
  ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
  connection: { application_name: "pddc-iims-test" },
  onnotice: () => {},
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe.skipIf(!url)("iims_app containment", () => {
  it("connects as iims_app, not postgres or service_role", async () => {
    const [row] = await sql<{ me: string }[]>`select current_user as me`;
    expect(row.me).toBe("iims_app");
  });

  it("is not able to bypass row-level security", async () => {
    const [row] = await sql<{ bypass: boolean; superuser: boolean }[]>`
      select rolbypassrls as bypass, rolsuper as superuser
      from pg_roles where rolname = current_user
    `;
    expect(row.bypass).toBe(false);
    expect(row.superuser).toBe(false);
  });

  // --- the audit trail is append-only (PRD §13) ---------------------------

  it("can append to the audit log", async () => {
    const actor = crypto.randomUUID();

    const inserted = await sql.begin(async (tx) => {
      await tx`select set_config('iims.user_id', ${actor}, true)`;
      const result = await tx`
        insert into audit.audit_log (action, record_type, record_id, actor_email)
        values ('test.append', 'test', ${actor}, 'vitest@local')
      `;
      return result.count;
    });

    expect(inserted).toBe(1);
  });

  it("can write an audit row through audit.write", async () => {
    // Not the same as a raw INSERT. audit.write once ended with
    // `insert ... returning audit_id`, and RETURNING needs SELECT, which this
    // role deliberately lacks, so every audit write from the application
    // failed with "permission denied for table audit_log". Exercising the
    // function itself is what catches that.
    const actor = crypto.randomUUID();

    const id = await sql.begin(async (tx) => {
      await tx`select set_config('iims.user_id', ${actor}, true)`;
      const rows = await tx<{ id: string }[]>`
        select audit.write('test.write', 'test', ${actor}) as id
      `;
      return rows[0].id;
    });

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("cannot write an audit row without an identified actor", async () => {
    await expect(
      sql`select audit.write('test.anonymous', 'test', 'x')`,
    ).rejects.toThrow(/identified actor/i);
  });

  it("cannot read the audit log without the audit permission", async () => {
    // Reads go through audit.read_audit_log(), which is SECURITY DEFINER and
    // therefore checks the permission itself. An actor with no roles is
    // refused, and the refusal is what keeps the trail need-to-know.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('iims.user_id', ${crypto.randomUUID()}, true)`;
        return tx`select * from audit.read_audit_log(null, null, null, null, null, 1, null)`;
      }),
    ).rejects.toThrow(/not permitted to read the audit trail/i);
  });

  it("cannot SELECT from the audit log directly", async () => {
    // Reads must go through audit.read_audit_log(), which logs the read.
    await expect(sql`select * from audit.audit_log limit 1`).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("cannot UPDATE the audit log", async () => {
    await expect(
      sql`update audit.audit_log set action = 'tampered'`,
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it("cannot DELETE from the audit log", async () => {
    await expect(sql`delete from audit.audit_log`).rejects.toThrow(
      /permission denied|append-only/i,
    );
  });

  it("cannot TRUNCATE the audit log", async () => {
    // A separate statement-level trigger: row triggers never fire for TRUNCATE.
    await expect(sql`truncate audit.audit_log`).rejects.toThrow(
      /permission denied|append-only/i,
    );
  });

  it("cannot UPDATE or DELETE custody-style append-only tables", async () => {
    await expect(sql`delete from audit.access_log`).rejects.toThrow(
      /permission denied|append-only/i,
    );
  });

  // --- coexistence with the live website ----------------------------------

  it("can read the shared employee directory", async () => {
    const rows = await sql`select count(*)::int as n from public.profiles`;
    expect(rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it("cannot write to the shared employee directory", async () => {
    await expect(
      sql`update public.profiles set full_name = full_name`,
    ).rejects.toThrow(/permission denied/i);
  });

  it("cannot read the website's content tables", async () => {
    // A representative primaddc.com table the IIMS has no business seeing.
    await expect(
      sql`select 1 from public.content_blocks limit 1`,
    ).rejects.toThrow(/permission denied/i);
  });

  it("cannot read the website's migration ledger", async () => {
    await expect(sql`select 1 from public._migrations limit 1`).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("cannot read Vault secrets", async () => {
    // The cron worker secret lives here in plaintext behind a view.
    await expect(
      sql`select 1 from vault.decrypted_secrets limit 1`,
    ).rejects.toThrow(/permission denied|does not exist/i);
  });

  // --- transaction-local identity -----------------------------------------

  it("scopes the actor setting to its transaction", async () => {
    const actor = crypto.randomUUID();

    const inside = await sql.begin(async (tx) => {
      await tx`select set_config('iims.user_id', ${actor}, true)`;
      const [r] = await tx<{ v: string | null }[]>`
        select current_setting('iims.user_id', true) as v
      `;
      return r.v;
    });
    expect(inside).toBe(actor);

    // After the transaction the setting must be gone, or it would leak to the
    // next borrower of this pooled connection.
    const [outside] = await sql<{ v: string | null }[]>`
      select current_setting('iims.user_id', true) as v
    `;
    expect(outside.v === null || outside.v === "").toBe(true);
  });

  // --- the CRM policies, as the application role actually sees them --------
  //
  // The repository tests connect as `postgres`, which owns these tables and
  // therefore bypasses their policies. These assertions are the only ones that
  // exercise the second line of defence on the CRM schema (PRD 14), so they
  // belong here rather than there.

  it("sees no clients at all without an identified actor", async () => {
    // The policies read nullif(current_setting('iims.user_id', true), '')::uuid
    // and are written to fail closed, so a query that escapes the withActor
    // wrapper returns nothing rather than everything.
    const rows = await sql`select id from crm.clients limit 1`;
    expect(rows.length).toBe(0);

    for (const table of ["engagements", "enquiries", "conflict_checks"] as const) {
      const escaped = await sql`
        select 1 from crm.${sql(table)} limit 1
      `;
      expect(escaped.length).toBe(0);
    }
  });

  it("cannot insert a client without an identified actor", async () => {
    await expect(
      sql`
        insert into crm.clients (organisation_name, classification)
        values ('Policy Probe Ltd', 'CONFIDENTIAL')
      `,
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it("has no DELETE privilege in any content schema", async () => {
    // Removal is a soft delete applied as an UPDATE, so nothing in these
    // schemas is erasable by the application at all (PRD 3.5). There are no
    // DELETE policies either, but the privilege is the stronger statement.
    //
    // `iam` is deliberately absent from this list: removing a role assignment
    // or a permission override genuinely is a deletion, and keeping tombstones
    // of them would make the effective-permission calculation harder to read
    // rather than safer. config.revoke_erasure refuses that schema for the
    // same reason.
    const rows = await sql<{ table_schema: string; table_name: string }[]>`
      select table_schema, table_name
      from information_schema.table_privileges
      where grantee = 'iims_app'
        and table_schema in ('crm', 'casework')
        and privilege_type in ('DELETE', 'TRUNCATE')
      order by table_schema, table_name
    `;
    expect(rows.map((r) => `${r.table_schema}.${r.table_name}`)).toEqual([]);
  });

  it("still holds the DELETE that iam genuinely needs", async () => {
    // The counterpart to the assertion above: this is not a blanket "no
    // deletes anywhere" rule, and asserting the exception keeps a future
    // tightening from quietly breaking role removal.
    const rows = await sql<{ table_name: string }[]>`
      select table_name
      from information_schema.table_privileges
      where grantee = 'iims_app'
        and table_schema = 'iam'
        and table_name = 'user_roles'
        and privilege_type = 'DELETE'
    `;
    expect(rows).toHaveLength(1);
  });

  it("has no SELECT policy on casework.cases that re-reads casework.cases", async () => {
    // Postgres applies the SELECT policy to the rows an INSERT returns, and a
    // STABLE function cannot see a row its own statement is inserting. A
    // SELECT policy that queries the table it protects therefore refuses every
    // `insert ... returning`, reporting it as a WITH CHECK violation, which is
    // not where the fault is. It made opening a case impossible while every
    // direct test of the permissions said it should work (0029).
    //
    // Asserted on the policy text rather than by attempting an insert, because
    // this connection holds no actor and an insert would be refused for the
    // right reason instead.
    const [policy] = await sql<{ qual: string }[]>`
      select qual from pg_policies
      where schemaname = 'casework' and tablename = 'cases' and policyname = 'cases_select'
    `;
    expect(policy.qual).not.toMatch(/can_reach_case/);
    // It reads the row's own columns through the classification-taking form.
    expect(policy.qual).toMatch(/can_reach\(/);
  });

  it("applies the same rule to the cases UPDATE check", async () => {
    // The WITH CHECK sees the row as it WILL be, so going through
    // can_reach_case there read the pre-update classification: raising a case
    // above the editor's own clearance would have passed.
    const [policy] = await sql<{ with_check: string }[]>`
      select with_check from pg_policies
      where schemaname = 'casework' and tablename = 'cases' and policyname = 'cases_update'
    `;
    expect(policy.with_check).not.toMatch(/can_reach_case/);
    expect(policy.with_check).toMatch(/classification/);
  });

  it("cannot alter a recorded conflict match", async () => {
    // There is no UPDATE policy on crm.conflict_matches, so RLS filters every
    // row out and the statement affects nothing. It does NOT raise: the
    // immutability trigger never fires, because there is no row to fire for.
    // That is the right outcome and worth pinning down, because "it threw" and
    // "it changed nothing" are different guarantees and only the second one is
    // true here. The trigger is what stops the table OWNER, and
    // conflict-screening.test.ts asserts that separately.
    const affected = await sql.begin(async (tx) => {
      await tx`select set_config('iims.user_id', ${crypto.randomUUID()}, true)`;
      const result = await tx`update crm.conflict_matches set similarity = 0.1`;
      return result.count;
    });
    expect(affected).toBe(0);
  });
});

/**
 * What the application role can reach in the intelligence register.
 *
 * This block exists because of a defect only this connection could find. The
 * repository tests connect as `postgres`, which Supabase grants BYPASSRLS, so
 * they never evaluate a policy; the entity SELECT policy called a function
 * that looked its own row up in the table, and `INSERT ... RETURNING`
 * evaluates that policy on a row no query can yet see. Every registration of
 * a subject by an Investigator failed, and the error named the INSERT policy
 * rather than the SELECT one.
 *
 * Seeding needs `postgres`, because creating an `auth.users` row is outside
 * what `iims_app` may do and should be. Only the assertions run as the
 * application role.
 */
describe.skipIf(!url || !process.env.SUPABASE_DB_URL)(
  "iims_app in the intelligence register",
  () => {
    const admin = postgres(process.env.SUPABASE_DB_URL ?? "", {
      prepare: false,
      max: 1,
      ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
      onnotice: () => {},
    });

    afterAll(async () => {
      await admin.end({ timeout: 5 });
    });

    /** An investigator: `entities:view` at `assigned` scope, which is the case. */
    async function seedInvestigator(): Promise<string> {
      const [{ id }] = await admin<{ id: string }[]>`
        select extensions.gen_random_uuid() as id
      `;
      await admin`
        insert into auth.users
          (id, instance_id, aud, role, email, encrypted_password,
           created_at, updated_at)
        values (${id}::uuid, '00000000-0000-0000-0000-000000000000',
                'authenticated', 'authenticated',
                ${`pddc-containment-${id}@example.invalid`}, 'fixture',
                now(), now())
      `;
      await admin`
        insert into iam.users (id, clearance, status)
        values (${id}::uuid, 'CONFIDENTIAL', 'active')
      `;
      await admin`
        insert into iam.user_roles (user_id, role_id)
        select ${id}::uuid, r.id from iam.roles r where r.key = 'investigator'
      `;
      return id;
    }

    async function cleanUp(userId: string) {
      await admin`delete from intel.entities where created_by = ${userId}::uuid`;
      await admin`delete from iam.user_roles where user_id = ${userId}::uuid`;
      await admin`delete from iam.users where id = ${userId}::uuid`;
      await admin`delete from auth.users where id = ${userId}::uuid`;
    }

    it("registers a subject and reads it back in the same statement", async () => {
      const userId = await seedInvestigator();
      try {
        const row = await sql.begin(async (tx) => {
          await tx`select set_config('iims.user_id', ${userId}, true)`;
          await tx`select set_config('iims.clearance', 'CONFIDENTIAL', true)`;
          const [created] = await tx<{ entity_id: string }[]>`
            insert into intel.entities
              (entity_type, name, classification, created_by, updated_by)
            values ('company', 'Containment Probe Ltd', 'CONFIDENTIAL',
                    ${userId}::uuid, ${userId}::uuid)
            returning entity_id
          `;
          return created;
        });

        expect(row.entity_id).toMatch(/^ENT-\d{4}-\d{6}$/);
      } finally {
        await cleanUp(userId);
      }
    });

    it("does not show one investigator the subject another recorded", async () => {
      const authorId = await seedInvestigator();
      const strangerId = await seedInvestigator();
      try {
        const entityId = await sql.begin(async (tx) => {
          await tx`select set_config('iims.user_id', ${authorId}, true)`;
          await tx`select set_config('iims.clearance', 'CONFIDENTIAL', true)`;
          const [created] = await tx<{ id: string }[]>`
            insert into intel.entities
              (entity_type, name, classification, created_by, updated_by)
            values ('company', 'Containment Private Ltd', 'CONFIDENTIAL',
                    ${authorId}::uuid, ${authorId}::uuid)
            returning id
          `;
          return created.id;
        });

        // The author rule is a clause about the author, not a hole. The
        // second investigator recorded nothing and is on no case with it, so
        // row-level security filters it out entirely.
        const visible = await sql.begin(async (tx) => {
          await tx`select set_config('iims.user_id', ${strangerId}, true)`;
          await tx`select set_config('iims.clearance', 'CONFIDENTIAL', true)`;
          const rows = await tx`
            select id from intel.entities where id = ${entityId}::uuid
          `;
          return rows.length;
        });

        expect(visible).toBe(0);
      } finally {
        await cleanUp(authorId);
        await cleanUp(strangerId);
      }
    });

    it("refuses a subject above the investigator's ceiling", async () => {
      const userId = await seedInvestigator();
      try {
        // Their ceiling on `entities:create` is CONFIDENTIAL, so this is the
        // INSERT policy refusing, which is the error the SELECT policy's
        // failure was masquerading as.
        await expect(
          sql.begin(async (tx) => {
            await tx`select set_config('iims.user_id', ${userId}, true)`;
            await tx`select set_config('iims.clearance', 'CONFIDENTIAL', true)`;
            await tx`
              insert into intel.entities
                (entity_type, name, classification, created_by, updated_by)
              values ('company', 'Containment Too Secret Ltd',
                      'STRICTLY_RESTRICTED', ${userId}::uuid, ${userId}::uuid)
            `;
          }),
        ).rejects.toThrow(/violates row-level security policy/);
      } finally {
        await cleanUp(userId);
      }
    });
  },
);

import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Test fixtures for the IIMS.
 *
 * Fixtures are created inside a transaction that is ALWAYS rolled back. That
 * matters more than usual here: this database also serves the live
 * primaddc.com website, and iam.users references auth.users, so creating a
 * test user means touching the real identity table. Rolling back leaves zero
 * residue (verified: no rows survive, and the project's monthly-active-user
 * count is untouched).
 *
 * Fixture setup runs as `postgres` because it must insert into auth.users and
 * bypass the RLS that the application is subject to. Assertions about what the
 * APPLICATION can see belong in app-role-containment.test.ts, which connects
 * as iims_app instead.
 */

const CA = readFileSync(path.resolve("certs/supabase-prod-ca.crt"));

export function adminClient() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for integration tests.");
  }
  return new pg.Client({
    connectionString,
    ssl: { ca: CA, rejectUnauthorized: true },
    application_name: "pddc-iims-test-fixtures",
  });
}

export interface MakeUserOptions {
  clearance?: string;
  status?: "invited" | "active" | "suspended" | "deactivated" | "archived";
  /** Role keys from the seeded catalogue, e.g. ["investigator"]. */
  roles?: string[];
  /** Per-role validity, for testing temporary cover. */
  validFrom?: string;
  validTo?: string;
  lockedUntil?: string;
  officeId?: string | null;
  departmentCode?: string | null;
}

/**
 * Creates an auth.users row, the matching iam.users row and any role
 * assignments, and returns the user id.
 */
export async function makeUser(
  db: pg.Client,
  opts: MakeUserOptions = {},
): Promise<string> {
  const {
    clearance = "CONFIDENTIAL",
    status = "active",
    roles = [],
    validFrom,
    validTo,
    lockedUntil,
  } = opts;

  const { rows } = await db.query<{ id: string }>(
    "select extensions.gen_random_uuid() as id",
  );
  const id = rows[0].id;

  // The shared identity. Columns kept to the minimum auth.users requires.
  await db.query(
    `insert into auth.users
       (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
             'authenticated', $2, 'fixture-not-a-real-password', now(), now())`,
    [id, `pddc-fixture-${id}@example.invalid`],
  );

  // The website's trigger on auth.users also creates a public.profiles row,
  // which is exactly the shared-directory behaviour we rely on in production.

  await db.query(
    `insert into iam.users (id, clearance, status, locked_until, employee_id)
     values ($1, $2, $3, $4, $5)`,
    [id, clearance, status, lockedUntil ?? null, `FIX-${id.slice(0, 8)}`],
  );

  for (const key of roles) {
    await db.query(
      `insert into iam.user_roles (user_id, role_id, valid_from, valid_to)
       select $1, r.id, coalesce($3::timestamptz, now()), $4::timestamptz
       from iam.roles r where r.key = $2`,
      [id, key, validFrom ?? null, validTo ?? null],
    );
  }

  return id;
}

/** Grants or denies a single permission atom for one user. */
export async function setOverride(
  db: pg.Client,
  userId: string,
  resource: string,
  action: string,
  effect: "allow" | "deny",
  opts: { scope?: string; ceiling?: string; expiresAt?: string } = {},
): Promise<void> {
  const { scope = "assigned", ceiling = "CONFIDENTIAL", expiresAt } = opts;

  await db.query(
    `insert into iam.permissions (resource, action, scope, classification_ceiling)
     values ($1, $2, $3, $4)
     on conflict (resource, action, scope, classification_ceiling) do nothing`,
    [resource, action, scope, ceiling],
  );

  await db.query(
    `insert into iam.user_permission_overrides
       (user_id, permission_id, effect, reason, expires_at)
     select $1, p.id, $4, 'integration test', $5::timestamptz
     from iam.permissions p
     where p.resource = $2 and p.action = $3
       and p.scope = $6 and p.classification_ceiling = $7`,
    [userId, resource, action, effect, expiresAt ?? null, scope, ceiling],
  );
}

/** Convenience: ask the database a yes/no authorization question. */
export async function can(
  db: pg.Client,
  userId: string,
  resource: string,
  action: string,
  classification?: string,
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    "select iam.has_permission($1, $2, $3, $4) as ok",
    [resource, action, classification ?? null, userId],
  );
  return rows[0].ok;
}

/**
 * Runs a callback with iims.user_id set, as the application would.
 *
 * Wrapped in a savepoint, which is not decoration. A statement that a policy
 * or a trigger rejects aborts the whole transaction, so the cleanup below
 * would fail too and the caller would see "current transaction is aborted"
 * instead of the rejection it was asserting. Rolling back to the savepoint
 * makes the transaction usable again and lets the real error through, which is
 * what a test like "refuses to screen without the permission" needs.
 */
export async function asActor<T>(
  db: pg.Client,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await db.query("savepoint as_actor");
  await db.query("select set_config('iims.user_id', $1, true)", [userId]);
  try {
    const result = await fn();
    await db.query("release savepoint as_actor");
    return result;
  } catch (error) {
    await db.query("rollback to savepoint as_actor");
    throw error;
  } finally {
    await db.query("select set_config('iims.user_id', '', true)");
  }
}

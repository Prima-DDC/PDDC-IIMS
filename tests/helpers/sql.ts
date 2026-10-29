import { readFileSync } from "node:fs";
import postgres from "postgres";
import { DB_TYPES } from "@/lib/db/client";

/**
 * The postgres.js client the repository integration tests run on.
 *
 * One place rather than one per test file, and crucially it uses the
 * application's own `DB_TYPES`. Without that the tests receive `Date` objects
 * where the application receives strings, so a test can pass while the screen
 * it covers throws a TypeError. That is exactly how the date handling came to
 * be wrong, and this is what stops it recurring.
 *
 * Connects as `postgres`, which is what fixture setup needs: inserting into
 * `auth.users` and seeding across schemas. Assertions about what the
 * APPLICATION role can reach belong in app-role-containment.test.ts, which
 * connects as `iims_app`.
 */
export function testSql(
  connectionString: string = process.env.SUPABASE_DB_URL ?? "",
  applicationName = "pddc-iims-test",
) {
  return postgres(connectionString, {
    // Mandatory on the transaction-mode pooler, and harmless on the other.
    prepare: false,
    max: 1,
    ssl: {
      ca: readFileSync("certs/supabase-prod-ca.crt"),
      rejectUnauthorized: true,
    },
    connection: { application_name: applicationName },
    onnotice: () => {},
    types: DB_TYPES,
  });
}

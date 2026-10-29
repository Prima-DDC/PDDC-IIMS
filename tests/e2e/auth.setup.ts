import { mkdirSync } from "node:fs";
import path from "node:path";
import { test as setup } from "@playwright/test";
import { credentials, signIn, type FixtureKey } from "./helpers";

/**
 * Signs in once per fixture and saves the browser state to disk.
 *
 * Every later test starts from a stored session instead of signing in again.
 * That matters here more than usual: two-factor authentication is mandatory,
 * so each sign-in costs a real TOTP round trip, and the alternative (one
 * shared page across a whole spec file) turned out to be fragile. A test that
 * closed or navigated the shared page broke every test after it, which is
 * exactly what happened before this existed.
 */

export const AUTH_DIR = path.join("playwright", ".auth");

export function statePath(key: FixtureKey): string {
  return path.join(AUTH_DIR, `${key.toLowerCase()}.json`);
}

for (const key of ["ADMIN", "INVESTIGATOR", "MANAGER"] as const) {
  setup(`authenticate as ${key.toLowerCase()}`, async ({ page }) => {
    mkdirSync(AUTH_DIR, { recursive: true });
    await signIn(page, credentials(key));
    await page.context().storageState({ path: statePath(key) });
  });
}

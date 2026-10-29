import { mkdirSync } from "node:fs";
import { test as setup } from "@playwright/test";
import {
  AUTH_DIR,
  SECOND_ADMIN_STATE,
  credentials,
  signIn,
  statePath,
} from "./helpers";

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

for (const key of ["ADMIN", "INVESTIGATOR", "MANAGER"] as const) {
  setup(`authenticate as ${key.toLowerCase()}`, async ({ page }) => {
    mkdirSync(AUTH_DIR, { recursive: true });
    await signIn(page, credentials(key));
    await page.context().storageState({ path: statePath(key) });
  });
}

/**
 * A SECOND administrator session, in its own file.
 *
 * Not a duplicate for convenience: two browser contexts must never be seeded
 * from one saved session. Supabase rotates refresh tokens, so the first
 * context to refresh consumes the token in the file and every later context
 * loading that file presents a spent one and is rejected outright. The
 * platform then does the correct thing with an invalid cookie, which is to
 * clear it and ask for a password, and the test lands on the sign-in page.
 *
 * It is intermittent, because it only bites when a context actually refreshes
 * inside the reuse interval, and it is invisible to investigation: trying the
 * same saved session by hand afterwards works, because one context is all it
 * takes to work. It cost several runs here, attributed first to a redirect
 * loop and then to rate limiting.
 *
 * A case journey needs two administrators at once more often than it looks:
 * `openApprovedCase` opens one to approve the engagement, since an engagement
 * cannot be approved by whoever requested it, and the journey itself then
 * wants one for review, QA or a merge. So the fixture keeps `admin.json` and
 * anything else takes this one.
 *
 * Supabase allows concurrent sessions per user and each gets its own row in
 * `auth.sessions`, which is what `iam.resolve_actor` checks, so the two are
 * genuinely independent.
 */
setup("authenticate as a second administrator", async ({ page }) => {
  mkdirSync(AUTH_DIR, { recursive: true });
  await signIn(page, credentials("ADMIN"));
  await page.context().storageState({ path: SECOND_ADMIN_STATE });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Dialog, type Locator, type Page } from "@playwright/test";
import { generateTotp } from "./totp";

/**
 * Shared end-to-end helpers.
 *
 * Two-factor authentication is mandatory, so every sign-in here completes it
 * for real. Most fixtures have a verified authenticator seeded with a known
 * secret, which the seed script writes to .env.e2e: that keeps codes
 * reproducible across runs and across Playwright worker restarts. One fixture
 * has no factor at all, so the enrolment flow is still exercised.
 *
 * Sign in sparingly. Supabase rate-limits the MFA challenge and verify
 * endpoints at 15 requests a minute per IP and that limit is NOT configurable,
 * so a suite that signs in on every test trips it and the failures look like
 * hangs. The setup project signs in once per fixture and saves the session;
 * everything else starts from that.
 */

export type FixtureKey =
  "ADMIN" | "INVESTIGATOR" | "MANAGER" | "SUSPENDED" | "NOACCESS" | "ENROL";

export const AUTH_DIR = path.join("playwright", ".auth");

export function statePath(key: FixtureKey): string {
  return path.join(AUTH_DIR, `${key.toLowerCase()}.json`);
}

/**
 * The administrator's second session. See the note below on why it exists.
 *
 * `admin.json` belongs to `openApprovedCase`, which needs an administrator to
 * approve the engagement. A journey that also needs an administrator uses
 * this one, so the two never share a refresh token.
 */
export const SECOND_ADMIN_STATE = path.join(AUTH_DIR, "admin-second.json");

export interface Credentials {
  key: FixtureKey;
  email: string;
  password: string;
  /** Present when the account has a seeded authenticator. */
  totpSecret?: string;
}

let cached: Record<string, string> | null = null;

function e2eEnv(): Record<string, string> {
  if (cached) return cached;

  let raw: string;
  try {
    raw = readFileSync(".env.e2e", "utf8");
  } catch {
    throw new Error(
      "Missing .env.e2e. Create the test accounts first:\n" +
        "  E2E_ALLOW_SEED=1 npm run seed:e2e",
    );
  }

  cached = Object.fromEntries(
    raw
      .split(/\r?\n/)
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
  return cached;
}

export function credentials(key: FixtureKey): Credentials {
  const env = e2eEnv();
  const email = env[`E2E_${key}_EMAIL`];
  const password = env[`E2E_${key}_PASSWORD`];
  if (!email || !password) {
    throw new Error(`No credentials for ${key} in .env.e2e. Re-run the seed.`);
  }
  return { key, email, password, totpSecret: env[`E2E_${key}_TOTP`] };
}

/**
 * Waits for the page to be ready to act on: the preloader gone, and every
 * streamed panel arrived.
 *
 * The preloader is a full-screen overlay for about two seconds on the first
 * page of a session, so a click issued before it goes lands on the overlay
 * instead of the control. Playwright retries such a click, but the retry loop
 * reported the overlay as an unstable element rather than as an obstruction,
 * which turned a two-second wait into a ninety-second timeout.
 *
 * The skeletons matter for a subtler reason, and it cost two full runs of the
 * intel journey. Every panel on the case page has its own Suspense boundary
 * so one slow query cannot block the rest of the page (PRD 11), which means a
 * panel genuinely does not exist in the DOM for the first moment after a
 * navigation. A test that looks for a control in that window does not see a
 * control that is loading, it sees no control, and "no control" is exactly
 * what the platform renders when you are not allowed to do something. The
 * two states are indistinguishable, so `openForm` quietly did nothing and the
 * failure surfaced fifty seconds later in a different step, pointing at a
 * form field that was never going to appear.
 *
 * Waiting for `[data-loading]` to clear makes "it has not arrived yet" a
 * state the harness can see, and so the only honest reading of a missing
 * control is that it is not offered.
 */
export async function settled(page: Page): Promise<void> {
  await page
    .locator("[data-preloader]")
    .waitFor({ state: "detached", timeout: 15_000 })
    .catch(() => {
      // Already gone, which is the common case on a second navigation.
    });

  await expect(page.locator("[data-loading]")).toHaveCount(0, {
    timeout: 30_000,
  });
}

/** Fills and submits the sign-in form. Does not handle the second factor. */
export async function submitSignIn(
  page: Page,
  creds: { email: string; password: string },
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: /sign in/i }).click();
}

/**
 * Signs in all the way to the dashboard, completing the second factor.
 *
 * Answers the challenge when a factor is seeded, and enrols one when it is
 * not. Both paths end on the dashboard.
 */
export async function signIn(page: Page, creds: Credentials): Promise<void> {
  await submitSignIn(page, creds);

  await page.waitForURL(/\/login\/mfa|\/dashboard/, { timeout: 60_000 });
  if (page.url().includes("/dashboard")) return;

  // Which screen appears depends on whether a factor exists, and a previous
  // run may have enrolled one, so detect rather than assume.
  const enrolButton = page.getByRole("button", {
    name: /start two-factor setup/i,
  });
  const needsEnrolment = await enrolButton.isVisible().catch(() => false);

  if (needsEnrolment) {
    await enrolButton.click();

    // Read the secret the way a person who cannot scan the QR code would.
    await page.getByText(/cannot scan/i).click();
    const secret = (await page.locator("details p").innerText()).trim();
    expect(secret.length).toBeGreaterThan(10);

    await page.getByLabel("Authentication code").fill(generateTotp(secret));
    await page.getByRole("button", { name: /confirm and continue/i }).click();
  } else {
    if (!creds.totpSecret) {
      throw new Error(
        `${creds.email} has an authenticator from an earlier run whose secret ` +
          "is not known here. Reset the fixtures with: " +
          "E2E_ALLOW_SEED=1 npm run seed:e2e",
      );
    }
    await page
      .getByLabel("Authentication code")
      .fill(generateTotp(creds.totpSecret));
    await page.getByRole("button", { name: /verify and continue/i }).click();
  }

  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
}

/* ---------------------------------------------------- locating the screen */

/**
 * One of the cards on a page, located by its own heading.
 *
 * Every detail screen in the platform is built from these, so a test that
 * scopes its assertions to one card cannot be satisfied by text from another.
 */
export const panel = (page: Page, title: string) =>
  page.locator("section").filter({
    has: page.getByRole("heading", { name: title, exact: true, level: 2 }),
  });

/**
 * Opens an "add" form inside a panel, if it is not already open.
 *
 * These forms stay open after a successful submit, deliberately: the success
 * banner lives inside the form, so closing it would destroy the confirmation,
 * and keeping it open is what you want when recording five checks in a row.
 * The consequence for a test is that the button that opens it is not there the
 * second time round.
 *
 * The retry is not defensive padding, it is the fix for a real race that cost
 * an afternoon. The panel is server-rendered, so the button is present and
 * clickable before React has hydrated, and Playwright's actionability checks
 * are all satisfied by then: visible, stable, enabled, hit-target clear. A
 * click that lands in that window hits plain HTML with no listener attached
 * and is silently discarded. The test then fails fifty seconds later on a
 * form field that was never going to appear, pointing at the wrong thing.
 *
 * So the open state is asserted rather than assumed. The signal both panel
 * shapes share is that the control matching `name` stops matching: the
 * shared `Expandable` relabels its button to "Cancel", and the hand-rolled
 * panels replace the button with the form outright. Neither can happen
 * without the form being open, and neither happens before hydration.
 */
/**
 * Clicks a submit control and waits for its action to have reported back.
 *
 * Navigating straight after a submit is a race. The action is still in
 * flight, a `goto` renders the page again immediately, and because the
 * transaction has not committed the fresh HTML describes the state BEFORE
 * the write. Nothing re-renders after the commit, so the stale page stands
 * for the whole assertion window: the write has genuinely happened, the
 * database is right, and the failure describes a page that cannot be
 * reproduced a minute later.
 *
 * Two plausible waits were tried here and both were wrong, in the same way.
 * Waiting for the submit button to come back enabled runs before React has
 * marked the form pending, so it sees an enabled button on a settled page
 * and returns before the action has started: a wait that waits for nothing.
 * Waiting for the control to disappear is worse, because `router.refresh()`
 * shows a panel's skeleton on the way and a blank satisfies it.
 *
 * Both are absences. `ActionForm` publishes `data-action-outcome` once it has
 * a result, success or failure, which is a presence only a completed action
 * can produce. The rule this file keeps relearning: wait for the state the
 * action produces, never for the absence of the state it replaces.
 *
 * It deliberately does NOT assert success. A refusal is a finished action
 * too, and several steps exist to prove the server refuses something; the
 * caller asserts which outcome it wanted.
 */
export async function submitAndSettle(button: Locator): Promise<void> {
  const form = button.locator("xpath=ancestor::form[1]");
  const page = button.page();

  /*
   * Accept the confirmation, if the form asks for one.
   *
   * Several of these actions are destructive or hard to undo, so `ActionForm`
   * puts a `confirm` in front of them: returning a report to its author,
   * approving a closure, removing a section. Playwright DISMISSES a dialog
   * nobody handles, which cancels the submit silently, so the form sits there
   * having done nothing and the wait below times out against a page that
   * looks perfectly healthy.
   *
   * Accepting is the right default because clicking submit is the intent;
   * a step that wants to assert what the dialog SAYS can register its own
   * handler, which runs first and consumes the event. The listener is removed
   * afterwards either way, so it can never swallow a later dialog.
   */
  const accept = (dialog: Dialog) => {
    void dialog.accept();
  };
  page.on("dialog", accept);

  try {
    await button.click();
    await expect(form.locator("[data-action-outcome]")).toHaveCount(1, {
      timeout: 60_000,
    });
  } finally {
    page.off("dialog", accept);
  }
}

export async function openForm(scope: Locator, name: RegExp) {
  const button = scope.getByRole("button", { name });
  if ((await button.count()) === 0) return;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await button.click();
    try {
      await expect(button).toHaveCount(0, { timeout: 2_000 });
      return;
    } catch {
      // Not hydrated yet, so the click did nothing. The button is still the
      // one that opens the form, so click it again rather than giving up.
    }
  }

  // Deliberately loud: a swallowed click used to surface as a missing field
  // in whatever step came next, which is the hardest kind of failure to read.
  throw new Error(
    `the "${name}" control never reported itself open, so the form it opens cannot be filled`,
  );
}

/**
 * The exact-label matcher, tolerating the asterisk a required field carries.
 *
 * The optional asterisk is written as the character class `[*]` rather than
 * as `\*` on purpose: a backslash in a template literal is one edit away from
 * being eaten, and when it is the regex still compiles. It then quietly means
 * "name" followed by any number of "e"s, matches nothing, and the test waits
 * for the full timeout before telling anybody.
 */
export function labelled(label: string): RegExp {
  return new RegExp(
    "^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[*]?$",
  );
}

/** Fills a field by its label. */
export async function fill(page: Page, label: string, value: string) {
  await page.getByLabel(labelled(label)).fill(value);
}

/**
 * Picks the one option whose text contains `text`.
 *
 * The fixture names carry a timestamp, so the full label is not known up
 * front, and selectOption only matches a label exactly.
 */
export async function selectContaining(select: Locator, text: string) {
  const value = await select
    .locator("option", { hasText: text })
    .first()
    .getAttribute("value");
  if (!value) throw new Error(`no option containing "${text}"`);
  await select.selectOption(value);
}

/**
 * A tab of the case file (PRD 18, screen 9).
 *
 * The case page renders one tab at a time and reads only that tab's data, so
 * a test looking for the safety panel has to ask for the safety tab. The tab
 * is in the URL rather than in state, which is what makes this possible.
 */
export function caseTab(caseUrl: string, tab: string): string {
  return tab === "summary" ? caseUrl : `${caseUrl}?tab=${tab}`;
}

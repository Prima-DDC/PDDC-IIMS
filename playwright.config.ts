import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * Runs against a real `next start` on the real Supabase project, because the
 * things worth testing here are precisely the ones a mock would hide:
 * mandatory MFA, account lockout, suspension taking effect immediately, and
 * the shared-identity rule that a staff account alone grants no access.
 *
 * Serial, with one worker. The lockout test deliberately locks an account and
 * the administration tests mutate shared fixtures, so parallel workers would
 * be flaky for no benefit.
 *
 * The `setup` project signs in once per fixture and saves the session, so the
 * other projects start authenticated rather than paying an MFA round trip per
 * test.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // Puts the enrolment fixture's authenticator back to absent, so the suite is
  // runnable more than once per re-seed. See the file for why.
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  // One retry, locally as well as in CI. Not to paper over a failing
  // assertion: a retried test is reported as flaky, so it stays visible. It
  // is because the hosted Supabase auth endpoint stalls intermittently from
  // here. Measured, three consecutive calls to the same password grant:
  // 0.3s, 3.7s, 37s. A 37 second stall outruns both the 60s sign-in wait and
  // the 30 second life of a one-time code, so a correct suite fails on
  // somebody else's latency.
  retries: 1,
  timeout: 180_000,
  // Deliberately generous. Every assertion here follows a real mutation
  // against the hosted Supabase project, and the round trip from this machine
  // to its region measures ~120ms: a page render costs ~18 of them and a
  // mutation plus its revalidation costs ~27, so a confirmation banner can
  // legitimately take 6 to 8 seconds to appear. A 10s ceiling failed three
  // tests whose behaviour was correct, and 25s failed one more once the case
  // page grew its work, safety and finance sections: a server action's
  // transition does not end until Next has refreshed the route, so the
  // confirmation waits for the whole page to re-render behind it. This is
  // latency to a remote region, not
  // slow code: with the application deployed in the database's region the same
  // work is a few milliseconds per round trip. Set IIMS_DB_DEBUG=1 to see the
  // statements behind a slow page.
  //
  // Raised again in M5, from 45s, for the same reason and with the same
  // cause. A server action's pending state does not end until Next has
  // re-rendered the route behind it, and the case file now carries ten tabs:
  // its bar of counts alone is nine aggregate reads, and the subjects tab
  // adds the register, the summary and a two-hop relationship walk. Measured
  // from a failing run, the registration of a subject was still pending at
  // 45s with the button reading "Saving". Nothing was wrong with the action;
  // the page behind it had grown.
  //
  // This is a ceiling for a test, not a target for the product. The
  // measurements and the two optimisations that were tried are in
  // docs/PROGRESS.md, and the fix is deploying in the database's region.
  expect: { timeout: 90_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    // Playwright's default action timeout is 0, meaning an action on an
    // element that never appears waits for the whole test timeout and reports
    // the test as "timed out" with no indication of which step was stuck. That
    // cost two 26 minute runs to diagnose: a `selectOption` on a panel that
    // had moved to another tab simply hung. A ceiling here turns a missing
    // element back into a named failure.
    //
    // Deliberately well below `expect.timeout`, and not in tension with it:
    // this governs how long an element has to become clickable, where that
    // one governs how long a mutation has to land. A control that is not
    // there within fifty seconds is not coming.
    actionTimeout: 50_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    // Signs in and saves the session for the projects below.
    { name: "setup", testMatch: /auth\.setup\.ts/ },

    // Authentication is tested from a clean slate, so it must NOT start from a
    // stored session, and it must not depend on the setup project either.
    {
      name: "auth",
      testMatch: /auth\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },

    {
      name: "admin",
      testMatch: /admin\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/admin.json",
      },
    },

    // Clients, intake and engagements run as the operations manager, which is
    // the role PRD 16 gives those rights to, with the administrator session
    // loaded separately for the one step that needs a second person: the
    // engagement approval gate refuses self-approval.
    {
      name: "crm",
      testMatch: /crm\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/manager.json",
      },
    },

    // Casework runs as the operations manager too, with the administrator
    // loaded for the steps that need a second person: approving a risk
    // assessment and deciding a scope change both refuse the author.
    {
      name: "cases",
      testMatch: /cases\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/manager.json",
      },
    },

    // Tasks, the activity log and the investigation plan. The operations
    // manager again, with the administrator loaded for the one step that needs
    // a second person: a plan cannot be approved by whoever submitted it.
    {
      name: "tasks",
      testMatch: /tasks\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/manager.json",
      },
    },

    // Safety and the case commercials. The operations manager again, with the
    // administrator for the steps that need a second person: an incident
    // cannot be closed by whoever reported it, nor time approved by whoever
    // logged it.
    {
      name: "safety",
      testMatch: /safety-finance\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/manager.json",
      },
    },

    // Evidence, chain of custody and case documents. Three people: the
    // operations manager opens the case and assigns it, the investigator
    // collects and files, and the administrator verifies the stored file and
    // approves the document the investigator filed.
    {
      name: "evidence",
      testMatch: /evidence\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/manager.json",
      },
    },

    // Subjects, sources, information and findings. The operations manager
    // runs the case and reviews, with the investigator loaded as the person
    // who records: PRD 16 gives the manager no create permission on any of
    // it, and gives the investigator neither the merge nor the approve.
    {
      name: "intel",
      testMatch: /intel\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/manager.json",
      },
    },

    // Reporting, QA, delivery, closure and the archive. Three people: the
    // operations manager opens and later closes the case, the investigator
    // writes the report, and the administrator reviews, runs QA, approves and
    // delivers. The manager holds only `reports:view`, so they are the right
    // default session for asserting what reporting does NOT offer them.
    {
      name: "reporting",
      testMatch: /reporting\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/manager.json",
      },
    },

    // Accessibility, as the administrator because that session reaches every
    // screen in the list: a check that skipped a page for want of permission
    // would report a floor it had not actually tested.
    {
      name: "a11y",
      testMatch: /accessibility\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/admin.json",
      },
    },

    // The bottom navigation bar only exists below the md breakpoint, so it
    // needs a real phone viewport to test at all.
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Pixel 7"],
        storageState: "playwright/.auth/admin.json",
      },
    },
  ],

  webServer: {
    command: `node --env-file-if-exists=.env.local ./node_modules/next/dist/bin/next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

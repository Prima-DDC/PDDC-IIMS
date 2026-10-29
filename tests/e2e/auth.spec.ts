import { expect, test } from "@playwright/test";
import { credentials, signIn, submitSignIn } from "./helpers";

/**
 * Authentication, in a real browser against the real project.
 *
 * These are the security properties the PRD is most specific about, and the
 * ones a mocked test would quietly fail to prove.
 */

test.describe("access control", () => {
  test("an unauthenticated visitor is sent to the sign-in form", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });

  test("the intended destination survives the sign-in redirect", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fusers/);
  });

  test("the root path requires authentication", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("the sign-in page is not indexable", async ({ page }) => {
    const response = await page.goto("/login");
    expect(response?.status()).toBe(200);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/,
    );
  });
});

test.describe("sign-in", () => {
  test("a wrong password gives the same message as an unknown account", async ({ page }) => {
    const admin = credentials("ADMIN");

    // Scoped to the form: Next injects its own route announcer with
    // role="alert", which .first() would match instead.
    const formAlert = page.locator('form [role="alert"]');

    await submitSignIn(page, { email: admin.email, password: "definitely-wrong" });
    const wrongPassword = await formAlert.first().innerText();

    await submitSignIn(page, {
      email: "pddc-e2e-does-not-exist@example.invalid",
      password: "definitely-wrong",
    });
    const unknownAccount = await formAlert.first().innerText();

    // Identical wording, so the form cannot be used to enumerate accounts.
    expect(wrongPassword).toBe(unknownAccount);
    expect(wrongPassword).toMatch(/do not match/i);
  });

  test("an empty form reports both fields without contacting the server", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByText(/enter your work email address/i)).toBeVisible();
    await expect(page.getByText(/enter your password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("two-factor authentication is mandatory, not optional", async ({ page }) => {
    const investigator = credentials("INVESTIGATOR");
    await submitSignIn(page, investigator);

    // A correct password alone must never reach the dashboard. The generous
    // timeout is for the sign-in itself: two Supabase round trips plus the
    // lockout and MFA checks, which the default 10s can exceed.
    await expect(page).toHaveURL(/\/login\/mfa/, { timeout: 45_000 });
    await expect(
      page.getByRole("heading", { name: /two-factor|authentication code/i }),
    ).toBeVisible();
  });

  test("a full sign-in with enrolment reaches the dashboard", async ({ page }) => {
    // This fixture has no authenticator, so the enrolment flow runs for real.
    await signIn(page, credentials("ENROL"));

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { name: /good to see you/i })).toBeVisible();
    // The session is now two-factor verified, and the dashboard says so.
    await expect(page.getByText(/two-factor verified/i)).toBeVisible();
  });

  test("signing out returns to the sign-in form and protects the dashboard", async ({
    page,
  }) => {
    await signIn(page, credentials("INVESTIGATOR"));

    await page.getByRole("button", { name: /e2e investigator|investigator/i }).click();
    await page.getByRole("menuitem", { name: /^sign out$/i }).click();

    await expect(page).toHaveURL(/\/login/);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("account state", () => {
  test("a PDDC account without IIMS access is refused with an explanation", async ({
    page,
  }) => {
    // The shared-identity rule: a staff account alone grants nothing.
    await submitSignIn(page, credentials("NOACCESS"));

    await page.waitForURL(/\/no-access|\/login\/mfa/, { timeout: 30_000 });

    // No IIMS record means no MFA requirement to satisfy either, so this
    // lands directly on the explanation.
    if (page.url().includes("/login/mfa")) {
      await page.goto("/dashboard");
    }

    await expect(page).toHaveURL(/\/no-access/);
    await expect(
      page.getByRole("heading", { name: /no access to the investigation platform/i }),
    ).toBeVisible();
    await expect(page.getByText(/ask an administrator to provision/i)).toBeVisible();
  });

  test("a suspended account cannot reach the platform", async ({ page }) => {
    await submitSignIn(page, credentials("SUSPENDED"));
    await page.waitForURL(/\/no-access|\/login\/mfa|\/dashboard/, { timeout: 30_000 });

    if (!page.url().includes("/no-access")) {
      await page.goto("/dashboard");
    }

    await expect(page).toHaveURL(/\/no-access/);
    await expect(page.getByRole("heading", { name: /suspended/i })).toBeVisible();
  });

  test("five failed attempts lock the account, and the lock is explained", async ({
    page,
  }) => {
    // Lockout is ours: Supabase rate-limits per IP, not per account (PRD 14).
    const target = credentials("SUSPENDED");

    const formAlert = page.locator('form [role="alert"]');

    let message = "";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await submitSignIn(page, { email: target.email, password: "wrong-on-purpose" });
      message = await formAlert.first().innerText();
      if (/locked/i.test(message)) break;
    }

    expect(message).toMatch(/locked/i);
    expect(message).toMatch(/minute/i);

    // And the correct password does not clear a live lockout.
    await submitSignIn(page, target);
    await expect(formAlert.first()).toContainText(/locked/i);
  });
});

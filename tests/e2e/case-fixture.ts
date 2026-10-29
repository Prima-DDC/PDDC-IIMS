import { expect, test, type Browser, type Page } from "@playwright/test";
import { fill, panel, selectContaining, settled } from "./helpers";

/**
 * Builds a case through the real screens, and hands back its URL.
 *
 * A case has prerequisites the product enforces: a client, an engagement that
 * has been conflict-screened and approved by somebody other than its author,
 * and only then a case. Two specs need all of that before they can test
 * anything of their own, so it lives here once rather than being copied.
 *
 * Nothing here is seeded directly into the database on purpose. The chain is
 * the part most likely to break, and a fixture that bypassed it would hide
 * exactly the breakage worth knowing about.
 *
 * Runs as whoever `page` is signed in as, except the approval, which uses the
 * stored administrator session: PRD 5.3 refuses self-approval, so the person
 * who raised the engagement cannot be the one who approves it.
 */
export async function openApprovedCase({
  page,
  browser,
  stamp,
  title,
  clientName,
  caseType = "fraud_investigation",
  priority = "high",
}: {
  page: Page;
  browser: Browser;
  /** A short unique run marker, so repeated runs do not collide. */
  stamp: string;
  title: string;
  clientName: string;
  caseType?: string;
  priority?: string;
}): Promise<string> {
  await test.step("a client with an approved engagement, which a case needs", async () => {
    // The case form offers only approved and active engagements, so the
    // prerequisites are built through the real screens rather than seeded.
    await page.goto("/clients/new");
    await settled(page);
    await fill(page, "Organisation name", clientName);
    await page.getByLabel(/^Risk rating\*?$/).selectOption("medium");
    await page.getByLabel(/^Status\*?$/).selectOption("active");
    await page.getByRole("button", { name: /create client/i }).click();
    await expect(page.getByText(/created as CLI-\d{4}-\d{6}/i)).toBeVisible();

    await page.goto("/engagements/new");
    await settled(page);
    await selectContaining(page.getByLabel(/^Client\*?$/), stamp);
    await fill(page, "Title", `E2E casework engagement ${stamp}`);
    await page.getByLabel(/^Type of work\*?$/).selectOption("fraud_investigation");
    await page
      .getByLabel(/^Scope of services$/)
      .fill("Investigate the procurement irregularities reported by the client.");
    await page.getByRole("button", { name: /create engagement/i }).click();
    await expect(page.getByText(/ENG-\d{4}-\d{6} created as a draft/i)).toBeVisible();
  });

  await test.step("a draft engagement cannot carry a case", async () => {
    await page.goto("/cases/new");
    await settled(page);

    // The form lists only engagements a case can be opened against, so the
    // one just created as a draft is not on offer. That is the gate working
    // before anybody can trip it.
    const engagement = page.locator("select#engagement");
    const options = await engagement.locator("option").allInnerTexts();
    expect(options.filter((o) => o.includes(stamp))).toHaveLength(0);
  });

  await test.step("screen, approve the engagement, and the case becomes possible", async () => {
    await page.goto(`/engagements?search=${encodeURIComponent(stamp)}`);
    await page
      .getByRole("link", { name: new RegExp(`E2E casework engagement ${stamp}`) })
      .click();
    await page.waitForURL(/\/engagements\/[0-9a-f-]{36}/);
    const engagementUrl = page.url();

    // A conflict check has to be decided before approval, which is the gate
    // crm.spec.ts covers in detail; here it is a prerequisite.
    await panel(page, "Conflict screening")
      .getByRole("link", { name: /run a check/i })
      .click();
    await page.waitForURL(/\/intake\/conflicts\/new/);
    await page.getByRole("button", { name: /run the check/i }).click();
    await page.waitForURL(/\/intake\/conflicts\/[0-9a-f-]{36}/, { timeout: 60_000 });

    const decide = panel(page, "Record the decision");
    await decide.locator("select#decision").selectOption("cleared");
    await decide
      .locator("#decision-reason")
      .fill("No conflicting instruction on file for this party or its directors.");
    page.once("dialog", (dialog) => dialog.accept());
    await decide.getByRole("button", { name: /record this decision/i }).click();
    await expect(panel(page, "Record the decision")).toHaveCount(0);

    await page.goto(engagementUrl);
    const status = panel(page, "Engagement status");
    await status.locator("select#engagement-status").selectOption("pending_approval");
    await status.locator("#engagement-status-reason").fill("Ready for approval");
    await status.getByRole("button", { name: /apply status change/i }).click();
    await expect(status.getByText(/is now pending approval/i)).toBeVisible();

    // Approved by the administrator, because the manager raised it.
    const context = await browser.newContext({
      storageState: "playwright/.auth/admin.json",
    });
    try {
      const approver = await context.newPage();
      await approver.goto(engagementUrl);
      await settled(approver);
      const approverStatus = panel(approver, "Engagement status");
      await approverStatus.locator("#approval-reason").fill("Scope and terms agreed");
      approver.once("dialog", (dialog) => dialog.accept());
      await approverStatus
        .getByRole("button", { name: /approve this engagement/i })
        .click();
      await expect(
        approver.getByText(/Cases can now be opened against this engagement/i),
      ).toBeVisible();
      await approver.close();
    } finally {
      await context.close();
    }
  });

  await test.step("open the case, with a system-allocated identifier", async () => {
    await page.goto("/cases/new");
    await settled(page);

    await selectContaining(page.locator("select#engagement"), stamp);
    await fill(page, "Title", title);
    await page.getByLabel(/^Case type\*?$/).selectOption(caseType);
    await page.getByLabel(/^Priority\*?$/).selectOption(priority);
    await page.getByRole("button", { name: /open the case/i }).click();

    await expect(page.getByText(/PDDC-\d{4}-\d{6} opened/i)).toBeVisible();
  });

  let caseUrl = "";
  await test.step("find the case in the register", async () => {
    await page.goto(`/cases?search=${encodeURIComponent(stamp)}`);
    await page.getByRole("link", { name: title }).click();
    await page.waitForURL(/\/cases\/[0-9a-f-]{36}/);
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    caseUrl = page.url();
  });

  return caseUrl;
}

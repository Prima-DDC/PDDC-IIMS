import { expect, test, type Page } from "@playwright/test";
import {
  panel,
  settled,
  submitAndSettle,
} from "./helpers";
// No sign-in here: the project supplies a stored session, and the one test
// that needs a different identity loads that identity's stored session too.

/**
 * Administration, driven through the real interface.
 *
 * This is the CRUD surface an administrator manages the system with, so it is
 * tested by clicking it rather than by calling the repository: a screen that
 * renders but whose form posts the wrong field name would pass a unit test and
 * fail a user.
 *
 * The project is configured with a stored administrator session, so each test
 * gets a fresh page and none depend on the order of the others.
 */

/** The first table in the main region, which is the list under test. */
const listTable = (page: Page) => page.locator("main table").first();


/**
 * Opens a user's record from the list and waits for the detail page.
 *
 * The wait is not optional. `click()` returns once the click has landed, not
 * once the client-side navigation has finished, so without it `page.url()` can
 * still be the list URL, and a locator such as `getByLabel("Role")` can
 * resolve against the list's own Role filter instead of the detail page's
 * assignment form. Both of those happened, and both surfaced as a 90-second
 * timeout somewhere else rather than as a readable failure here.
 */
async function openUser(page: Page, name: string) {
  await page.getByRole("link", { name }).click();
  await page.waitForURL(/\/admin\/users\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test.describe("administration is reachable and gated", () => {
  test("the overview lists every managed area with live counts", async ({ page }) => {
    await page.goto("/admin");

    await expect(page.getByRole("heading", { name: "System management" })).toBeVisible();

    // Each area appears twice, as a tab and as a card, so assert on the cards.
    const cards = page.locator("main a.card");
    await expect(cards.filter({ hasText: "Users" })).toHaveCount(1);
    await expect(cards.filter({ hasText: "Roles and permissions" })).toHaveCount(1);
    await expect(cards.filter({ hasText: "Recycle bin" })).toHaveCount(1);
    await expect(cards.filter({ hasText: "Audit trail" })).toHaveCount(1);

    // The counts come from the database, not from placeholders.
    await expect(page.getByText("Administrators").first()).toBeVisible();
  });

  test("every administration tab loads without an error", async ({ page }) => {
    for (const path of [
      "/admin/users",
      "/admin/roles",
      "/admin/overrides",
      "/admin/organisation",
      "/admin/features",
      "/admin/recycle-bin",
      "/admin/audit",
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} should load`).toBeLessThan(400);
      await expect(page.locator("h1").first()).toBeVisible();
    }
  });

  test("an investigator cannot reach administration at all", async ({ browser }) => {
    // The investigator's session, not the administrator's. Taken from the
    // setup project rather than signing in again, which costs a real MFA
    // round trip.
    const context = await browser.newContext({
      storageState: "playwright/.auth/investigator.json",
    });
    try {
      const page = await context.newPage();
      await page.goto("/admin");
      // 404 rather than 403: the existence of the section is not information
      // somebody with no administration right needs.
      await expect(page.getByRole("heading", { name: /page not found/i })).toBeVisible();

      // And the menu never offered it in the first place.
      await page.goto("/dashboard");
      await expect(
        page.getByRole("navigation", { name: "Sections" }).getByRole("link", {
          name: /administration/i,
        }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test.describe("users", () => {
  test("the list shows the seeded accounts and search narrows it", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();

    // Scoped to the table: the signed-in administrator's own name appears in
    // the header account menu, so a page-wide assertion would match that.
    const table = listTable(page);
    await expect(table.getByText("E2E Investigator")).toBeVisible();

    await page.getByPlaceholder(/name, email or employee number/i).fill("suspended");
    // The filter lives in the URL, debounced at 300ms.
    await expect(page).toHaveURL(/search=suspended/, { timeout: 15_000 });
    await expect(table.getByText("E2E Suspended")).toBeVisible();
    await expect(table.getByText("E2E Investigator")).toHaveCount(0);
  });

  test("filtering by status uses the URL so the view is shareable", async ({ page }) => {
    await page.goto("/admin/users?status=suspended");

    const table = listTable(page);
    await expect(table.getByText("E2E Suspended")).toBeVisible();
    await expect(table.getByText("E2E Administrator")).toHaveCount(0);
  });

  test("a user record shows roles, effective permissions and security", async ({ page }) => {
    await page.goto("/admin/users?search=investigator");
    await openUser(page, "E2E Investigator");

    await expect(page.getByRole("heading", { name: "E2E Investigator" })).toBeVisible();
    for (const section of [
      "Identity",
      "Roles",
      "Effective permissions",
      "Account status",
      "Security actions",
    ]) {
      await expect(page.getByRole("heading", { name: section })).toBeVisible();
    }

    // The permission list names what granted each entry, which is the whole
    // point of the viewer.
    await expect(page.getByText("role:investigator").first()).toBeVisible();
  });

  test("editing details saves and survives a reload", async ({ page }) => {
    await page.goto("/admin/users?search=investigator");
    await openUser(page, "E2E Investigator");

    const title = `Field Investigator ${Date.now() % 100000}`;
    await page.getByLabel("Job title").fill(title);
    await page.getByRole("button", { name: /save changes/i }).click();

    await expect(page.getByText("Saved.")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Job title")).toHaveValue(title);
  });

  test("optimistic concurrency rejects a stale edit", async ({ page, browser }) => {
    await page.goto("/admin/users?search=investigator");
    await openUser(page, "E2E Investigator");
    const url = page.url();

    // Change the record from a second session, so this page's version is behind.
    const other = await browser.newContext({
      storageState: "playwright/.auth/admin.json",
    });
    const otherPage = await other.newPage();
    await otherPage.goto(url);
    await otherPage.getByLabel("Work phone").fill("+233 30 000 0001");
    await otherPage.getByRole("button", { name: /save changes/i }).click();
    await expect(otherPage.getByText("Saved.")).toBeVisible({ timeout: 20_000 });
    // Close the page before the context, so no navigation is still settling.
    await otherPage.close();
    await other.close();

    // The first page still holds the old version number.
    await page.getByLabel("Work phone").fill("+233 30 000 0002");
    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(
      page.getByText(/changed since you opened it|changed while saving/i),
    ).toBeVisible();
  });

  test("a role can be assigned and removed", async ({ page }) => {
    await page.goto("/admin/users?search=investigator");
    await openUser(page, "E2E Investigator");

    // By id, not by label: the field's visible label is "Role*", so an exact
    // match on "Role" silently matched the list page's Role filter instead.
    const roles = panel(page, "Roles");
    await roles.locator("select#roleId").selectOption({ label: "QA / Reviewer" });
    await roles.getByRole("button", { name: /assign role/i }).click();

    // The role appears in the list, which is the outcome that matters.
    await expect(
      roles.locator("tr", { hasText: "QA / Reviewer" }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // And it must show up in the effective permissions too.
    await page.reload();
    await expect(page.getByText("role:qa_reviewer").first()).toBeVisible();

    // Remove it again, leaving the fixture as we found it. The inline row
    // action is `compact`, which hides the success banner on purpose: the row
    // disappearing is the feedback, so that is what is asserted.
    page.once("dialog", (dialog) => dialog.accept());
    const after = panel(page, "Roles");
    await after
      .locator("tr", { hasText: "QA / Reviewer" })
      .first()
      .locator("button")
      .last()
      .click();
    await expect(after.locator("tr", { hasText: "QA / Reviewer" })).toHaveCount(0);
  });

  test("a deny override takes effect and is listed", async ({ page }) => {
    await page.goto("/admin/users?search=investigator");
    await openUser(page, "E2E Investigator");

    const reason = `deny probe ${Date.now() % 100000}`;

    await page.getByLabel("Override resource").selectOption("evidence");
    await page.getByLabel("Override permission").selectOption({ index: 1 });
    await page.getByLabel("Override effect").selectOption("deny");
    await page.getByLabel("Reason for the override").fill(reason);
    await page.getByRole("button", { name: /add override/i }).click();

    await expect(page.getByText(/explicit deny always beats an allow/i)).toBeVisible();

    // A deny removes the grant rather than appearing as one, which is what
    // makes it safe. It is listed in the overrides table instead.
    await page.reload();
    await expect(page.locator("tr", { hasText: reason }).first()).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page
      .locator("tr", { hasText: reason })
      .first()
      .locator("button")
      .last()
      .click();
    await expect(page.locator("tr", { hasText: reason })).toHaveCount(0);
  });

  test("suspending and reactivating an account works end to end", async ({ page }) => {
    await page.goto("/admin/users?search=suspended");
    await openUser(page, "E2E Suspended");

    // The fixture starts suspended, so reactivate first, then suspend again to
    // leave it as the other tests expect.
    await page.getByLabel("New status").selectOption("active");
    await page.getByLabel("Reason for the status change").fill("end-to-end test");
    await page.getByRole("button", { name: /apply status change/i }).click();
    await expect(page.getByText("Account is now active.")).toBeVisible();

    await page.getByLabel("New status").selectOption("suspended");
    await page
      .getByLabel("Reason for the status change")
      .fill("restoring the fixture state");
    await page.getByRole("button", { name: /apply status change/i }).click();
    await expect(page.getByText("Account is now suspended.")).toBeVisible();
  });

  test("the provisioning screen offers all three paths", async ({ page }) => {
    await page.goto("/admin/users/new");

    await expect(page.getByRole("heading", { name: "Add a user" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /grant access to existing staff/i }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: /invite somebody new/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /bulk import from csv/i })).toBeVisible();

    // The directory lists real PDDC staff from the shared profiles table.
    await expect(listTable(page).getByRole("radio").first()).toBeVisible();
  });
});

test.describe("roles and permissions", () => {
  test("a role can be created, given permissions and deleted", async ({ page }) => {
    const suffix = Date.now() % 100000;
    const name = `E2E Temporary Role ${suffix}`;
    const key = `e2e_role_${suffix}`;

    await page.goto("/admin/roles");
    await expect(page.getByRole("heading", { name: "Roles and permissions" })).toBeVisible();
    await expect(listTable(page).getByRole("link", { name: "Investigator" })).toBeVisible();

    // Create, scoped to the create form so the labels are unambiguous.
    const createForm = page.locator("form").filter({ hasText: "Create role" });
    await createForm.getByLabel("Name").fill(name);
    await createForm.getByLabel("Key").fill(key);
    await createForm.getByRole("button", { name: /create role/i }).click();
    await expect(page.getByText(new RegExp(`${name} created`, "i"))).toBeVisible();

    // Open it and grant a permission.
    await page.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { name: "Permissions" })).toBeVisible();

    await page.getByPlaceholder(/filter, for example evidence/i).fill("cases");
    await page.locator('input[name="permissionIds"]').first().check();
    await page.getByRole("button", { name: /save permissions/i }).click();
    await expect(page.getByText(/permission\(s\) now granted/i)).toBeVisible();

    // The change is versioned with its reason.
    await expect(page.getByRole("heading", { name: "Version history" })).toBeVisible();

    // Delete it again.
    await page.goto("/admin/roles");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("tr", { hasText: name }).locator("button").last().click();
    await expect(page.locator("tr", { hasText: name })).toHaveCount(0);
  });

  test("the baseline role is protected from deletion", async ({ page }) => {
    await page.goto("/admin/roles");

    const employeeRow = listTable(page)
      .locator("tr")
      .filter({ hasText: "Employee" })
      .first();
    await expect(employeeRow.getByText("Baseline").first()).toBeVisible();
    // No delete control is rendered for a protected role.
    await expect(employeeRow.locator("button")).toHaveCount(0);
  });

  test("the administrator role explains its wildcard instead of a grid", async ({ page }) => {
    await page.goto("/admin/roles");
    await listTable(page)
      .getByRole("link", { name: "Administrator", exact: true })
      .click();

    await expect(page.getByText(/wildcard grant/i)).toBeVisible();
    await expect(page.getByText(/resources added in future/i)).toBeVisible();
    // No checkbox grid for a role whose grant is a wildcard.
    await expect(page.locator('input[name="permissionIds"]')).toHaveCount(0);
  });
});

test.describe("organisation and features", () => {
  test("a department can be created and deleted", async ({ page }) => {
    await page.goto("/admin/organisation");

    const code = `E2E${Date.now() % 10000}`;
    const createForm = page.locator("form").filter({ hasText: "Create department" });
    await createForm.getByLabel("Code").fill(code);
    await createForm.getByLabel("Name").fill("E2E Department");
    await createForm.getByRole("button", { name: /create department/i }).click();

    await expect(page.getByText(/E2E Department created/i)).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("tr", { hasText: code }).locator("button").last().click();
    await expect(page.locator("tr", { hasText: code })).toHaveCount(0);
  });

  test("the seeded countries and features are manageable", async ({ page }) => {
    await page.goto("/admin/organisation");
    await expect(page.getByText("Ghana").first()).toBeVisible();
    await expect(page.getByText("Rwanda").first()).toBeVisible();

    await page.goto("/admin/features");
    await expect(page.getByRole("heading", { name: "Feature definitions" })).toBeVisible();
    await expect(page.getByText("module.safety").first()).toBeVisible();
    await expect(page.getByText("ai.assist").first()).toBeVisible();
  });
});

test.describe("audit trail", () => {
  test("the chain verifies and administrator actions appear", async ({ page }) => {
    await page.goto("/admin/audit");

    await expect(page.getByRole("heading", { name: "Audit trail" })).toBeVisible();
    // The hash chain is recomputed on load.
    await expect(page.getByText(/chain verified/i)).toBeVisible();
    await expect(page.getByText(/every hash matching the one before it/i)).toBeVisible();

    // Scoped to the table: the action names also populate the filter's option
    // elements, which are not visible.
    const table = listTable(page);
    await expect(table.getByText("user.updated").first()).toBeVisible();

    // The acting administrator is named by address, not rendered as "system".
    // Migration 0017 resolves and stores it; before that every human action
    // in the trail looked like the platform's own.
    await expect(table.getByText("pddc-e2e-admin@example.invalid").first()).toBeVisible();
  });

  test("filtering by action narrows the list through the URL", async ({ page }) => {
    await page.goto("/admin/audit");
    await page.getByLabel("Action").selectOption("user.status_changed");

    await expect(page).toHaveURL(/action=user\.status_changed/);
    await expect(listTable(page).getByText("user.status_changed").first()).toBeVisible();
  });
});

test.describe("recycle bin", () => {
  test("a removed user lands in the bin and can be restored", async ({ page }) => {
    // The enrolment fixture has access, so it can be removed and restored
    // without disturbing the accounts the other tests rely on.
    await page.goto("/admin/users?search=enrol");
    await openUser(page, "E2E Enrolment");

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByLabel("Reason for removal").fill("end-to-end test");
    await page.getByRole("button", { name: /remove this account/i }).click();
    await expect(page.getByText(/Account removed/i)).toBeVisible();

    await page.goto("/admin/recycle-bin");
    await expect(listTable(page).getByText("E2E Enrolment")).toBeVisible();

    // The bin's restore button is `compact`, which hides the success banner on
    // purpose: the row leaving the bin is the feedback, so that is what is
    // asserted here. The account's own page carries the wording.
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /restore/i }).first().click();
    await expect(listTable(page).getByText("E2E Enrolment")).toHaveCount(0);

    // And it is back among the live accounts, deactivated rather than active:
    // a restore does not silently re-grant sign-in.
    await page.goto("/admin/users?search=enrol");
    await openUser(page, "E2E Enrolment");
    await expect(page.getByText(/Account removed/i)).toHaveCount(0);
    await expect(page.getByLabel("New status")).toBeVisible();

    // Reactivate, which is what finally lifts the Supabase ban that removal
    // applied. Without this the suite is not re-runnable: the next run's
    // enrolment sign-in would meet a banned account and report it as a wrong
    // password, which is how this was found.
    await page.getByLabel("New status").selectOption("active");
    await page
      .getByLabel("Reason for the status change")
      .fill("restoring the fixture state");
    await page.getByRole("button", { name: /apply status change/i }).click();
    await expect(page.getByText("Account is now active.")).toBeVisible();
  });
});

test.describe("the case lifecycle", () => {
  /**
   * PRD 4.3 wants the lifecycle configurable "without code changes", and it
   * has been data since M3. What is worth proving here is the screen that
   * makes that true, and in particular the guards: a configuration screen is
   * the one place in the platform that can strand live work.
   *
   * The assertions are deliberately almost all read-only or self-reverting.
   * This runs against the live shared project, and a test that added a stage
   * on every run would leave a lifecycle nobody designed: a stage cannot be
   * deleted, because cases and audit entries point at it.
   */

  test("the configured lifecycle is shown with what sits in it", async ({ page }) => {
    await page.goto("/admin/workflows");
    await settled(page);

    await expect(
      page.getByRole("heading", { name: "Case lifecycle", level: 1 }),
    ).toBeVisible();

    const lifecycle = panel(page, "Case lifecycle: PDDC standard investigation lifecycle");
    await expect(lifecycle).toBeVisible();

    /*
     * The fourteen stages PRD 4.2 names, as data rather than code.
     *
     * Taken from the sentence itself: "New, Pending Approval, Approved,
     * Assigned, Investigation in Progress, Awaiting Information, Analysis,
     * Draft Report, Quality Review, Approved, Delivered, Completed, Closed,
     * Archived". The second "Approved" is the report's, which migration 0023
     * disambiguates as "Report Approved".
     *
     * This list previously held "Planning", "Active Investigation", "Client
     * Review" and "Final Report", which PRD 4.2 does not mention: the first
     * belongs to the methodology of PRD 4.3, and the others to nothing. It
     * also omitted two stages that do exist. So the test asserted a lifecycle
     * the platform had never implemented, and failed against a correct one.
     */
    for (const stage of [
      "New",
      "Pending Approval",
      "Approved",
      "Assigned",
      "Investigation in Progress",
      "Awaiting Information",
      "Analysis",
      "Draft Report",
      "Quality Review",
      "Report Approved",
      "Delivered",
      "Completed",
      "Closed",
      "Archived",
    ]) {
      await expect(lifecycle.getByText(stage, { exact: true }).first()).toBeVisible();
    }

    /*
     * The stage nothing leaves is Archived, not Closed.
     *
     * Two mistakes were stacked here. The row was found with
     * `hasText: "Closed"`, and since every stage lists the stages it can
     * move TO, "Completed" contains the word "Closed" and sorts first, so
     * the assertion was aimed at a non-terminal stage. Correcting that to
     * select by key then showed the real error: Closed IS terminal and has
     * a route to Archived, because a closed case can still be archived.
     * Both stages are terminal; only Archived is the end of the line.
     */
    const byKey = (key: string) =>
      lifecycle
        .locator("li")
        .filter({ has: page.getByText(key, { exact: true }) })
        .first();

    await expect(
      byKey("archived").getByText(/Nothing leaves a terminal stage/i),
    ).toBeVisible();
    // Closed is terminal too, and keeps its one route on purpose.
    await expect(byKey("closed").getByText(/Archived/).first()).toBeVisible();
  });

  test("a stage key cannot be reused", async ({ page }) => {
    await page.goto("/admin/workflows");
    await settled(page);

    const lifecycle = panel(page, "Case lifecycle: PDDC standard investigation lifecycle");
    await lifecycle.getByRole("button", { name: /add a stage/i }).click();
    await lifecycle.locator("#stage-key").fill("quality_review");
    await lifecycle.locator("#stage-name").fill("Another Quality Review");
    await lifecycle.getByRole("button", { name: /add the stage/i }).click();

    await expect(
      lifecycle.getByText(/already has a stage keyed quality_review/i),
    ).toBeVisible();
  });

  test("the only way out of a stage holding cases cannot be taken away", async ({
    page,
  }) => {
    await page.goto("/admin/workflows");
    await settled(page);

    const lifecycle = panel(page, "Case lifecycle: PDDC standard investigation lifecycle");

    // "New" is where every case starts and it has exactly one route on, which
    // is the shape this guard exists for. Only that stage routes to Pending
    // Approval, so the control is unambiguous.
    const removeRoute = lifecycle.getByRole("button", {
      name: /Remove the route to Pending Approval/i,
    });
    page.once("dialog", (dialog) => dialog.accept());
    await removeRoute.click();

    await expect(lifecycle.getByText(/only way out of New/i)).toBeVisible();
    // And it is still there, which is the point.
    await expect(removeRoute).toBeVisible();
  });

  test("a stage can be renamed, and the key stays as it was", async ({ page }) => {
    await page.goto("/admin/workflows");
    await settled(page);

    const lifecycle = panel(page, "Case lifecycle: PDDC standard investigation lifecycle");

    /*
     * Selected by KEY, not by a substring of the name, and this matters more
     * than it looks.
     *
     * This test renames a stage of the live lifecycle every case screen
     * reads, and renames it back. It used to find the stage with
     * `hasText: "Analysis"`, which is a substring match, and the name it
     * renames to, "Analysis and Review", contains "Analysis". So the moment
     * a run failed between the rename and the restore, the next run's
     * selector matched the already-renamed stage or a neighbour and renamed
     * something else again. Repeated partial runs left `assigned` called
     * "Analysis" and `in_progress` called "Analysis and Review": two stages
     * sharing one name, no stage called "Assigned", and a lifecycle nobody
     * could read. Migration 0050 restored it.
     *
     * The key is unique, it is rendered beside the name, and renaming is
     * precisely the operation that does NOT change it, which makes it the
     * only safe handle here.
     */
    const byKey = (key: string) =>
      lifecycle
        .locator("li")
        .filter({ has: page.getByText(key, { exact: true }) })
        .first();

    const stage = byKey("analysis");
    await stage.getByRole("button", { name: /^rename$/i }).click();
    await stage.getByLabel("New name").fill("Analysis and Review");
    await stage.getByRole("button", { name: /^rename$/i }).last().click();

    await expect(lifecycle.getByText(/The key stays as it was/i)).toBeVisible();
    await page.goto("/admin/workflows");
    await expect(
      byKey("analysis").getByText("Analysis and Review", { exact: true }).first(),
    ).toBeVisible();
    // The key is what permissions and saved filters use, so it is unchanged.
    await expect(lifecycle.getByText("analysis", { exact: true })).toBeVisible();

    // Put it back, by the same key. This is the live lifecycle every case
    // screen reads, so leaving it renamed is leaving the product broken.
    const renamed = byKey("analysis");
    await renamed.getByRole("button", { name: /^rename$/i }).click();
    await renamed.getByLabel("New name").fill("Analysis");
    // Waited for: a navigation straight after a submit renders the page
    // before the write commits, so the rename is invisible to everything
    // that follows and the count read one short.
    await submitAndSettle(renamed.getByRole("button", { name: /^rename$/i }).last());
    await page.goto("/admin/workflows");
    await expect(
            // `.first()` is the stage's NAME. The row also shows its methodology
      // stage, which for this one is also "Analysis", so an unanchored match
      // finds two elements and strict mode refuses.
      byKey("analysis").getByText("Analysis", { exact: true }).first(),
    ).toBeVisible();
    // And nothing else was touched: "Assigned" and "Investigation in
    // Progress" are the neighbours the old selector used to catch.
    await expect(
      lifecycle.getByText("Assigned", { exact: true }),
    ).toBeVisible();
    await expect(
      lifecycle.getByText("Investigation in Progress", { exact: true }),
    ).toBeVisible();
  });

  test("a case type can be retired and offered again", async ({ page }) => {
    await page.goto("/admin/workflows");
    await settled(page);

    const types = panel(page, "Case types");
    const row = () => types.locator("tr", { hasText: "Asset Search" });

    /*
     * Put it back on offer first, if a previous run left it retired.
     *
     * This test mutates shared configuration: the case types every new-case
     * form reads. It retires one and offers it again, and when it failed
     * between those two steps it left `asset_search` inactive, so the next
     * run's opening assertion found "Retired" and failed on the starting
     * state rather than on anything it was testing. The same trap as the
     * stage rename, which migration 0050 had to clean up after.
     *
     * So the test no longer assumes how it found the world. It makes the
     * state it needs, does its work, and restores.
     */
    if ((await row().getByText("Retired").count()) > 0) {
      await submitAndSettle(row().getByRole("button", { name: /offer again/i }));
      await page.goto("/admin/workflows");
      await settled(page);
    }

    await expect(row().getByText("Offered")).toBeVisible();

    // `submitAndSettle` accepts the confirmation itself and waits for the
    // action to report back, so no separate dialog handler and no race.
    await submitAndSettle(row().getByRole("button", { name: /^retire$/i }));
    await expect(
      types.locator("tr", { hasText: "Asset Search" }).getByText("Retired"),
    ).toBeVisible();

    // A retired type is no longer offered for a new case, which is the whole
    // effect of retiring it.
    await page.goto("/cases/new");
    await settled(page);
    const options = await page.locator("select#caseType option").allInnerTexts();
    expect(options).not.toContain("Asset Search");

    await page.goto("/admin/workflows");
    const offerAgain = types
      .locator("tr", { hasText: "Asset Search" })
      .getByRole("button", { name: /offer again/i });
    await submitAndSettle(offerAgain);
    await expect(
      types.locator("tr", { hasText: "Asset Search" }).getByText("Offered"),
    ).toBeVisible();
  });
});

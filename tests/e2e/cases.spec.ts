import { expect, test } from "@playwright/test";
import { openApprovedCase } from "./case-fixture";
import { caseTab, openForm, panel, selectContaining, settled } from "./helpers";

/**
 * The case record, driven through the real interface as an operations manager.
 *
 * Structured the way crm.spec.ts is, and for the reason that file records: the
 * journey is one test with steps, because every stage depends on the one
 * before it and a module-scoped timestamp does not survive a worker restart.
 *
 * What the journey proves, which is the product rather than the plumbing:
 *
 *   A case cannot be opened against an engagement PDDC has not approved.
 *   A case cannot leave the first stage without an objective, and the override
 *   that lets it is a recorded decision with an owner.
 *   The lifecycle offers only the moves it is configured to allow, so PRD
 *   4.2's "Draft Report straight to Closed" is not on the menu.
 *   A critical case cannot be assigned until its risk assessment is approved.
 *   An overall risk rating lower than its worst dimension is refused.
 *   The original scope is immutable, and a revision needs a second person.
 */





test.describe("permissions on the case screens", () => {
  test("the manager sees the case register with its summary counts", async ({ page }) => {
    await page.goto("/cases");
    await settled(page);

    await expect(page.getByRole("heading", { name: "Cases", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: /Assigned to me/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Overdue/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open a case" }).first()).toBeVisible();
  });

  test("an investigator can reach cases but not open one", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "playwright/.auth/investigator.json",
    });
    try {
      const page = await context.newPage();
      await page.goto("/cases");
      await settled(page);

      // cases:view at `assigned` scope, so the list is reachable and empty of
      // anything they are not on. cases:create is not granted at all.
      await expect(page.getByRole("heading", { name: "Cases", level: 1 })).toBeVisible();
      await expect(page.getByRole("link", { name: "Open a case" })).toHaveCount(0);

      await page.goto("/cases/new");
      await expect(
        page.getByText(/do not have permission|forbidden/i).first(),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

test.describe("the case journey, end to end", () => {
  test.setTimeout(12 * 60 * 1000);

  test("from opening a case to a revised scope", async ({ page, browser }) => {
    const stamp = Date.now().toString().slice(-7);
    const CLIENT = `E2E Casework Holdings ${stamp} Ltd`;
    const TITLE = `E2E suspected procurement fraud ${stamp}`;

    const caseUrl = await openApprovedCase({
      page,
      browser,
      stamp,
      title: TITLE,
      clientName: CLIENT,
      priority: "high",
    });

    await test.step("the progress rail is built from the configured lifecycle", async () => {
      // Its first stage is whatever that lifecycle says rather than a
      // hard-coded "New", and a stage an administrator added would appear
      // here without a release.
      const rail = page.getByRole("navigation", { name: "Case progress" });
      await expect(rail).toBeVisible();
      await expect(rail.getByText("Quality Review")).toBeVisible();
      await expect(page.getByText("Confidential").first()).toBeVisible();
    });

    await test.step("the lifecycle refuses the move PRD 4.2 names as illegal", async () => {
      const lifecycle = panel(page, "Lifecycle");
      const options = await lifecycle
        .locator("select#toStageId option")
        .allInnerTexts();

      // From the first stage the only way on is submission for approval.
      expect(options.join(" ")).toContain("Pending Approval");
      expect(options.join(" ")).not.toContain("Closed");
      expect(options.join(" ")).not.toContain("Draft Report");
    });

    await test.step("it cannot leave the first stage without an objective", async () => {
      await expect(
        panel(page, "Lifecycle").getByText(/This case has no objective/i),
      ).toBeVisible();

      const lifecycle = panel(page, "Lifecycle");
      await lifecycle.locator("#stage-reason").fill("Submitting for approval");
      await lifecycle.getByRole("button", { name: /move the case on/i }).click();

      // The server refuses, and says what to do about it.
      await expect(lifecycle.getByText(/has no objective/i).first()).toBeVisible();
      await page.goto(caseUrl);
      await expect(
        panel(page, "Lifecycle").getByText(/This case has no objective/i),
      ).toBeVisible();
    });

    await test.step("record the objective, its questions and its deliverables", async () => {
      const objective = panel(page, "Objective");
      await objective
        .locator("#objective")
        .fill("Establish whether procurement fraud occurred, and if so by whom.");
      await objective
        .locator("#clientInstruction")
        .fill("Find out who authorised the duplicate invoices.");
      await objective.locator("#question-0").fill("Who approved the invoices?");
      await objective.getByRole("button", { name: /add another/i }).first().click();
      await objective.locator("#question-1").fill("Did the supplier exist?");
      await objective.locator("#deliverable-0").fill("Written report with an evidence schedule");
      await objective.getByRole("button", { name: /save objective/i }).click();

      await expect(objective.getByText("Objective saved.")).toBeVisible();

      await page.goto(caseUrl);
      await expect(page.getByText("Who approved the invoices?")).toBeVisible();
      await expect(page.getByText("Did the supplier exist?")).toBeVisible();
      await expect(
        panel(page, "Lifecycle").getByText(/This case has no objective/i),
      ).toHaveCount(0);
    });

    await test.step("now it moves on, and the move is recorded", async () => {
      const lifecycle = panel(page, "Lifecycle");
      await lifecycle.locator("#stage-reason").fill("Objective and scope agreed");
      await lifecycle.getByRole("button", { name: /move the case on/i }).click();
      // The action's own wording, which is "is now at", not "is now".
      await expect(
        lifecycle.getByText(/is now at "Pending Approval"/i),
      ).toBeVisible();
    });

    await test.step("an overall risk below its worst dimension is refused", async () => {
      await page.goto(caseUrl);
      const risk = panel(page, "Risk assessment");
      await openForm(risk, /assess the risk|reassess/i);

      await risk.locator("select#safetyRisk").selectOption("critical");
      await risk.locator("select#overallRisk").selectOption("low");
      await risk
        .locator("#rationale")
        .fill("Trying to call a critical safety risk an overall low risk.");
      await risk.getByRole("button", { name: /record assessment/i }).click();

      // A case with a critical safety risk is not an overall low risk,
      // whatever the rationale says.
      await expect(risk.getByText(/cannot be lower than/i)).toBeVisible();
    });

    await test.step("a critical case blocks assignment until the risk is approved", async () => {
      const risk = panel(page, "Risk assessment");
      await risk.locator("select#overallRisk").selectOption("critical");
      await risk
        .locator("#rationale")
        .fill("Field surveillance with a hostile subject and political exposure.");
      await risk.getByRole("button", { name: /record assessment/i }).click();
      await expect(risk.getByText(/needs the Operations Manager/i)).toBeVisible();

      await page.goto(caseUrl);
      // The assignment panel says why rather than offering a form that fails.
      await expect(
        panel(page, "Who is on this case").getByText(/rated critical/i),
      ).toBeVisible();
      await expect(
        panel(page, "Who is on this case").getByRole("button", {
          name: /assign somebody/i,
        }),
      ).toHaveCount(0);
    });

    await test.step("the administrator approves the risk, and assignment opens up", async () => {
      const context = await browser.newContext({
        storageState: "playwright/.auth/admin.json",
      });
      try {
        const approver = await context.newPage();
        await approver.goto(caseUrl);
        await settled(approver);

        const risk = panel(approver, "Risk assessment");
        approver.once("dialog", (dialog) => dialog.accept());
        await risk.getByRole("button", { name: /approve this assessment/i }).click();
        // The durable effect rather than the banner. Approving is the last
        // thing there is to do to an assessment, so the form goes when it
        // succeeds and takes its own confirmation with it. Leaving a dead
        // form on screen to hold a message would be the worse answer; what
        // the panel says afterwards is the record.
        await expect(risk.getByText(/Approved by E2E Administrator/i)).toBeVisible();
        await expect(
          risk.getByRole("button", { name: /approve this assessment/i }),
        ).toHaveCount(0);
        await approver.close();
      } finally {
        await context.close();
      }

      await page.goto(caseUrl);
      await expect(
        panel(page, "Who is on this case").getByRole("button", {
          name: /assign somebody/i,
        }),
      ).toBeVisible();
    });

    await test.step("assign a lead investigator, and refuse a second", async () => {
      const assignment = panel(page, "Who is on this case");
      await openForm(assignment, /assign somebody/i);
      await selectContaining(assignment.locator("select#assign-user"), "E2E Investigator");
      await assignment.locator("select#assign-role").selectOption("lead_investigator");
      await assignment.locator("#assign-reason").fill("Has the sector experience");
      await assignment.getByRole("button", { name: /^assign$/i }).click();

      await expect(
        assignment.locator("tr", { hasText: "E2E Investigator" }),
      ).toHaveCount(1);

      // A case has one lead investigator at a time, and the message names the
      // incumbent rather than reporting a constraint.
      await page.goto(caseUrl);
      const second = panel(page, "Who is on this case");
      await openForm(second, /assign somebody/i);
      await selectContaining(second.locator("select#assign-user"), "E2E Operations Manager");
      await second.locator("select#assign-role").selectOption("lead_investigator");
      await second.getByRole("button", { name: /^assign$/i }).click();
      await expect(second.getByText(/is already the lead investigator/i)).toBeVisible();
    });

    await test.step("record the original scope, which is then immutable", async () => {
      await page.goto(caseUrl);
      const scope = panel(page, "Scope");
      await scope
        .locator("#scope")
        .fill("Review the three named subsidiaries, their directors and the invoices.");
      await scope.locator("#outOfScope").fill("Anything outside Ghana.");
      await scope.getByRole("button", { name: /record the original scope/i }).click();
      // The durable effect, for the reason the risk approval records above:
      // recording the original scope is the last thing there is to do to it,
      // so the form goes when it succeeds. What replaces it is the scope
      // itself, with its version and who recorded it, which is the record.
      // "Version 1" is a badge and "recorded <date>" is the line under it;
      // the two are separate elements, so there is no "Version 1 recorded"
      // to find. The success message says "Scope recorded as version 1",
      // which is a third wording again. Asserted here as the screen renders
      // it rather than as a sentence nothing says.
      await expect(scope.getByText(/^Version 1$/)).toBeVisible();
      await expect(scope.getByText(/^recorded /)).toBeVisible();

      await page.goto(caseUrl);
      const after = panel(page, "Scope");
      await expect(after.getByText(/^Version 1$/)).toBeVisible();
      // There is no edit control anywhere in the panel, by design.
      await expect(after.locator("#scope")).toHaveCount(0);
      await expect(
        after.getByRole("button", { name: /record the original scope/i }),
      ).toHaveCount(0);
    });

    await test.step("a scope change needs a second person to decide it", async () => {
      const scope = panel(page, "Scope");
      await openForm(scope, /request a change/i);

      await scope
        .locator("#change-reason")
        .fill("The client has asked us to cover two more subsidiaries.");
      await scope
        .locator("#proposedScope")
        .fill("Review five subsidiaries, their directors and the invoices.");
      await scope.locator("#additionalCost").fill("4500");
      await scope.locator("#additionalCostCurrency").fill("GHS");
      await scope.locator("#additionalDays").fill("10");
      await scope
        .locator("#clientApprovalReference")
        .fill("Email from the client of 21 October 2026");
      await scope.getByRole("button", { name: /raise the request/i }).click();
      // The durable effect again: a case can have one pending change at a
      // time, so raising this one removes the form that raised it. What
      // replaces it is the request itself, awaiting a decision.
      await expect(
        scope.getByText(/SCR-\d{4}-\d{6} is awaiting a decision/i),
      ).toBeVisible();

      await page.goto(caseUrl);
      // The requester cannot decide it, and the screen says so rather than
      // offering a decision form that would be refused.
      await expect(
        panel(page, "Scope").getByText(/You raised this request/i),
      ).toBeVisible();
      await expect(
        panel(page, "Scope").getByRole("button", { name: /record the decision/i }),
      ).toHaveCount(0);
    });

    await test.step("the administrator approves it, writing version 2 beside version 1", async () => {
      const context = await browser.newContext({
        storageState: "playwright/.auth/admin.json",
      });
      try {
        const approver = await context.newPage();
        await approver.goto(caseUrl);
        await settled(approver);

        const scope = panel(approver, "Scope");
        await scope.locator("select#scope-decision").selectOption("approve");
        await scope
          .locator("#scope-decision-reason")
          .fill("Client approval received in writing and the fee is agreed.");
        approver.once("dialog", (dialog) => dialog.accept());
        await scope.getByRole("button", { name: /record the decision/i }).click();
        // The durable effect. The decision form is rendered inside the pending
        // request, so deciding it removes both: what the approver sees
        // afterwards is version 2 beside version 1, which is the whole point
        // of PRD 5.4 and a better thing to assert than a banner.
        await expect(scope.getByText("Version 2")).toBeVisible();
        await expect(
          scope.getByRole("button", { name: /record the decision/i }),
        ).toHaveCount(0);
        await approver.close();
      } finally {
        await context.close();
      }

      await page.goto(caseUrl);
      const scope = panel(page, "Scope");
      await expect(scope.getByText("Version 2")).toBeVisible();
      await expect(scope.getByText(/five subsidiaries/i)).toBeVisible();
      // The original is still there, beside the revision (PRD 5.4).
      await expect(scope.getByText(/The original scope, version 1/i)).toBeVisible();
      await expect(scope.getByText(/three named subsidiaries/i)).toBeVisible();
    });

    await test.step("log a material communication", async () => {
      // Communications are their own tab of the case file (PRD 18, screen 9).
      await page.goto(caseTab(caseUrl, "comms"));
      await settled(page);
      const comms = panel(page, "Communications");
      await openForm(comms, /log one/i);

      await comms.locator("select#kind").selectOption("instruction");
      await comms.locator("#sender").fill("ama@client.example");
      await comms.locator("#recipient").fill("ops@primaddc.com");
      await comms.locator("#comm-subject").fill("Initial instruction");
      await comms.locator("#comm-body").fill("Please proceed as discussed.");
      await comms.getByRole("button", { name: /log it/i }).click();

      await expect(comms.getByText("Initial instruction")).toBeVisible();
      await expect(comms.getByText("Instruction").first()).toBeVisible();
    });

    await test.step("the case appears in the list with its stage and risk", async () => {
      await page.goto(`/cases?search=${encodeURIComponent(stamp)}`);
      const row = page.locator("tr", { hasText: TITLE });
      await expect(row).toHaveCount(1);
      await expect(row.getByText(/Critical risk/i)).toBeVisible();
      await expect(row.getByText("E2E Investigator")).toBeVisible();
    });
  });
});

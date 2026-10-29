import { expect, test } from "@playwright/test";
import { openApprovedCase } from "./case-fixture";
import { caseTab, openForm, panel, selectContaining, settled } from "./helpers";

/**
 * Investigator safety and case commercials, driven through the real interface
 * as an operations manager (PRD 5.6, 5.7, 5.8).
 *
 * One test with steps, for the reason the other journeys record: each stage
 * depends on the one before it.
 *
 * What the journey proves, which is the product rather than the plumbing:
 *
 *   A check-in schedule cannot be set without saying how to check in.
 *   Checking in and out is two taps and nothing to fill in, and the next
 *   check-in time is worked out by the platform rather than typed.
 *   An unsafe check-in has to say what is wrong, and says plainly that
 *   recording it is not the same as raising the alarm.
 *   Whoever reported an incident cannot be the one who closes it.
 *   "Paid" is refused while money is outstanding, and `outstanding` is the
 *   database's arithmetic rather than a figure somebody typed.
 *   Nobody approves their own time, and nobody decides their own expense.
 *   The field screen shows the cases this person is actually assigned to.
 */

test.describe("the safety and finance journey, end to end", () => {
  // Generous, and for a measured reason: the journey is seventeen steps, each
  // of which is a real mutation plus the route refresh behind it, against a
  // database 127ms away. The task journey next door takes five minutes; this
  // one has the case fixture in front of it as well.
  test.setTimeout(20 * 60 * 1000);

  test("from a safety plan to an approved timesheet", async ({ page, browser }) => {
    const stamp = Date.now().toString().slice(-7);
    const TITLE = `E2E field operation ${stamp}`;

    const caseUrl = await openApprovedCase({
      page,
      browser,
      stamp,
      title: TITLE,
      clientName: `E2E Fieldwork Holdings ${stamp} Ltd`,
      priority: "medium",
    });

    await test.step("a check-in schedule needs instructions to go with it", async () => {
      // The case file is tabbed (PRD 18, screen 9), so safety is its own tab.
      await page.goto(caseTab(caseUrl, "safety"));
      await settled(page);
      const safety = panel(page, "Safety");
      await expect(safety).toBeVisible();

      await safety.locator("#safety-location").fill("Tema port, gate 3 car park");
      await safety.locator("#safety-risk").selectOption("high");
      await safety.locator("#safety-contact-name").fill("Duty supervisor");
      await safety.locator("#safety-contact-phone").fill("+233 30 000 0000");
      await safety.locator("#safety-frequency").fill("4");

      // The instructions field appears as soon as there is a schedule, and is
      // required: a schedule nobody knows how to follow is not a schedule.
      await expect(safety.locator("#safety-check-in-instructions")).toBeVisible();
      await safety.getByRole("button", { name: /record the safety plan/i }).click();
      await expect(
        safety.getByText(/Say how to check in|Check the highlighted fields/i).first(),
      ).toBeVisible();
    });

    await test.step("record the plan, hazards and emergency contact", async () => {
      const safety = panel(page, "Safety");
      await safety
        .locator("#safety-check-in-instructions")
        .fill("Use the field screen, or ring the duty supervisor on the office line.");
      await safety
        .locator("#safety-hazards")
        .fill("The subject's security staff have turned visitors away before.");
      await safety
        .locator("#safety-instructions")
        .fill("Two people at all times. Withdraw if challenged.");
      await safety.getByRole("button", { name: /record the safety plan/i }).click();

      // Recording the plan replaces the form with the plan, so the form's own
      // banner goes with it. The plan on screen is the confirmation.
      await expect(safety.getByText("Tema port, gate 3 car park")).toBeVisible();

      await page.goto(caseTab(caseUrl, "safety"));
      const saved = panel(page, "Safety");
      await expect(saved.getByText("Tema port, gate 3 car park")).toBeVisible();
      await expect(saved.getByText(/Duty supervisor, \+233 30 000 0000/)).toBeVisible();
      await expect(saved.getByText("4 hours")).toBeVisible();
    });

    await test.step("checking in is two taps, and the next one is worked out", async () => {
      const safety = panel(page, "Safety");
      await safety.getByRole("button", { name: /^check in$/i }).click();

      // The time of the next check-in comes from the plan's interval, not
      // from anything the person in the field has to type.
      await expect(safety.getByText(/The next check-in is due by \d{2}:\d{2}/)).toBeVisible();

      await page.goto(caseTab(caseUrl, "safety"));
      const after = panel(page, "Safety");
      await expect(after.getByText(/Out at the moment/i)).toBeVisible();
      await expect(after.getByText(/Next due \d{2}:\d{2}/)).toBeVisible();
    });

    await test.step("an unsafe check-in has to say what is wrong", async () => {
      const safety = panel(page, "Safety");
      await safety.getByRole("button", { name: /i am not safe/i }).click();

      // Said before anything is recorded, because believing otherwise is the
      // dangerous misunderstanding.
      await expect(
        safety.getByText(/does not ring anybody/i),
      ).toBeVisible();

      await safety.getByRole("button", { name: /record it/i }).click();
      await expect(safety.getByText(/Say what is wrong/i).first()).toBeVisible();

      await safety
        .locator("#unsafe-notes")
        .fill("Two men have been following the vehicle since the port.");
      await safety.locator("#unsafe-location").fill("Harbour road");
      await safety.getByRole("button", { name: /record it/i }).click();

      await expect(safety.getByText(/recorded as NOT safe/i)).toBeVisible();

      await page.goto(caseTab(caseUrl, "safety"));
      const alarmed = panel(page, "Safety");
      await expect(
        alarmed.getByText(/Somebody has reported that they are not safe/i),
      ).toBeVisible();
      // The number to ring is in the alarm itself, not a click away.
      await expect(
        alarmed.getByText(/Emergency contact: Duty supervisor on \+233 30 000 0000/),
      ).toBeVisible();
    });

    await test.step("checking out ends the schedule", async () => {
      const safety = panel(page, "Safety");
      await safety.getByRole("button", { name: /check out/i }).click();

      // Checking out removes the button that did it, so the form's own
      // confirmation goes with the form. The durable line is the one that
      // says where things stand.
      await expect(
        safety.getByText(/Last event: Checked out at \d{2}:\d{2}/),
      ).toBeVisible();

      await page.goto(caseTab(caseUrl, "safety"));
      await expect(
        panel(page, "Safety").getByText(/Out at the moment/i),
      ).toHaveCount(0);
    });

    await test.step("report an incident", async () => {
      const incidents = panel(page, "Incidents");
      await incidents.getByRole("button", { name: /report an incident/i }).click();

      await incidents.locator("#incident-type").selectOption("threat");
      await incidents.locator("#incident-severity").selectOption("high");
      await incidents.locator("#incident-occurred").fill("2026-10-01T14:30");
      await incidents
        .locator("#incident-description")
        .fill(
          "Two men blocked the vehicle at the gate and told the team not to return.",
        );
      await incidents
        .locator("#incident-action")
        .fill("Withdrew and reported it to the duty supervisor by telephone.");
      await incidents.getByRole("button", { name: /record the incident/i }).click();

      await expect(incidents.getByText(/INC-\d{4}-\d{6} reported/i)).toBeVisible();
    });

    await test.step("a police reference cannot outlive its notification", async () => {
      await page.goto(caseTab(caseUrl, "safety"));
      const incidents = panel(page, "Incidents");
      await incidents.getByRole("button", { name: /report an incident/i }).click();

      // The reference field belongs to the box: it appears when the police
      // were notified and goes when they were not. So the contradiction the
      // rule refuses cannot be assembled on this screen at all, which is the
      // better outcome. The rule stays as the backstop for anything that
      // reaches the database another way, and is unit tested there.
      await incidents.getByLabel(/the police were notified/i).check();
      await expect(incidents.locator("#incident-police-reference")).toBeVisible();
      await incidents.locator("#incident-police-reference").fill("CR/2026/4411");

      await incidents.getByLabel(/the police were notified/i).uncheck();
      await expect(incidents.locator("#incident-police-reference")).toHaveCount(0);

      await incidents.getByRole("button", { name: /^cancel$/i }).click();
      await expect(
        incidents.getByRole("button", { name: /report an incident/i }),
      ).toBeVisible();
    });

    await test.step("whoever reported an incident cannot close it", async () => {
      await page.goto(caseTab(caseUrl, "safety"));
      const incidents = panel(page, "Incidents");

      await expect(
        incidents.getByText(/You are involved in this one/i).first(),
      ).toBeVisible();

      await incidents.getByRole("button", { name: /move it on/i }).first().click();
      await incidents.locator("#incident-status").selectOption("closed");
      await incidents
        .locator("#incident-resolution")
        .fill("Escorted off site and reported to the client.");
      await incidents.getByRole("button", { name: /move the incident/i }).click();

      await expect(
        incidents.getByText(/somebody else has to close it/i).first(),
      ).toBeVisible();
    });

    await test.step("a second person closes it", async () => {
      const context = await browser.newContext({
        storageState: "playwright/.auth/admin.json",
      });
      try {
        const admin = await context.newPage();
        await admin.goto(caseTab(caseUrl, "safety"));
        await settled(admin);

        const incidents = panel(admin, "Incidents");
        await incidents.getByRole("button", { name: /move it on/i }).first().click();
        await incidents.locator("#incident-status").selectOption("closed");
        await incidents
          .locator("#incident-resolution")
          .fill("Escorted off site and reported to the client.");
        await incidents.getByRole("button", { name: /move the incident/i }).click();

        await expect(incidents.getByText(/is now closed/i)).toBeVisible();
        await admin.close();
      } finally {
        await context.close();
      }
    });

    await test.step("the commercials, with outstanding computed by the database", async () => {
      await page.goto(caseTab(caseUrl, "finance"));
      const money = panel(page, "Commercials");
      await expect(money).toBeVisible();

      await money.locator("#fin-currency").fill("GHS");
      await money.locator("#fin-quoted").fill("12000");
      await money.locator("#fin-approved").fill("11500");
      await money.locator("#fin-invoice").fill(`INV-${stamp}`);
      await money.locator("#fin-invoiced").fill("11500");
      await money.locator("#fin-paid").fill("4000");

      // "Paid" is refused while money is outstanding: it is the status people
      // read instead of the numbers, so it has to be true.
      await money.locator("#fin-status").selectOption("paid");
      await money.getByRole("button", { name: /record the commercials/i }).click();
      await expect(money.getByText(/7500.00 is still outstanding/i)).toBeVisible();

      await money.locator("#fin-status").selectOption("part_paid");
      await money.getByRole("button", { name: /record the commercials/i }).click();
      // Same again: the panel swaps the form for the figures it just saved.
      await expect(money.getByText("GHS 7,500.00")).toBeVisible();

      await page.goto(caseTab(caseUrl, "finance"));
      const saved = panel(page, "Commercials");
      // Not typed anywhere: the database computed it from invoiced and paid.
      await expect(saved.getByText("GHS 7,500.00")).toBeVisible();
      await expect(saved.getByText("Part paid")).toBeVisible();
    });

    await test.step("an invoiced amount needs its invoice number", async () => {
      const money = panel(page, "Commercials");
      await money.getByRole("button", { name: /^edit$/i }).click();
      await money.locator("#fin-invoice").fill("");
      await money.getByRole("button", { name: /save the commercials/i }).click();
      await expect(
        money.getByText(/Record the invoice number alongside/i),
      ).toBeVisible();
    });

    await test.step("log time, which somebody else has to approve", async () => {
      await page.goto(caseTab(caseUrl, "finance"));
      const time = panel(page, "Time");
      await time.getByRole("button", { name: /log time/i }).click();

      await time.locator("#time-date").fill(today());
      await time.locator("#time-quantity").fill("7.5");
      await time.locator("#time-unit").selectOption("hours");
      await time.locator("#time-kind").selectOption("surveillance");
      await time
        .locator("#time-description")
        .fill("Static observation of the gate from the car park.");
      await time.getByRole("button", { name: /^log it$/i }).click();

      await expect(time.getByText(/7.5 hours logged against PDDC-/i)).toBeVisible();

      await page.goto(caseTab(caseUrl, "finance"));
      const logged = panel(page, "Time");
      await expect(logged.getByText("7.5 hours")).toBeVisible();
      // Offered as an explanation rather than as a button that would fail.
      await expect(
        logged.getByText(/yours, so somebody else approves it/i),
      ).toBeVisible();
    });

    await test.step("hours that do not fit in a day are refused", async () => {
      const time = panel(page, "Time");
      await time.getByRole("button", { name: /log time/i }).click();
      await time.locator("#time-date").fill(today());
      await time.locator("#time-quantity").fill("30");
      await time.getByRole("button", { name: /^log it$/i }).click();
      await expect(time.getByText(/A day holds 24 hours/i)).toBeVisible();
    });

    await test.step("claim a cost, which the claimant cannot decide", async () => {
      await page.goto(caseTab(caseUrl, "finance"));
      const costs = panel(page, "Costs");
      await costs.getByRole("button", { name: /claim a cost/i }).click();

      await costs.locator("#expense-date").fill(today());
      await costs.locator("#expense-category").selectOption("travel");
      await costs.locator("#expense-amount").fill("1450.50");
      await costs
        .locator("#expense-description")
        .fill("Return flight to Kumasi for the site visit");
      await costs.getByRole("button", { name: /submit the claim/i }).click();

      await expect(costs.getByText(/EXP-\d{4}-\d{6} claimed/i)).toBeVisible();

      await page.goto(caseTab(caseUrl, "finance"));
      const claimed = panel(page, "Costs");
      // The amount appears on the claim and on two of the tiles above it, so
      // the assertion names the claim rather than the figure.
      await expect(
        claimed.locator("li", { hasText: "Return flight to Kumasi" }),
      ).toContainText("GHS 1,450.50");
      await expect(
        claimed.getByText(/your own claim, so somebody else decides it/i),
      ).toBeVisible();
      await expect(claimed.getByRole("button", { name: /decide it/i })).toHaveCount(0);
    });

    await test.step("a second person approves the time and the cost", async () => {
      const context = await browser.newContext({
        storageState: "playwright/.auth/admin.json",
      });
      try {
        const admin = await context.newPage();
        await admin.goto(caseTab(caseUrl, "finance"));
        await settled(admin);

        const time = panel(admin, "Time");
        await time.getByRole("button", { name: /^approve$/i }).first().click();
        await expect(time.getByText("Approved").first()).toBeVisible();

        await admin.goto(caseTab(caseUrl, "finance"));
        const costs = panel(admin, "Costs");
        await costs.getByRole("button", { name: /decide it/i }).first().click();
        await costs.locator("#expense-status").selectOption("approved");
        await costs.getByRole("button", { name: /record the decision/i }).click();
        await expect(costs.getByText(/is now approved/i)).toBeVisible();
        await admin.close();
      } finally {
        await context.close();
      }

      await page.goto(caseTab(caseUrl, "finance"));
      // An approved entry is frozen, so the edit control is gone.
      const time = panel(page, "Time");
      await expect(time.getByText("Approved").first()).toBeVisible();
      await expect(time.getByRole("button", { name: /^edit$/i })).toHaveCount(0);
    });

    await test.step("the field screen shows the case once somebody is on it", async () => {
      await page.goto("/safety");
      await settled(page);

      // This case is not there yet: the field screen is built from
      // assignments, not from everything the manager could see.
      //
      // Asserted about *this run's* case rather than about the screen being
      // empty. The fixtures are long-lived accounts in a shared project, so a
      // previous run of this journey leaves the manager assigned to the case
      // it created, and "you are not assigned to any open case" is then
      // false for a reason that says nothing about the product.
      await expect(page.getByRole("link", { name: TITLE })).toHaveCount(0);

      await page.goto(caseUrl);
      const assignment = panel(page, "Who is on this case");
      await openForm(assignment, /assign somebody/i);
      await selectContaining(
        assignment.locator("select#assign-user"),
        "E2E Operations Manager",
      );
      await assignment.locator("select#assign-role").selectOption("lead_investigator");
      await assignment.locator("#assign-reason").fill("Running this one personally");
      await assignment.getByRole("button", { name: /^assign$/i }).click();
      await expect(
        assignment.locator("tr", { hasText: "E2E Operations Manager" }),
      ).toHaveCount(1);

      await page.goto("/safety");
      await settled(page);
      await expect(page.getByRole("link", { name: TITLE })).toBeVisible();
      await expect(page.getByText("Tema port, gate 3 car park")).toBeVisible();
      // The number is a tel: link, which on a phone is one tap.
      await expect(
        page.getByRole("link", { name: /Duty supervisor/ }),
      ).toHaveAttribute("href", "tel:+233300000000");
      await expect(page.getByRole("button", { name: /^check in$/i })).toBeVisible();
    });
  });
});

/** Today, as a date input needs it. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

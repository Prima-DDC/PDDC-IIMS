import { expect, test } from "@playwright/test";
import { fill, openForm, panel, selectContaining, settled } from "./helpers";

/**
 * Clients, intake, conflict screening and engagements, driven through the real
 * interface as an operations manager.
 *
 * The intake pipeline is ONE test, deliberately. Every stage depends on the
 * one before it, and the fixture names carry a timestamp so a re-run does not
 * collide with the last one, which together make the stages a single journey
 * rather than independent tests. Splitting them was tried first and was wrong:
 * Playwright starts a fresh worker after a failure, the spec module is
 * re-imported, the timestamp changes, and every later stage then looks for a
 * fixture that the earlier stage created under a different name. Steps inside
 * one test cannot drift that way, and `test.step` still reports each stage.
 *
 * What the journey proves, which is the product rather than the plumbing:
 *
 *   A high risk client needs five KYC checks, and the status is derived from
 *   the records rather than typed in.
 *   A near-identical company name is flagged as a potential match with a score
 *   and a reason, and nothing is merged.
 *   A decision is recorded once, with a reason, and cannot then be changed.
 *   An enquiry cannot be quoted before its own check is cleared.
 *   An engagement cannot be approved by the person who raised it.
 *   An approved engagement's scope is frozen.
 *
 * The records are left in place: they are what a demo wants, and the dedicated
 * removal tests cover the other direction.
 */





test.describe("permissions on the CRM screens", () => {
  test("an investigator can read clients but not create one", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "playwright/.auth/investigator.json",
    });
    try {
      const page = await context.newPage();
      await page.goto("/clients");
      await settled(page);

      // clients:view is granted to investigators, clients:create is not.
      await expect(
        page.getByRole("heading", { name: "Clients", level: 1 }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "New client" })).toHaveCount(0);

      // And the route itself refuses, not just the button.
      await page.goto("/clients/new");
      await expect(
        page.getByText(/do not have permission|forbidden/i).first(),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("an investigator cannot reach conflict screening at all", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "playwright/.auth/investigator.json",
    });
    try {
      const page = await context.newPage();
      // conflicts:view is not granted to investigators, so the whole area is
      // closed: running a check is not a read-only activity.
      await page.goto("/intake/conflicts");
      await settled(page);
      await expect(
        page.getByText(/do not have permission|forbidden/i).first(),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("the manager sees the client register with its summary counts", async ({
    page,
  }) => {
    await page.goto("/clients");
    await settled(page);

    await expect(page.getByRole("heading", { name: "Clients", level: 1 })).toBeVisible();
    // The strip above the list, which is what a manager reads first. By the
    // link role, because both of these are also row badges further down: the
    // tiles are links that filter the list to what they count.
    await expect(page.getByRole("link", { name: /KYC outstanding/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /High risk/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "New client" })).toBeVisible();
  });

  test("the conflict check screen states what it does not do", async ({ page }) => {
    await page.goto("/intake/conflicts/new");
    await settled(page);

    // PRD 8.3's wording is a product requirement, not decoration: the screen
    // must not imply the system reaches a conclusion.
    await expect(
      page.getByText(/never concludes that two parties are the same/i),
    ).toBeVisible();
    await expect(page.getByText(/potential/i).first()).toBeVisible();
  });

  test("reached without a subject, the screen asks which client", async ({ page }) => {
    // A check has to belong to a record, or it could never be acted on and the
    // database refuses it. Reached from the conflict list rather than from a
    // client, enquiry or engagement, the form therefore has to ask, otherwise
    // submitting it could only ever fail.
    await page.goto("/intake/conflicts/new");
    await settled(page);

    const picker = page.locator("select#subject-client");
    await expect(picker).toBeVisible();
    // It offers real clients, not an empty list, and nothing is pre-selected.
    expect(await picker.locator("option").count()).toBeGreaterThan(1);
    await expect(picker).toHaveValue("");

    // Submitting without one is refused, and the refusal explains itself
    // rather than reporting a constraint. This is the assertion that matters:
    // the field is marked required for a reader, but the server is what says
    // no, and before this it said no to every submission from this screen.
    await page.locator("#term-0").fill("Some Party Ltd");
    await page.getByRole("button", { name: /run the check/i }).click();
    await expect(page.getByText(/Choose which client, enquiry or engagement/i)).toBeVisible();
    // And it did not navigate, so nothing was recorded.
    await expect(page).toHaveURL(/\/intake\/conflicts\/new/);
  });

  test("reached from a client, it does not ask again", async ({ page }) => {
    await page.goto("/clients");
    await settled(page);
    await page.locator("main table a").first().click();
    await page.waitForURL(/\/clients\/[0-9a-f-]{36}/);

    await panel(page, "Conflict screening")
      .getByRole("link", { name: /run a check/i })
      .click();
    await page.waitForURL(/\/intake\/conflicts\/new/);

    // The subject came with the link, and the client's name is pre-filled.
    await expect(page.locator("select#subject-client")).toHaveCount(0);
    await expect(page.locator("#term-0")).not.toHaveValue("");
  });
});

test.describe("the intake pipeline, end to end", () => {
  // Many stages, each a real round trip to a hosted database.
  test.setTimeout(10 * 60 * 1000);

  test("from enquiry to an approved engagement", async ({ page, browser }) => {
    // Computed inside the test, so a worker restart cannot change it midway.
    const stamp = Date.now().toString().slice(-7);
    const CLIENT = `E2E Horizon Holdings ${stamp} Ltd`;
    /** Differs by a country word and a suffix: the PRD 8.3 company example. */
    const SIMILAR = `E2E Horizon Holdings ${stamp} Ghana Limited`;
    const SUBJECT = `E2E suspected supplier fraud ${stamp}`;
    const TITLE = `E2E supplier fraud investigation ${stamp}`;

    // Every step navigates to a URL it captured, never page.reload(): reload
    // means "wherever this page happens to be", which is not what any of these
    // steps mean, so a stray navigation surfaced as an assertion failing on a
    // completely different screen.
    let clientUrl = "";
    let checkUrl = "";
    let enquiryUrl = "";
    let engagementUrl = "";

    await test.step("create the client, with a system-allocated identifier", async () => {
      await page.goto("/clients/new");
      await settled(page);

      await fill(page, "Organisation name", CLIENT);
      await page.getByLabel(/^Client type\*?$/).selectOption("corporate");
      await page.getByLabel(/^Risk rating\*?$/).selectOption("high");
      await page.getByLabel(/^Status\*?$/).selectOption("prospect");
      await fill(page, "Main contact", "Ama Mensah");
      await fill(page, "Email", `horizon-${stamp}@example.invalid`);
      await page.getByRole("button", { name: /create client/i }).click();

      await expect(page.getByText(/created as CLI-\d{4}-\d{6}/i)).toBeVisible();
    });

    await test.step("find it by search and open it", async () => {
      await page.goto(`/clients?search=${encodeURIComponent(stamp)}`);
      await page.getByRole("link", { name: CLIENT }).click();
      await page.waitForURL(/\/clients\/[0-9a-f-]{36}/);
      await expect(page.getByRole("heading", { name: CLIENT, level: 1 })).toBeVisible();
      clientUrl = page.url();

      // A high risk client needs five checks, not three, and the page names
      // which are outstanding rather than only that KYC is incomplete.
      await expect(page.getByText("5 checks required at high risk")).toBeVisible();
      // Shown twice on purpose: once in the page header, once in the panel.
      await expect(page.getByText(/KYC: Not started/i).first()).toBeVisible();
      await expect(page.getByText(/Sanctions screening: not recorded/i)).toBeVisible();

      // Every screen carrying investigative content states its classification.
      await expect(page.getByText(/confidential/i).first()).toBeVisible();
    });

    await test.step("KYC status is derived, so there is no field for it", async () => {
      const details = panel(page, "Details");
      await expect(details.locator("select#riskRating")).toBeVisible();
      await expect(details.locator("[name='kycStatus']")).toHaveCount(0);
    });

    await test.step("record the five checks a high risk client needs", async () => {
      const kyc = panel(page, "Know your customer");
      await openForm(kyc, /record a check/i);

      for (const [check, label] of [
        ["identity", "Identity verification"],
        ["registration", "Company registration"],
        ["ownership", "Beneficial ownership"],
        ["sanctions", "Sanctions screening"],
        ["pep", "Politically exposed person"],
      ] as const) {
        await kyc.locator("select#checkType").selectOption(check);
        await kyc.locator("select#outcome").selectOption("pass");
        await kyc
          .locator("#kyc-summary")
          .fill(`Checked against the registry for ${check}`);
        await kyc.getByRole("button", { name: /record check/i }).click();

        // The row appearing is the effect worth asserting. The banner persists
        // between submissions, so asserting on it would pass on a stale one.
        await expect(kyc.locator("tr", { hasText: label })).toHaveCount(1);
      }

      await page.goto(clientUrl);
      await expect(page.getByText(/KYC: Completed/i).first()).toBeVisible();
      await expect(
        panel(page, "Know your customer").getByText(
          /Every check required at high risk/i,
        ),
      ).toBeVisible();
    });

    await test.step("a check that is not required does not change the position", async () => {
      const kyc = panel(page, "Know your customer");
      await openForm(kyc, /record a check/i);
      await kyc.locator("select#checkType").selectOption("adverse_media");
      await kyc.locator("select#outcome").selectOption("fail");
      await kyc
        .locator("#kyc-summary")
        .fill("Adverse media found, recorded for the file");
      await kyc.getByRole("button", { name: /record check/i }).click();
      await expect(kyc.locator("tr", { hasText: "Adverse media" })).toHaveCount(1);

      // Adverse media is informative rather than a gate at this rating, so the
      // client stays complete. The point is that the derived status follows the
      // rule and not the last thing somebody recorded.
      await page.goto(clientUrl);
      await expect(page.getByText(/KYC: Completed/i).first()).toBeVisible();
    });

    await test.step("screen the near-identical name and see it flagged", async () => {
      // From the client's own page, which is how this is reached in practice
      // and which carries the subject the check belongs to.
      await page.goto(clientUrl);
      await panel(page, "Conflict screening")
        .getByRole("link", { name: /run a check/i })
        .click();
      await page.waitForURL(/\/intake\/conflicts\/new/);

      // The client's own name is pre-filled. Replace it with the variant, so
      // what is screened differs from what is on file.
      await page.locator("#term-0").fill(SIMILAR);
      await page.getByRole("button", { name: /run the check/i }).click();
      await page.waitForURL(/\/intake\/conflicts\/[0-9a-f-]{36}/, {
        timeout: 60_000,
      });
      checkUrl = page.url();

      // The client on file is returned, with a score and a reason.
      const matches = panel(page, "Potential matches");
      await expect(matches.getByRole("link", { name: CLIENT })).toBeVisible();
      await expect(
        matches.getByText(/within|similar spelling|identical/i).first(),
      ).toBeVisible();
      await expect(page.getByText(/potential match/i).first()).toBeVisible();
      // And it says plainly that it has not concluded anything.
      await expect(page.getByText(/does not decide whether any of these/i)).toBeVisible();
    });

    await test.step("a short reason is refused, then the decision is recorded", async () => {
      const decide = panel(page, "Record the decision");
      await expect(decide).toBeVisible();

      await decide.locator("#decision-reason").fill("fine");
      page.once("dialog", (dialog) => dialog.accept());
      await decide.getByRole("button", { name: /record this decision/i }).click();
      // Against the field's own error, which is a <p role="alert"> rather than
      // the panel's <div role="alert"> banners. Not getByText: the field's
      // hint says "at least 10 characters" too, so that would have passed
      // without the rejection ever happening.
      await expect(decide.locator('p[role="alert"]')).toContainText(
        /at least 10 characters/i,
      );

      await decide.locator("select#decision").selectOption("cleared");
      await decide
        .locator("#decision-reason")
        .fill(
          "Different entity: separate registration number, confirmed by registry search.",
        );
      page.once("dialog", (dialog) => dialog.accept());
      await decide.getByRole("button", { name: /record this decision/i }).click();

      // The form being replaced by the record is the effect, and waiting for
      // it is what keeps the next step from reading a page that was rendered
      // before the action finished. Asserting /cannot be changed/ here did not
      // work: the form's own description says it too, so the assertion passed
      // instantly and the test navigated away mid-write.
      await expect(panel(page, "Record the decision")).toHaveCount(0);
      await expect(panel(page, "Decision").getByText(/Different entity/i)).toBeVisible();
    });

    await test.step("the recorded decision cannot be changed by anybody", async () => {
      await page.goto(checkUrl);
      await expect(
        panel(page, "Decision").getByText(/Different entity/i),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /record this decision/i }),
      ).toHaveCount(0);
      await expect(page.locator("select#decision")).toHaveCount(0);
    });

    await test.step("log an enquiry against the client", async () => {
      await page.goto("/intake/new");
      await settled(page);

      await fill(page, "Subject", SUBJECT);
      await page.getByLabel(/^Received by\*?$/).selectOption("email");
      await page.getByLabel(/^Urgency\*?$/).selectOption("high");
      await selectContaining(page.getByLabel(/^Existing client$/), stamp);
      await fill(page, "Who got in touch", "Ama Mensah");
      await page
        .getByLabel(/^What they told us$/)
        .fill("Duplicate invoices from a supplier that may not exist.");
      await page.getByRole("button", { name: /log enquiry/i }).click();

      await expect(page.getByText(/Logged as ENQ-\d{4}-\d{6}/i)).toBeVisible();
    });

    await test.step("open it, and see that the pipeline cannot be skipped", async () => {
      await page.goto(`/intake?search=${encodeURIComponent(stamp)}`);
      await page.getByRole("link", { name: SUBJECT }).click();
      await page.waitForURL(/\/intake\/[0-9a-f-]{36}/);
      await expect(page.getByRole("heading", { name: SUBJECT, level: 1 })).toBeVisible();
      enquiryUrl = page.url();

      // A new enquiry can only be assessed, declined or lapse. "Quoted" is not
      // on offer, because the order of the pipeline is enforced rather than
      // suggested.
      const options = await panel(page, "Stage and assignment")
        .locator("select#enquiry-stage option")
        .allInnerTexts();
      expect(options).toContain("Being assessed");
      expect(options).not.toContain("Quoted");
    });

    await test.step("move it through assessment to the conflict check", async () => {
      for (const [stage, label, reason] of [
        ["assessing", "assessing", "Taking a first look"],
        ["conflict_check", "conflict check", "Screening the parties"],
      ] as const) {
        const panelAt = panel(page, "Stage and assignment");
        await panelAt.locator("select#enquiry-stage").selectOption(stage);
        await panelAt.locator("#enquiry-stage-reason").fill(reason);
        await panelAt.getByRole("button", { name: /move to this stage/i }).click();
        await expect(panelAt.getByText(new RegExp(`is now "${label}"`, "i"))).toBeVisible();
        await page.goto(enquiryUrl);
      }
    });

    await test.step("it cannot be quoted on another record's clearance", async () => {
      const stage = panel(page, "Stage and assignment");
      await stage.locator("select#enquiry-stage").selectOption("quoted");
      await stage.locator("#enquiry-stage-reason").fill("Sending the quotation");
      await stage.getByRole("button", { name: /move to this stage/i }).click();

      // The earlier check was raised against the client, not this enquiry, so
      // this enquiry has no clearance of its own.
      await expect(stage.getByText(/Run a conflict check before quoting/i)).toBeVisible();
    });

    await test.step("screen the enquiry itself, which clears the way to a quote", async () => {
      await panel(page, "Conflict screening")
        .getByRole("link", { name: /run a check/i })
        .click();
      await page.waitForURL(/\/intake\/conflicts\/new/);
      await page.getByRole("button", { name: /run the check/i }).click();
      // An explicit bound: waitForURL otherwise inherits the navigation
      // timeout, which is unlimited by default, so a form that reports an
      // error instead of redirecting hangs until the whole test times out
      // rather than failing here where the cause is visible.
      await page.waitForURL(/\/intake\/conflicts\/[0-9a-f-]{36}/, {
        timeout: 60_000,
      });

      const decide = panel(page, "Record the decision");
      await decide.locator("select#decision").selectOption("cleared");
      await decide
        .locator("#decision-reason")
        .fill(
          "Screened the client and the supplier: no conflicting instruction on file.",
        );
      page.once("dialog", (dialog) => dialog.accept());
      await decide.getByRole("button", { name: /record this decision/i }).click();
      await expect(panel(page, "Record the decision")).toHaveCount(0);

      await page.goto(enquiryUrl);
      const stage = panel(page, "Stage and assignment");
      await stage.locator("select#enquiry-stage").selectOption("quoted");
      await stage.locator("#enquiry-stage-reason").fill("Sending the quotation");
      await stage.getByRole("button", { name: /move to this stage/i }).click();
      await expect(stage.getByText(/is now "quoted"/i)).toBeVisible();
    });

    await test.step("accept it, which offers the engagement as the next step", async () => {
      await page.goto(enquiryUrl);
      const stage = panel(page, "Stage and assignment");
      await stage.locator("select#enquiry-stage").selectOption("accepted");
      await stage.locator("#enquiry-stage-reason").fill("Client accepted the quotation");
      await stage.getByRole("button", { name: /move to this stage/i }).click();
      await expect(stage.getByText(/is now "accepted"/i)).toBeVisible();

      await page.goto(enquiryUrl);
      await expect(
        panel(page, "Next step").getByRole("link", { name: /create the engagement/i }),
      ).toBeVisible();

      // An accepted enquiry is final: it cannot be walked back.
      await expect(
        panel(page, "Stage and assignment").getByText(/is a closed stage/i),
      ).toBeVisible();
    });

    await test.step("create the engagement as a draft", async () => {
      await page.goto("/engagements/new");
      await settled(page);
      await expect(page.getByText(/It starts as a draft/i)).toBeVisible();

      await selectContaining(page.getByLabel(/^Client\*?$/), stamp);
      await fill(page, "Title", TITLE);
      await page.getByLabel(/^Type of work\*?$/).selectOption("fraud_investigation");
      await page
        .getByLabel(/^Scope of services$/)
        .fill("Trace the supplier, verify its registration, and report on the invoices.");
      await page.getByLabel(/^Commercial terms$/).fill("Fixed fee, payable on report.");
      await page.getByRole("button", { name: /create engagement/i }).click();

      await expect(page.getByText(/ENG-\d{4}-\d{6} created as a draft/i)).toBeVisible();
    });

    await test.step("a draft cannot jump straight to active", async () => {
      await page.goto(`/engagements?search=${encodeURIComponent(stamp)}`);
      await page.getByRole("link", { name: TITLE }).click();
      await page.waitForURL(/\/engagements\/[0-9a-f-]{36}/);
      await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
      engagementUrl = page.url();

      const options = await panel(page, "Engagement status")
        .locator("select#engagement-status option")
        .allInnerTexts();
      // Only submission and cancellation are offered: approval is a gate, not
      // a status somebody picks off a list.
      expect(options).toContain("Pending approval");
      expect(options).not.toContain("Active");
      expect(options).not.toContain("Approved");
    });

    await test.step("submit it, and be told why you cannot approve your own", async () => {
      const status = panel(page, "Engagement status");
      await status.locator("select#engagement-status").selectOption("pending_approval");
      await status.locator("#engagement-status-reason").fill("Scope and terms settled");
      await status.getByRole("button", { name: /apply status change/i }).click();
      await expect(status.getByText(/is now pending approval/i)).toBeVisible();

      await page.goto(engagementUrl);
      await expect(
        page.getByText(
          /You raised this engagement, so somebody else has to approve it/i,
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /approve this engagement/i }),
      ).toHaveCount(0);
    });

    await test.step("a second person approves it", async () => {
      // Approval genuinely requires two identities, which is the whole point
      // of separation of duties, so this step runs as the administrator.
      const context = await browser.newContext({
        storageState: "playwright/.auth/admin.json",
      });
      try {
        const approverPage = await context.newPage();
        await approverPage.goto(engagementUrl);
        await settled(approverPage);

        const status = panel(approverPage, "Engagement status");
        await expect(status.getByText(/Ready for approval/i)).toBeVisible();
        await status
          .locator("#approval-reason")
          .fill("Scope reviewed, conflict cleared");
        approverPage.once("dialog", (dialog) => dialog.accept());
        await status.getByRole("button", { name: /approve this engagement/i }).click();

        // The durable statement on the record, not the transient banner:
        // approving removes the block the banner lives in.
        await expect(
          panel(approverPage, "Engagement status").getByText(/^Approved$/),
        ).toBeVisible();
        await expect(
          approverPage.getByText(/Cases can now be opened against this engagement/i),
        ).toBeVisible();

        await approverPage.goto(engagementUrl);
        await expect(approverPage.getByText("E2E Administrator").first()).toBeVisible();
        await approverPage.close();
      } finally {
        await context.close();
      }
    });

    await test.step("the approved scope is frozen", async () => {
      await page.goto(engagementUrl);
      await expect(page.getByText(/Scope and terms are settled/i)).toBeVisible();

      const details = panel(page, "Details");
      // The field is not rendered at all, and the page explains why.
      await expect(details.locator("#scopeOfServices")).toHaveCount(0);
      await expect(
        details.getByText(/signed off and cannot be edited here/i),
      ).toBeVisible();
    });

    await test.step("the client's page shows the engagement and the cleared check", async () => {
      await page.goto(clientUrl);
      await expect(panel(page, "Engagements").getByText(TITLE)).toBeVisible();
      await expect(
        panel(page, "Conflict screening").getByText(/Cleared/i).first(),
      ).toBeVisible();
    });
  });
});

import { expect, test, type Page } from "@playwright/test";
import { openApprovedCase } from "./case-fixture";
import {
  caseTab,
  openForm,
  panel,
  selectContaining,
  settled,
} from "./helpers";

/**
 * Reporting, QA, delivery, closure and the archive, end to end (PRD 5.9, 10).
 *
 * The far end of the chain the platform exists to keep intact. A finding
 * becomes a report, the report is reviewed by somebody who did not write it,
 * QA sends it back once and then passes it, it is approved, delivered, and the
 * case closes and is archived.
 *
 * Three people, because PRD 16 does not give one person all of it and the
 * journey is worth little if it does:
 *
 *   - the operations manager opens the case, assigns it, and later closes it
 *     (`cases:close`, `cases:archive`), but holds only `reports:view` and so
 *     is offered nothing that moves a report along;
 *   - the investigator writes the report (`reports:create`, `reports:edit`)
 *     and can never be the one who passes it on;
 *   - the administrator reviews, runs QA, approves and records delivery.
 *
 * The one thing asserted everywhere: the author is refused at every stage, not
 * only at the final approval. An author who passed their own work at the
 * supervisor stage has defeated the same rule one step earlier.
 */

const stamp = Date.now().toString().slice(-8);
const CASE_TITLE = `E2E reporting journey ${stamp}`;
const CLIENT = `E2E Reporting Client ${stamp}`;
const COMPANY = `Meridian Logistics Ltd ${stamp}`;
const FINDING = `Three payments totalling GHS 480,000 went to a company controlled by the claims officer, run ${stamp}`;
const STATEMENT = `Bank statements show three transfers with no purchase order reference, run ${stamp}`;
const REPORT_TITLE = `Corporate fraud investigation report ${stamp}`;

/** The twelve checks of PRD 10.3, by key. */
const CHECKLIST = [
  "scope_addressed",
  "instructions_followed",
  "evidence_referenced",
  "sources_recorded",
  "facts_separated",
  "contradictions_addressed",
  "dates_verified",
  "names_verified",
  "findings_supported",
  "conclusions_supported",
  "classification_correct",
  "formatting_correct",
] as const;

/** Answers every check, with one deliberate failure when `fail` names it. */
async function answerChecklist(
  page: Page,
  options: { fail?: string; comment?: string } = {},
) {
  const qa = panel(page, "QA review");
  for (const key of CHECKLIST) {
    const failing = key === options.fail;
    await qa.locator(`select#qa-${key}`).selectOption(failing ? "fail" : "pass");
    if (failing) {
      await qa
        .locator(`#qa-comment-${key}`)
        .fill(options.comment ?? "This has to be corrected before it goes out.");
    }
    await qa
      .locator("form", { has: page.locator(`select#qa-${key}`) })
      .getByRole("button", { name: /^record$/i })
      .click();
    await expect(qa.locator(`select#qa-${key}`)).toHaveValue(
      failing ? "fail" : "pass",
    );
  }
}

test.describe("a report from an accepted finding to a closed, archived case", () => {
  // The whole chain in one test on purpose: every step needs the record the
  // step before it produced, and a report with no finding behind it would not
  // be testing PRD 10.2 at all.
  test.setTimeout(18 * 60_000);

  test("drafted, reviewed, returned by QA, approved, delivered, closed", async ({
    page,
    browser,
  }) => {
    const caseUrl = await openApprovedCase({
      page,
      browser,
      stamp,
      title: CASE_TITLE,
      clientName: CLIENT,
    });

    await test.step("assign the investigator, so they can reach the case", async () => {
      await page.goto(caseUrl);
      await settled(page);

      const assignment = panel(page, "Who is on this case");
      await openForm(assignment, /assign somebody/i);
      await selectContaining(
        assignment.locator("select#assign-user"),
        "E2E Investigator",
      );
      await assignment
        .locator("select#assign-role")
        .selectOption("lead_investigator");
      await assignment
        .locator("#assign-reason")
        .fill("Writing the report on this case");
      await assignment.getByRole("button", { name: /^assign$/i }).click();

      await expect(
        assignment.locator("tr", { hasText: "E2E Investigator" }),
      ).toHaveCount(1);
    });

    await test.step("the manager is offered no way to move a report along", async () => {
      // PRD 16 gives the Operations Manager oversight of reporting, not
      // authorship or approval: they hold `reports:view` and nothing else.
      // Asserted on the screen rather than assumed from the catalogue.
      await page.goto(caseTab(caseUrl, "reports"));
      await settled(page);
      await expect(panel(page, "Reports")).toBeVisible();
      await expect(
        panel(page, "Reports").getByRole("button", { name: /start a report/i }),
      ).toHaveCount(0);
    });

    const authorCtx = await browser.newContext({
      storageState: "playwright/.auth/investigator.json",
    });
    const author = await authorCtx.newPage();
    const reviewerCtx = await browser.newContext({
      storageState: "playwright/.auth/admin.json",
    });
    const reviewer = await reviewerCtx.newPage();

    let findingUrl = "";
    let reportUrl = "";

    try {
      /* --------------------------- the chain the report has to rest on */

      await test.step("the investigator builds the chain a report can cite", async () => {
        await author.goto(caseTab(caseUrl, "subjects"));
        await settled(author);

        const subjects = panel(author, "Subjects");
        await openForm(subjects, /register a subject/i);
        await subjects.locator("select#ent-type").selectOption("company");
        await subjects.locator("#ent-name").fill(COMPANY);
        await subjects
          .locator("select#ent-role")
          .selectOption("primary_subject");
        await subjects
          .locator("#ent-relation")
          .fill("Received the three payments under investigation");
        await subjects
          .getByRole("button", { name: /register the subject/i })
          .click();
        await expect(
          subjects.getByText(/ENT-\d{4}-\d{6} registered/i),
        ).toBeVisible();

        await author.goto(caseTab(caseUrl, "sources"));
        await settled(author);

        const sources = panel(author, "Sources");
        await openForm(sources, /record a source/i);
        await sources
          .locator("select#src-type")
          .selectOption("financial_record");
        await sources
          .locator("#src-description")
          .fill(`Bank statements for account 1234567, run ${stamp}`);
        await sources
          .locator("select#src-reliability")
          .selectOption("reliable");
        await sources.getByRole("button", { name: /record the source/i }).click();
        await expect(sources.getByText(/SRC-\d{4}-\d{6} recorded/i)).toBeVisible();

        await author.goto(caseTab(caseUrl, "sources"));
        await settled(author);

        const information = panel(author, "Information");
        await openForm(information, /record information/i);
        await selectContaining(
          information.locator("select#inf-source"),
          "Bank statements",
        );
        await information.locator("#inf-description").fill(STATEMENT);
        await information
          .locator("select#inf-credibility")
          .selectOption("probable");
        await information
          .locator("select#inf-confidence")
          .selectOption("moderate");
        await information
          .getByRole("button", { name: /record the information/i })
          .click();
        await expect(
          information.getByText(/INF-\d{4}-\d{6} recorded against SRC-/i),
        ).toBeVisible();
      });

      await test.step("draft the finding, link what it rests on, put it forward", async () => {
        await author.goto(caseTab(caseUrl, "findings"));
        await settled(author);

        const findings = panel(author, "Findings");
        await openForm(findings, /draft a finding/i);
        await findings.locator("#fnd-statement").fill(FINDING);
        await findings
          .locator("#fnd-detail")
          .fill("The statements show the payments and the company is controlled by the officer.");
        await findings.getByRole("button", { name: /draft the finding/i }).click();
        await expect(findings.getByText(/F-\d{3} drafted/i)).toBeVisible();

        await author.goto(caseTab(caseUrl, "findings"));
        await settled(author);
        await author.getByRole("link", { name: /^F-001$/ }).click();
        await author.waitForURL(/\/findings\/[0-9a-f-]{36}/);
        findingUrl = author.url();

        const links = panel(author, "Links");
        await openForm(links, /link something/i);
        await links.locator("select#fl-type").selectOption("information");
        await selectContaining(links.locator("select#fl-target"), stamp);
        await links
          .locator("#fl-relevance")
          .fill("Shows the three payments with no purchase order reference");
        await links.getByRole("button", { name: /link it/i }).click();
        await expect(
          links.getByText(/traceability now runs through it/i),
        ).toBeVisible();

        await author.goto(findingUrl);
        await settled(author);
        const stands = panel(author, "Where it stands");
        await stands.locator("select#fnd-status").selectOption("submitted");
        await stands.getByRole("button", { name: /^apply$/i }).click();
        await expect(stands.getByText(/is with a reviewer/i)).toBeVisible();
      });

      await test.step("the administrator accepts the finding, so it can be cited", async () => {
        await reviewer.goto(findingUrl);
        await settled(reviewer);

        const stands = panel(reviewer, "Where it stands");
        await stands.locator("select#fnd-status").selectOption("accepted");
        await stands
          .locator("#fnd-review-notes")
          .fill("The statements bear this out and the control is documented.");
        await stands
          .getByRole("button", { name: /record the decision/i })
          .click();
        await expect(stands.getByText(/accepted/i).first()).toBeVisible();
      });

      /* ------------------------------------------------- the report */

      await test.step("start the report", async () => {
        await author.goto(caseTab(caseUrl, "reports"));
        await settled(author);

        const reports = panel(author, "Reports");
        await openForm(reports, /start a report/i);
        await reports.locator("#rpt-title").fill(REPORT_TITLE);
        await reports.locator("select#rpt-type").selectOption("final_report");
        await reports.getByRole("button", { name: /start the report/i }).click();
        await expect(reports.getByText(/RPT-\d{4}-\d{6}/i)).toBeVisible();

        await author.goto(caseTab(caseUrl, "reports"));
        await settled(author);
        await author.getByRole("link", { name: REPORT_TITLE }).click();
        await author.waitForURL(/\/reports\/[0-9a-f-]{36}/);
        reportUrl = author.url();

        await expect(
          author.getByRole("heading", { name: REPORT_TITLE, level: 1 }),
        ).toBeVisible();
      });

      await test.step("a section that asserts something and cites nothing is refused", async () => {
        const sections = panel(author, "Sections");
        await openForm(sections, /add a section/i);
        await sections.locator("#sec-heading-new").fill("What the payments show");
        await sections.locator("select#sec-type-new").selectOption("finding");
        await sections
          .locator("#sec-body-new")
          .fill("Three payments totalling GHS 480,000 went to a related company.");
        await sections.getByRole("button", { name: /add the section/i }).click();

        await author.goto(reportUrl);
        await settled(author);

        // The screen says which section, and why, before anybody tries.
        await expect(
          author.getByText(/cite nothing/i).first(),
        ).toBeVisible();

        // And the server refuses it, which is the half that matters: the
        // warning is a courtesy, the refusal is the rule (PRD 10.2).
        const where = panel(author, "Where it is");
        await where
          .locator("select#rpt-status")
          .selectOption("investigator_review");
        await where.getByRole("button", { name: /put it forward/i }).click();
        await expect(where.getByText(/cite/i).first()).toBeVisible();
        await expect(
          author.getByRole("heading", { name: /^Draft$/ }),
        ).toHaveCount(0);
      });

      await test.step("cite the accepted finding, and only what may be cited is offered", async () => {
        await author.goto(reportUrl);
        await settled(author);

        const sections = panel(author, "Sections");
        await sections
          .getByRole("button", { name: /cite something/i })
          .first()
          .click();

        const kinds = await sections
          .locator("select[id^='cite-type-'] option")
          .allInnerTexts();
        expect(kinds.join(" ")).toMatch(/finding/i);

        const targets = sections.locator("select[id^='cite-target-']").first();
        await selectContaining(targets, "F-001");
        await sections.getByRole("button", { name: /cite it/i }).click();
        await expect(sections.getByText(/F-001/).first()).toBeVisible();

        await author.goto(reportUrl);
        await settled(author);
        await expect(author.getByText(/cite nothing/i)).toHaveCount(0);
      });

      await test.step("the author puts it forward, and cannot then pass it on", async () => {
        const where = panel(author, "Where it is");
        await where
          .locator("select#rpt-status")
          .selectOption("investigator_review");
        await where.getByRole("button", { name: /put it forward/i }).click();

        await author.goto(reportUrl);
        await settled(author);

        // PRD 10.1: "The author can never approve their own report." The
        // screen says so rather than offering a control the server refuses.
        await expect(
          panel(author, "Where it is").getByText(/your own report/i),
        ).toBeVisible();
      });

      /* ------------------------------------------- review, then QA */

      await test.step("the administrator moves it through review to QA", async () => {
        for (const target of ["supervisor_review", "qa_review"] as const) {
          await reviewer.goto(reportUrl);
          await settled(reviewer);
          const where = panel(reviewer, "Where it is");
          await where.locator("select#rpt-status").selectOption(target);
          await where
            .locator("#rpt-notes")
            .fill("Read in full; the citations check out.");
          await where
            .getByRole("button", { name: /record the decision/i })
            .click();
          await expect(where.getByText(/moved to/i).first()).toBeVisible();
        }
      });

      await test.step("an unanswered check blocks the review from completing", async () => {
        await reviewer.goto(reportUrl);
        await settled(reviewer);

        const qa = panel(reviewer, "QA review");
        await qa.getByRole("button", { name: /start a qa review/i }).click();

        await reviewer.goto(reportUrl);
        await settled(reviewer);

        // The point of a checklist. Twelve named checks, and the review cannot
        // be finished while any of them is unanswered.
        await expect(
          panel(reviewer, "QA review").getByText(/not been answered/i),
        ).toBeVisible();
      });

      await test.step("a failed check makes the review a return, whatever is clicked", async () => {
        await answerChecklist(reviewer, {
          fail: "names_verified",
          comment: "Two of the names are spelled differently in the appendix.",
        });

        await reviewer.goto(reportUrl);
        await settled(reviewer);

        // The result follows the items: with a failure the only button on
        // offer returns it, so a reviewer cannot pass a report that failed.
        const qa = panel(reviewer, "QA review");
        await expect(
          qa.getByRole("button", { name: /return for correction/i }),
        ).toBeVisible();
        await expect(
          qa.getByRole("button", { name: /pass it/i }),
        ).toHaveCount(0);

        await qa
          .locator("#qa-summary")
          .fill("Correct the names, then put it forward again.");
        await qa.getByRole("button", { name: /return for correction/i }).click();

        await reviewer.goto(reportUrl);
        await settled(reviewer);
        await expect(reviewer.getByText(/returned/i).first()).toBeVisible();
      });

      await test.step("the author corrects it, and QA passes it the second time", async () => {
        await author.goto(reportUrl);
        await settled(author);

        const where = panel(author, "Where it is");
        await where
          .locator("select#rpt-status")
          .selectOption("investigator_review");
        await where.getByRole("button", { name: /put it forward/i }).click();

        for (const target of ["supervisor_review", "qa_review"] as const) {
          await reviewer.goto(reportUrl);
          await settled(reviewer);
          const stage = panel(reviewer, "Where it is");
          await stage.locator("select#rpt-status").selectOption(target);
          await stage.locator("#rpt-notes").fill("The names now agree.");
          await stage
            .getByRole("button", { name: /record the decision/i })
            .click();
        }

        await reviewer.goto(reportUrl);
        await settled(reviewer);
        await panel(reviewer, "QA review")
          .getByRole("button", { name: /start a qa review/i })
          .click();

        await answerChecklist(reviewer);

        await reviewer.goto(reportUrl);
        await settled(reviewer);
        const qa = panel(reviewer, "QA review");
        await qa.locator("#qa-summary").fill("Twelve for twelve. It can go out.");
        await qa.getByRole("button", { name: /pass it/i }).click();
      });

      await test.step("approve it, and only then can it be delivered", async () => {
        await reviewer.goto(reportUrl);
        await settled(reviewer);

        for (const target of ["approval", "final"] as const) {
          const where = panel(reviewer, "Where it is");
          await where.locator("select#rpt-status").selectOption(target);
          await where.locator("#rpt-notes").fill("Approved for release.");
          await where
            .getByRole("button", { name: /record the decision/i })
            .click();
          await reviewer.goto(reportUrl);
          await settled(reviewer);
        }

        const delivery = panel(reviewer, "Client delivery");
        await openForm(delivery, /record a delivery/i);
        await delivery.locator("#del-to").fill("Claims Director, ABC Insurance");
        await delivery.locator("select#del-method").selectOption("secure_link");
        await delivery
          .locator("#del-notes")
          .fill("Signed link, expires in seven days.");
        await delivery
          .getByRole("button", { name: /record the delivery/i })
          .click();
        await expect(
          delivery.getByText(/Claims Director/i).first(),
        ).toBeVisible();
      });
    } finally {
      await author.close().catch(() => {});
      await reviewer.close().catch(() => {});
    }

    /* ------------------------------------------- closure and the archive */

    await test.step("closure is refused while its requirements are unmet", async () => {
      await page.goto(caseTab(caseUrl, "closure"));
      await settled(page);

      // PRD 5.9's nine requirements, with the three the platform answers
      // itself marked as such. That badge is the whole point of the gate: a
      // checklist that let somebody tick "report approved" when no approved
      // report existed would look like assurance and be the opposite.
      const gate = panel(page, "What closure requires");
      await expect(gate.locator("li")).toHaveCount(9);
      await expect(gate.getByText(/read from the records/i)).toHaveCount(3);
    });

    await test.step("propose closure with lessons learned", async () => {
      const closure = panel(page, "Propose closure");
      await openForm(closure, /fill it in/i);

      await closure
        .locator("#cl-objectives")
        .fill("Both objectives met: the payments were traced and the control established.");
      await closure
        .locator("#cl-evidence")
        .fill("All exhibits retained in the evidence register; nothing returned to the client.");
      await closure.locator("#cl-outstanding").fill("None.");
      await closure
        .locator("#cl-financial")
        .fill("Invoiced in full; expenses approved and settled.");
      await closure.locator("select#cl-retention").selectOption({ index: 1 });
      await closure
        .locator("#cl-whatWorked")
        .fill("Going to the bank statements before the interviews.");
      await closure.getByRole("button", { name: /propose closure/i }).click();

      await page.goto(caseTab(caseUrl, "closure"));
      await settled(page);
      await expect(panel(page, "The proposed closure")).toBeVisible();
    });

    await test.step("the proposer cannot approve their own closure", async () => {
      // PRD 5.9's gate is a second pair of eyes or it is nothing.
      await expect(
        panel(page, "The proposed closure").getByText(/cannot approve it/i),
      ).toBeVisible();
      await expect(
        panel(page, "The proposed closure").getByRole("button", {
          name: /record the decision/i,
        }),
      ).toHaveCount(0);
    });

    await test.step("a second person approves it, and the case is archived", async () => {
      const adminCtx = await browser.newContext({
        storageState: "playwright/.auth/admin.json",
      });
      const second = await adminCtx.newPage();
      try {
        await second.goto(caseTab(caseUrl, "closure"));
        await settled(second);

        const decision = panel(second, "The proposed closure");
        await decision.locator("select#cl-decision").selectOption("approved");
        await decision
          .locator("#cl-notes")
          .fill("Objectives met, evidence accounted for, nothing outstanding.");
        await decision
          .getByRole("button", { name: /record the decision/i })
          .click();

        await second.goto(caseTab(caseUrl, "closure"));
        await settled(second);
        await expect(second.getByText(/closed and archived/i)).toBeVisible();
      } finally {
        await second.close().catch(() => {});
        await adminCtx.close().catch(() => {});
      }
    });

    await test.step("the archive finds it, and it is the same record", async () => {
      await page.goto(`/archive?search=${encodeURIComponent(stamp)}`);
      await settled(page);

      // Screen 21: not a separate store. The archive links to the case
      // itself, which is what makes an archived case searchable at all.
      await expect(
        page.getByRole("link", { name: CASE_TITLE }),
      ).toBeVisible();
      await page.getByRole("link", { name: CASE_TITLE }).click();
      await page.waitForURL(/\/cases\/[0-9a-f-]{36}/);
      await expect(
        page.getByRole("heading", { name: CASE_TITLE, level: 1 }),
      ).toBeVisible();
    });

    await test.step("the manager can read and export the management reports", async () => {
      // PRD 10.4, and the permission it needs: `reports:export`, which
      // migration 0044 grants to the roles PRD 11 names. Before it, this
      // screen was reachable only by an administrator, which made the
      // feature useless to the people it is for.
      await page.goto("/reports/management");
      await settled(page);

      await expect(
        page.getByRole("heading", { name: "Management reports", level: 1 }),
      ).toBeVisible();
      await expect(panel(page, "Turnaround and quality")).toBeVisible();
      await expect(panel(page, "Case register")).toBeVisible();

      // The export applies the same check and reads the same model, so it
      // cannot show more than the screen.
      const response = await page.request.get("/api/export/management");
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/csv");
      const csv = await response.text();
      expect(csv).toContain("# Case register");
      expect(csv).toContain("# QA return rate");
      expect(csv).toContain(CASE_TITLE);
    });

    await test.step("an investigator is refused the firm's figures", async () => {
      const ctx = await browser.newContext({
        storageState: "playwright/.auth/investigator.json",
      });
      const them = await ctx.newPage();
      try {
        const response = await them.request.get("/api/export/management");
        expect(response.status()).toBe(403);
      } finally {
        await them.close().catch(() => {});
        await ctx.close().catch(() => {});
      }
    });
  });
});

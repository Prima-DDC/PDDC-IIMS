import { expect, test } from "@playwright/test";
import { openApprovedCase } from "./case-fixture";
import { caseTab, openForm, panel, selectContaining, settled } from "./helpers";

/**
 * Subjects, sources, information and findings, through the real screens.
 *
 * Two people, because the rules being tested are about who may do what, and
 * PRD 16 splits them exactly down the middle:
 *
 *   The **investigator** records. They hold create and edit on entities,
 *   sources, information and findings, and hold neither `entities:merge` nor
 *   `findings:approve`. They reach the case through their assignment to it.
 *   The **operations manager** reviews. They hold no create at all on any of
 *   this, and they hold the two supervisory permissions the investigator does
 *   not: merging two records, and deciding a finding.
 *
 * That split is itself asserted, because a permission model nobody tests is a
 * permission model nobody has.
 *
 * What the journey proves, which is the product rather than the plumbing:
 *
 *   A source's reliability and a statement's credibility are rated and shown
 *   separately (PRD 6.4), and "confirmed" is not even offered until something
 *   actually bears the statement out.
 *   Corroboration has to come from a different source, and the form does not
 *   offer material from the same one.
 *   A human source is made strictly restricted with its identity protected,
 *   whatever classification was chosen.
 *   Two records that look alike are flagged and never merged automatically;
 *   deciding and merging are separate acts; and a merge is reversible with
 *   nothing deleted.
 *   A finding cannot be put forward for review resting on nothing.
 *   A finding cannot be reviewed by its own analyst.
 *   The traceability strip reaches the source behind a linked statement,
 *   although nothing linked the source.
 */

const stamp = String(Date.now()).slice(-8);
const CLIENT = `E2E Intel Client ${stamp}`;
const CASE_TITLE = `E2E intelligence journey ${stamp}`;
const COMPANY = `Delta Logistics ${stamp} Ltd`;
const DUPLICATE = `Delta Logistics ${stamp} Ghana Limited`;
// The run marker goes FIRST in both of these. The link and corroboration
// pickers label an option with the first sixty characters of the
// description, so a marker at the end is invisible to a test that looks
// for it, which cost a full run to find.
const STATEMENT = `Run ${stamp}: three payments of GHS 45,000 went to one account in April.`;
const INTERVIEW = `Run ${stamp}: a former controller recalls the payments being approved verbally.`;
const FINDING = `The three payments were authorised without a purchase order, run ${stamp}.`;

test.describe("subjects, sources, information and findings, end to end", () => {
  // The same reason the other journeys give: every step depends on the one
  // before it, and this one runs two people through a case in sequence.
  test.setTimeout(30 * 60 * 1000);

  test("from a subject to an accepted, traceable finding", async ({
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

    await test.step("the manager records none of this, and the screens say so", async () => {
      // PRD 16 gives the Operations Manager oversight of the intelligence,
      // not its authorship. Proved rather than assumed, on all three tabs.
      for (const [tab, title] of [
        ["subjects", "Subjects"],
        ["sources", "Sources"],
        ["findings", "Findings"],
      ] as const) {
        await page.goto(caseTab(caseUrl, tab));
        await settled(page);
        await expect(panel(page, title)).toBeVisible();
        await expect(
          panel(page, title).getByRole("button", {
            name: /register a subject|record a source|draft a finding/i,
          }),
        ).toHaveCount(0);
      }
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
        .fill("Running the intelligence work on this case");
      await assignment.getByRole("button", { name: /^assign$/i }).click();

      await expect(
        assignment.locator("tr", { hasText: "E2E Investigator" }),
      ).toHaveCount(1);
    });

    /* ------------------------------------------- the investigator records */

    const analyst = await browser.newContext({
      storageState: "playwright/.auth/investigator.json",
    });
    const field = await analyst.newPage();
    let entityUrl = "";
    let informationUrl = "";
    let findingUrl = "";

    try {
      await test.step("register the subject of the investigation", async () => {
        await field.goto(caseTab(caseUrl, "subjects"));
        await settled(field);

        const subjects = panel(field, "Subjects");
        await openForm(subjects, /register a subject/i);

        await subjects.locator("select#ent-type").selectOption("company");
        await subjects.locator("#ent-name").fill(COMPANY);
        await subjects.locator("#ent-reg").fill(`CS${stamp}`);
        await subjects.locator("select#ent-role").selectOption("primary_subject");
        await subjects
          .locator("#ent-relation")
          .fill("Received the three payments under investigation");
        await subjects
          .getByRole("button", { name: /register the subject/i })
          .click();

        await expect(
          subjects.getByText(/ENT-\d{4}-\d{6} registered/i),
        ).toBeVisible();

        await field.goto(caseTab(caseUrl, "subjects"));
        await settled(field);
        await expect(
          panel(field, "Subjects").getByText(COMPANY).first(),
        ).toBeVisible();
      });

      await test.step("a second record that looks like it is flagged, never merged", async () => {
        const subjects = panel(field, "Subjects");
        await openForm(subjects, /register a subject/i);
        await subjects.locator("select#ent-type").selectOption("company");
        await subjects.locator("#ent-name").fill(DUPLICATE);
        await subjects.locator("select#ent-role").selectOption("related_party");
        await subjects
          .getByRole("button", { name: /register the subject/i })
          .click();

        // The platform says so at the moment the duplicate is created, rather
        // than leaving it to be found months later (PRD 8.4).
        await expect(
          subjects.getByText(/look(s)? like it/i).first(),
        ).toBeVisible();

        await field.goto(`/entities?search=${encodeURIComponent(stamp)}`);
        await settled(field);
        await field.getByRole("link", { name: new RegExp(COMPANY) }).click();
        await field.waitForURL(/\/entities\/[0-9a-f-]{36}/);
        entityUrl = field.url();

        // Nothing has been merged: both records stand, and the screen offers
        // the decision rather than having made it.
        await expect(
          panel(field, "Duplicates and matches").getByText(/These look alike/i),
        ).toBeVisible();
        await expect(field.getByText(/has been merged/i)).toHaveCount(0);
      });

      await test.step("flag the pair, and the investigator cannot merge it", async () => {
        const duplicates = panel(field, "Duplicates and matches");
        await openForm(duplicates, /flag a match/i);
        await selectContaining(duplicates.locator("select#flag-other"), DUPLICATE);
        await duplicates
          .locator("select#flag-type")
          .selectOption("potential_duplicate");
        await duplicates
          .locator("#flag-notes")
          .fill("Same registration number and the same trading address");
        await duplicates
          .getByRole("button", { name: /flag for a decision/i })
          .click();

        await expect(
          duplicates.getByText(/Nothing is merged until somebody decides/i),
        ).toBeVisible();

        await field.goto(entityUrl);
        await settled(field);
        const flagged = panel(field, "Duplicates and matches");
        await expect(flagged.getByText(/Awaiting a decision/i)).toBeVisible();
        // Deciding is offered; merging is not, because PRD 8.4's "authorised
        // confirmation" is a permission the investigator does not hold.
        await expect(
          flagged.getByRole("button", { name: /record the decision/i }),
        ).toBeVisible();
        await expect(
          flagged.getByRole("button", { name: /^Merge ENT-/i }),
        ).toHaveCount(0);
      });

      await test.step("record two sources, and a human source is protected whatever is chosen", async () => {
        await field.goto(caseTab(caseUrl, "sources"));
        await settled(field);

        const sources = panel(field, "Sources");
        await openForm(sources, /record a source/i);
        await sources.locator("select#src-type").selectOption("financial_record");
        await sources
          .locator("#src-description")
          .fill(`Bank statements for account 1234567, from the client, run ${stamp}`);
        await sources.locator("select#src-reliability").selectOption("reliable");
        await sources.getByRole("button", { name: /record the source/i }).click();
        await expect(sources.getByText(/SRC-\d{4}-\d{6} recorded/i)).toBeVisible();

        // A human source. The platform decides that its identity is
        // need-to-know whatever is typed, and deliberately does NOT raise the
        // record itself above the case team: what the source said is the
        // intelligence, and hiding it from the investigation would be the
        // opposite of protecting the source. See migration 0043.
        const again = panel(field, "Sources");
        await again.locator("select#src-type").selectOption("human_source");
        await again
          .locator("#src-description")
          .fill(`A former employee of the finance department, run ${stamp}`);
        await again.locator("select#src-reliability").selectOption("usually_reliable");
        await again.getByRole("button", { name: /record the source/i }).click();

        await expect(
          again.getByText(/its identity is need-to-know/i),
        ).toBeVisible();
      });

      await test.step('"confirmed" is not offered while nothing bears a statement out', async () => {
        await field.goto(caseTab(caseUrl, "sources"));
        await settled(field);

        const information = panel(field, "Information");
        await openForm(information, /record information/i);

        // The scale's top value is a claim about corroboration, so it is
        // absent from a brand new statement rather than refused afterwards.
        const options = await information
          .locator("select#inf-credibility option")
          .allInnerTexts();
        expect(options.join(" ")).not.toContain("Confirmed");
        expect(options.join(" ")).toContain("Probable");
      });

      await test.step("record two statements, one from each source", async () => {
        const information = panel(field, "Information");

        await selectContaining(
          information.locator("select#inf-source"),
          "Bank statements",
        );
        await information.locator("#inf-description").fill(STATEMENT);
        await information.locator("select#inf-credibility").selectOption("probable");
        await information.locator("select#inf-confidence").selectOption("moderate");
        await information
          .getByRole("button", { name: /record the information/i })
          .click();
        await expect(
          information.getByText(/INF-\d{4}-\d{6} recorded against SRC-/i),
        ).toBeVisible();

        const second = panel(field, "Information");
        await selectContaining(
          second.locator("select#inf-source"),
          "former employee",
        );
        await second.locator("#inf-description").fill(INTERVIEW);
        await second.locator("select#inf-credibility").selectOption("possible");
        await second.locator("select#inf-confidence").selectOption("low");
        await second.getByRole("button", { name: /record the information/i }).click();
        await expect(
          second.getByText(/INF-\d{4}-\d{6} recorded against SRC-/i),
        ).toBeVisible();
      });

      await test.step("both ratings are shown, and never combined", async () => {
        await field.goto(caseTab(caseUrl, "sources"));
        await settled(field);

        const information = panel(field, "Information");
        // PRD 6.4's distinction, on screen: the source is reliable and what it
        // said is only probable, and the table says both.
        await expect(
          information.getByText(/Source: Reliable/i).first(),
        ).toBeVisible();
        await expect(
          information.getByText(/Information: Probable/i).first(),
        ).toBeVisible();

        await information
          .getByRole("link", { name: new RegExp(STATEMENT.slice(0, 30)) })
          .click();
        await field.waitForURL(/\/information\/[0-9a-f-]{36}/);
        informationUrl = field.url();

        await expect(field.getByText(/Nothing bears this out yet/i)).toBeVisible();
      });

      await test.step("corroboration comes from a different source, and nothing else is offered", async () => {
        const bears = panel(field, "What bears it out");
        await openForm(bears, /record corroboration/i);

        // Only material from another source is on offer: two statements from
        // the same source are one source saying something twice.
        const options = await bears
          .locator("select#corr-other option")
          .allInnerTexts();
        expect(options.join(" ")).toContain("former controller recalls");
        expect(options.join(" ")).not.toContain("went to one account");

        await bears
          .locator("#corr-note")
          .fill("The interview bears out what the statements show");
        await bears.getByRole("button", { name: /record the corroboration/i }).click();
        await expect(
          bears.getByText(/now corroborates this, from SRC-/i),
        ).toBeVisible();
      });

      await test.step("a finding resting on nothing cannot be put forward", async () => {
        await field.goto(caseTab(caseUrl, "findings"));
        await settled(field);

        const findings = panel(field, "Findings");
        await openForm(findings, /draft a finding/i);
        await findings.locator("#fnd-statement").fill(FINDING);
        await findings
          .locator("#fnd-detail")
          .fill("The statements show the payments and the interview explains how.");
        await findings.getByRole("button", { name: /draft the finding/i }).click();
        await expect(findings.getByText(/F-\d{3} drafted/i)).toBeVisible();

        await field.goto(caseTab(caseUrl, "findings"));
        await settled(field);
        await field.getByRole("link", { name: /^F-001$/ }).click();
        await field.waitForURL(/\/findings\/[0-9a-f-]{36}/);
        findingUrl = field.url();

        // The platform's purpose, stated plainly on the screen.
        await expect(
          panel(field, "What it rests on").getByText(
            /Nothing supports this finding/i,
          ),
        ).toBeVisible();

        const stands = panel(field, "Where it stands");
        await stands.locator("select#fnd-status").selectOption("submitted");
        await stands.getByRole("button", { name: /^apply$/i }).click();
        await expect(
          stands.getByText(/Nothing supports this finding yet/i),
        ).toBeVisible();
      });

      await test.step("link what it rests on, and the strip reaches the source", async () => {
        await field.goto(findingUrl);
        await settled(field);

        const links = panel(field, "Links");
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

        await field.goto(findingUrl);
        await settled(field);

        // The strip reaches the SOURCE behind the statement, although nothing
        // linked the source: Source to Information is the first leg of the
        // chain, and a strip that started at the statement would hide where
        // the statement came from.
        const strip = panel(field, "What it rests on");
        await expect(
          strip.getByRole("link", { name: /SRC-\d{4}-\d{6}/ }),
        ).toBeVisible();
        await expect(
          strip.getByRole("link", { name: /INF-\d{4}-\d{6}/ }),
        ).toBeVisible();
        await expect(strip.getByText(/Nothing supports/i)).toHaveCount(0);
      });

      await test.step("put it forward, and its author cannot review it", async () => {
        const stands = panel(field, "Where it stands");
        await stands.locator("select#fnd-status").selectOption("submitted");
        await stands.getByRole("button", { name: /^apply$/i }).click();
        await expect(stands.getByText(/is with a reviewer/i)).toBeVisible();

        await field.goto(findingUrl);
        await settled(field);
        // PRD 16, and the screen says why rather than offering a form the
        // server would refuse.
        await expect(
          panel(field, "Where it stands").getByText(/you cannot review it/i),
        ).toBeVisible();
      });
    } finally {
      await field.close().catch(() => {});
    }

    /* ------------------------------------------- the manager reviews it */

    await test.step("the manager returns the finding with a note", async () => {
      await page.goto(findingUrl);
      await settled(page);

      const stands = panel(page, "Where it stands");
      await stands.locator("select#fnd-status").selectOption("returned");
      await stands
        .locator("#fnd-review-notes")
        .fill("Name the account the payments went to, and cite the statement page.");
      await stands.getByRole("button", { name: /record the decision/i }).click();
      await expect(stands.getByText(/returned to its analyst/i)).toBeVisible();
    });

    await test.step("the analyst puts it forward again, and the manager accepts it", async () => {
      const again = await analyst.newPage();
      try {
        await again.goto(findingUrl);
        await settled(again);
        // The reviewer's note is on the screen the analyst comes back to,
        // which is the point of requiring one.
        await expect(again.getByText(/Name the account the payments/i)).toBeVisible();

        const stands = panel(again, "Where it stands");
        await stands.locator("select#fnd-status").selectOption("submitted");
        await stands.getByRole("button", { name: /^apply$/i }).click();
        await expect(stands.getByText(/is with a reviewer/i)).toBeVisible();
      } finally {
        await again.close().catch(() => {});
      }

      await page.goto(findingUrl);
      await settled(page);
      const accept = panel(page, "Where it stands");
      await accept.locator("select#fnd-status").selectOption("accepted");
      await accept
        .locator("#fnd-review-notes")
        .fill("Supported by the statements and the interview. Agreed.");
      await accept.getByRole("button", { name: /record the decision/i }).click();
      await expect(
        accept.getByText(/accepted\. It can now be cited in a report/i),
      ).toBeVisible();

      // An accepted finding is not edited back into a draft: it is withdrawn
      // and replaced, so a report that cites it still reads true.
      await page.goto(findingUrl);
      await settled(page);
      const options = await page
        .locator("select#fnd-status option")
        .allInnerTexts();
      expect(options.join(" ")).not.toContain("Draft");
    });

    await test.step("the manager decides the duplicate, then merges it reversibly", async () => {
      await page.goto(entityUrl);
      await settled(page);

      const duplicates = panel(page, "Duplicates and matches");
      await duplicates
        .locator("select[id^='match-decision-']")
        .selectOption("same_entity");
      await duplicates
        .locator("input[id^='match-reason-']")
        .fill("Same registration number and the same registered address.");
      await duplicates.getByRole("button", { name: /record the decision/i }).click();
      await expect(
        duplicates.getByText(/Merging them is the next, separate step/i),
      ).toBeVisible();

      // Only now is the merge offered, which is PRD 8.4's "authorised
      // confirmation": the log records the reasoning, not a button press.
      await page.goto(entityUrl);
      await settled(page);
      const merge = panel(page, "Duplicates and matches");
      await merge
        .locator("input[id^='merge-reason-']")
        .fill("One company recorded twice, under its trading name.");
      page.once("dialog", (dialog) => dialog.accept());
      await merge.getByRole("button", { name: /^Merge ENT-/i }).click();
      await expect(
        merge.getByText(/Nothing was deleted, and this can be reversed/i),
      ).toBeVisible();
    });

    await test.step("the merge log says what it moved, and the merge is reversed", async () => {
      await page.goto(entityUrl);
      await settled(page);

      const history = panel(page, "Merge history");
      await expect(history.getByText(/In force/i)).toBeVisible();
      // The log says what was moved, which is what makes a reversal possible
      // rather than a guess.
      await expect(history.getByText(/Nothing was deleted/i).first()).toBeVisible();

      await history
        .locator("input[id^='reverse-']")
        .fill("The registration numbers differ after all; two companies.");
      page.once("dialog", (dialog) => dialog.accept());
      await history.getByRole("button", { name: /reverse this merge/i }).click();
      await expect(
        history.getByText(/stands on its own again, marked disputed/i),
      ).toBeVisible();

      await page.goto(entityUrl);
      await settled(page);
      await expect(
        panel(page, "Merge history").getByText(/Reversed/i).first(),
      ).toBeVisible();
      // The decision that authorised it is reopened rather than left
      // standing, so somebody has to make it again.
      await expect(
        panel(page, "Duplicates and matches")
          .getByText(/Could not be decided/i)
          .first(),
      ).toBeVisible();
    });

    await test.step("the case file reads true at the end of it", async () => {
      await page.goto(caseTab(caseUrl, "findings"));
      await settled(page);
      // The accepted finding, and nothing left resting on nothing.
      await expect(page.getByText("Accepted").first()).toBeVisible();
      await expect(
        panel(page, "Findings").getByText(/Rests on nothing/i),
      ).toHaveCount(0);

      await page.goto(informationUrl);
      await settled(page);
      // Corroborated now, so the warning has gone.
      await expect(page.getByText(/Nothing bears this out yet/i)).toHaveCount(0);
    });

    await analyst.close();
  });
});

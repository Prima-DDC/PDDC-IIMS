import { expect, test, type Locator } from "@playwright/test";
import { openApprovedCase } from "./case-fixture";
import { caseTab, openForm, panel, selectContaining, settled } from "./helpers";

/**
 * Evidence, chain of custody and case documents, through the real screens.
 *
 * Three people, because the rules being tested are about who may do what:
 *
 *   The **operations manager** opens the case and assigns the work. PRD 16
 *   gives them no evidence rights at all, which this proves rather than
 *   assumes.
 *   The **investigator** collects: registers the item, uploads its file,
 *   records the custody movements, takes the working copy, files the
 *   documents.
 *   The **administrator** is the second person: verifies the stored file
 *   against its declared hash, and approves the document version the
 *   investigator filed, because nobody approves their own work.
 *
 * What the journey proves, which is the product rather than the plumbing:
 *
 *   A file is hashed in the browser, and the item says "awaiting
 *   verification" until the *server* has read the stored object back and got
 *   the same answer. The two are different things and the screen never
 *   conflates them.
 *   An original with a file offers no second upload, because its bucket has
 *   no policy that could accept one.
 *   The custody ledger is append-only: a mistake is put right by a new entry
 *   that supersedes the original, both stay visible, and the chain of hashes
 *   is shown to hold rather than asserted to.
 *   A working copy carries the original's classification and its own
 *   collection record.
 *   An approved document version is locked, and the person who filed it
 *   cannot approve it.
 */

const stamp = String(Date.now()).slice(-8);
const CLIENT = `E2E Evidence Client ${stamp}`;
const CASE_TITLE = `E2E evidence journey ${stamp}`;
const DESCRIPTION = `Bank statement bundle ${stamp}, account 1234567, 14 pages`;

/** A file the browser can hash and the bucket will accept. */
const FILE = {
  name: `statement-${stamp}.txt`,
  mimeType: "text/plain",
  buffer: Buffer.from(
    `PDDC IIMS end-to-end fixture ${stamp}\nThis stands in for a scanned bank statement.\n`,
  ),
};

const DOCUMENT_FILE = {
  name: `interview-note-${stamp}.txt`,
  mimeType: "text/plain",
  buffer: Buffer.from(`Interview note, draft, run ${stamp}\n`),
};

const DOCUMENT_FILE_V2 = {
  name: `interview-note-${stamp}-v2.txt`,
  mimeType: "text/plain",
  buffer: Buffer.from(`Interview note, corrected, run ${stamp}\nAdded the second answer.\n`),
};

/**
 * Uploads through the real control and waits for the hash and the store.
 *
 * The component hashes the file in the browser before it sends it, so the
 * confirmation is the proof that both halves happened: a declared hash on
 * screen means WebCrypto ran, and the control only reaches that state after
 * the object is in the bucket.
 */
async function upload(
  scope: Locator,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  await scope.locator('input[type="file"]').setInputFiles(file);
  await expect(scope.getByText(/hash declared/i)).toBeVisible({ timeout: 60_000 });
}

test.describe("evidence, custody and documents, end to end", () => {
  // The same reason the other journeys give: every step depends on the one
  // before it, and this one also waits on real uploads to Supabase Storage.
  test.setTimeout(25 * 60 * 1000);

  test("from collection to a locked document version", async ({ page, browser }) => {
    const caseUrl = await openApprovedCase({
      page,
      browser,
      stamp,
      title: CASE_TITLE,
      clientName: CLIENT,
    });

    await test.step("the manager has no evidence rights at all", async () => {
      await page.goto(caseTab(caseUrl, "evidence"));
      await settled(page);

      // PRD 16 gives the Operations Manager case oversight, not evidence
      // handling. The tab is readable and offers nothing.
      const evidence = panel(page, "Evidence");
      await expect(evidence).toBeVisible();
      await expect(
        evidence.getByRole("button", { name: /register an item/i }),
      ).toHaveCount(0);
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
        .fill("Collecting and examining the financial records");
      await assignment.getByRole("button", { name: /^assign$/i }).click();

      await expect(
        assignment.locator("tr", { hasText: "E2E Investigator" }),
      ).toHaveCount(1);
    });

    /* ------------------------------------------- the investigator collects */

    const collector = await browser.newContext({
      storageState: "playwright/.auth/investigator.json",
    });
    const field = await collector.newPage();
    let itemUrl = "";

    try {
      await test.step("register what was collected", async () => {
        await field.goto(caseTab(caseUrl, "evidence"));
        await settled(field);

        const evidence = panel(field, "Evidence");
        await evidence.getByRole("button", { name: /register an item/i }).click();

        await evidence.locator("select#ev-type").selectOption("document");
        await evidence.locator("#ev-description").fill(DESCRIPTION);
        await evidence.locator("#ev-exhibit").fill(`A-${stamp.slice(-2)}`);
        await selectContaining(
          evidence.locator("select#ev-collected-by"),
          "E2E Investigator",
        );
        // Collected in the past, which the rule requires: evidence cannot be
        // collected in the future.
        await evidence
          .locator("#ev-collected-at")
          .fill(new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 16));
        await evidence
          .locator("#ev-location")
          .fill("The client's finance office, Accra");
        await evidence
          .locator("#ev-method")
          .fill("Handed over by the finance director and bagged on site");

        await evidence.getByRole("button", { name: /register the item/i }).click();
        await expect(
          evidence.getByText(/EV-\d{4}-\d{6}-\d{3} registered/i),
        ).toBeVisible();
      });

      await test.step("open the item, which starts with no file and one ledger entry", async () => {
        await field.goto(caseTab(caseUrl, "evidence"));
        await settled(field);
        await panel(field, "Evidence")
          .getByRole("link", { name: new RegExp(stamp) })
          .click();
        await field.waitForURL(/\/evidence\/[0-9a-f-]{36}/);
        itemUrl = field.url();

        // Registration is itself a custody event (PRD 6.2): an item whose
        // chain starts nowhere is an item nobody can rely on.
        const custody = panel(field, "Chain of custody");
        await expect(custody.getByText(/Chain intact across 1 entry/i)).toBeVisible();
        await expect(panel(field, "The file").getByText(/^No file$/i)).toBeVisible();
      });

      await test.step("upload the file, and the item says the hash is only declared", async () => {
        const file = panel(field, "The file");
        await upload(file, FILE);
        await file
          .getByRole("button", { name: /record the file against this item/i })
          .click();

        await expect(file.getByText(/awaiting verification/i).first()).toBeVisible();
        // The honest distinction, which is the whole point of PRD 6.3.
        await expect(
          file.getByText(/declared by the browser that uploaded it/i),
        ).toBeVisible();
      });

      await test.step("an original with a file offers no second upload", async () => {
        await field.goto(itemUrl);
        await settled(field);

        const file = panel(field, "The file");
        await expect(file.locator('input[type="file"]')).toHaveCount(0);
        await expect(
          file.getByText(/no policy that can change or remove an object/i),
        ).toBeVisible();
      });

      await test.step("record a movement, then correct it with a new entry", async () => {
        await field.goto(itemUrl);
        await settled(field);

        const custody = panel(field, "Chain of custody");
        await custody.getByRole("button", { name: /record a movement/i }).click();
        await custody.locator("select#custody-type").selectOption("transfer");
        await selectContaining(
          custody.locator("select#custody-released"),
          "E2E Investigator",
        );
        await selectContaining(
          custody.locator("select#custody-received"),
          "E2E Administrator",
        );
        await custody
          .locator("#custody-purpose")
          .fill("Taken to the evidence store for overnight safekeeping");
        await custody.locator("#custody-location").fill("Evidence store, room 4");
        await custody.getByRole("button", { name: /record the event/i }).click();
        await expect(custody.getByText(/Chain intact across 2 entries/i)).toBeVisible();

        // Putting it right: a new entry that supersedes the original, never a
        // change to it.
        await field.goto(itemUrl);
        await settled(field);
        const ledger = panel(field, "Chain of custody");
        await ledger.getByRole("button", { name: /correct the last entry/i }).click();
        await ledger
          .locator("#custody-correction-reason")
          .fill("The room was 6, not 4. Recorded from the store's own log.");
        await ledger.locator("select#custody-type").selectOption("transfer");
        await selectContaining(
          ledger.locator("select#custody-released"),
          "E2E Investigator",
        );
        await selectContaining(
          ledger.locator("select#custody-received"),
          "E2E Administrator",
        );
        await ledger
          .locator("#custody-purpose")
          .fill("Taken to the evidence store for overnight safekeeping");
        await ledger.locator("#custody-location").fill("Evidence store, room 6");
        await ledger.getByRole("button", { name: /record the correction/i }).click();

        await field.goto(itemUrl);
        await settled(field);
        const corrected = panel(field, "Chain of custody");
        await expect(corrected.getByText(/Chain intact across 3 entries/i)).toBeVisible();
        // Both stay visible, which is what makes the ledger worth anything.
        await expect(corrected.getByText(/Corrects an earlier entry/i)).toBeVisible();
        await expect(
          corrected.getByText(/Superseded by a later entry/i),
        ).toBeVisible();
        await expect(corrected.getByText(/room 4/i)).toBeVisible();
        await expect(corrected.getByText(/room 6/i)).toBeVisible();
        // And nothing anywhere offers to edit or delete one.
        await expect(
          corrected.getByRole("button", { name: /^(edit|delete)/i }),
        ).toHaveCount(0);
      });

      await test.step("take a working copy, which carries the original's classification", async () => {
        await field.goto(itemUrl);
        await settled(field);

        const copies = panel(field, "Working copies");
        await copies.getByRole("button", { name: /take a copy/i }).click();
        await copies
          .locator("#copy-description")
          .fill("Working copy for the forensic accountant's reconciliation");
        await copies
          .locator("#copy-method")
          .fill("Scanned to PDF, page count checked against the original");
        await copies.getByRole("button", { name: /take a working copy/i }).click();

        await expect(copies.getByText(/is a working copy of/i)).toBeVisible();

        await field.goto(itemUrl);
        await settled(field);
        await expect(
          panel(field, "Working copies").getByRole("link", {
            name: /forensic accountant/i,
          }),
        ).toBeVisible();
      });

      await test.step("file a document, which starts as a draft", async () => {
        await field.goto(caseTab(caseUrl, "documents"));
        await settled(field);

        const documents = panel(field, "Documents");
        await documents.getByRole("button", { name: /file a document/i }).click();
        await upload(documents, DOCUMENT_FILE);

        await documents
          .locator("#doc-title")
          .fill(`Interview note, finance director ${stamp}`);
        await documents.locator("select#doc-type").selectOption("interview_record");
        await documents.locator("#doc-tags").fill("interviews, finance");
        await documents
          .locator("#doc-note")
          .fill("As taken during the interview on the first day.");
        await documents.getByRole("button", { name: /file the document/i }).click();

        // The first version is always a draft: approving is a separate act by
        // somebody else (PRD 7.2).
        await expect(documents.getByText(/filed as v0\.1/i)).toBeVisible();
        await expect(
          documents.getByText(/other than you has to approve it/i),
        ).toBeVisible();
      });

      await test.step("the person who filed it cannot approve it", async () => {
        await field.goto(caseTab(caseUrl, "documents"));
        await settled(field);
        await panel(field, "Documents")
          .getByRole("link", { name: /Interview note, finance director/i })
          .click();
        await field.waitForURL(/\/documents\/[0-9a-f-]{36}/);

        await expect(
          panel(field, "Versions").getByText(/You filed this version/i),
        ).toBeVisible();
        await expect(
          panel(field, "Versions").getByRole("button", { name: /approve v0\.1/i }),
        ).toHaveCount(0);
      });

      await field.close();
    } finally {
      await collector.close();
    }

    /* ------------------------------------------ the administrator verifies */

    const admin = await browser.newContext({
      storageState: "playwright/.auth/admin.json",
    });
    const second = await admin.newPage();

    try {
      await test.step("the server reads the stored file back and the hashes agree", async () => {
        await second.goto(itemUrl);
        await settled(second);

        const file = panel(second, "The file");
        await file.getByRole("button", { name: /verify it now/i }).click();

        await expect(
          file.getByText(/matches the hash recorded when/i),
        ).toBeVisible({ timeout: 90_000 });

        // And the check itself is kept, with both hashes, as a permanent
        // record rather than a transient banner.
        await second.goto(itemUrl);
        await settled(second);
        const integrity = panel(second, "Integrity");
        await expect(integrity.getByText(/^Matched$/i).first()).toBeVisible();
        await expect(integrity.getByText(/expected/i).first()).toBeVisible();
      });

      await test.step("a second person approves the document, and it locks", async () => {
        await second.goto(caseTab(caseUrl, "documents"));
        await settled(second);
        await panel(second, "Documents")
          .getByRole("link", { name: /Interview note, finance director/i })
          .click();
        await second.waitForURL(/\/documents\/[0-9a-f-]{36}/);
        const documentUrl = second.url();

        const versions = panel(second, "Versions");
        second.once("dialog", (dialog) => dialog.accept());
        await versions.getByRole("button", { name: /approve v0\.1/i }).click();
        await expect(
          second.getByText(/v0\.1 approved and locked/i),
        ).toBeVisible();

        await second.goto(documentUrl);
        await settled(second);
        await expect(
          panel(second, "Versions").getByText(/Approved and locked/i),
        ).toBeVisible();
        // Nothing offers to approve it again.
        await expect(
          panel(second, "Versions").getByRole("button", { name: /approve v0\.1/i }),
        ).toHaveCount(0);
      });

      await test.step("a change is the next version, with a reason", async () => {
        await second.goto(caseTab(caseUrl, "documents"));
        await settled(second);
        await panel(second, "Documents")
          .getByRole("link", { name: /Interview note, finance director/i })
          .click();
        await second.waitForURL(/\/documents\/[0-9a-f-]{36}/);
        const documentUrl = second.url();

        const versions = panel(second, "Versions");
        await versions.getByRole("button", { name: /add a version/i }).click();
        await expect(
          versions.getByText(/is approved and locked, so it stays exactly as it is/i),
        ).toBeVisible();

        await upload(versions, DOCUMENT_FILE_V2);
        await versions
          .locator("#ver-note")
          .fill("The second answer was missing from the note as first typed up.");
        await versions.getByRole("button", { name: /add v0\.2/i }).click();
        await expect(
          second.getByText(/v0\.2 is now the current version/i),
        ).toBeVisible();

        await second.goto(documentUrl);
        await settled(second);
        // The approved version is still the one in force, and the screen says
        // so plainly: a report should cite v0.1, not the newer draft.
        await expect(
          second.getByText(/The approved version is not the latest one/i),
        ).toBeVisible();
        const history = panel(second, "Versions");
        await expect(history.getByText("v0.1")).toBeVisible();
        await expect(history.getByText("v0.2")).toBeVisible();
      });

      await second.close();
    } finally {
      await admin.close();
    }
  });
});

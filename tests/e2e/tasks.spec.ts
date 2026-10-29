import { expect, test } from "@playwright/test";
import { openApprovedCase } from "./case-fixture";
import { caseTab, panel, selectContaining, settled } from "./helpers";

/**
 * Tasks, the activity log and the investigation plan, driven through the real
 * interface as an operations manager.
 *
 * One test with steps, for the reason crm.spec.ts and cases.spec.ts both
 * record: every stage depends on the one before it, and a module-scoped
 * timestamp does not survive a Playwright worker restart.
 *
 * What the journey proves, which is the product rather than the plumbing:
 *
 *   A task cannot be moved to Blocked without saying what is blocking it, and
 *   the blocker is then visible to everybody else on the case.
 *   A parent task cannot be completed while a sub-task of it is still open.
 *   The status dropdown offers only the moves the machine permits, so a closed
 *   task cannot be reopened by picking a status out of a list.
 *   The activity log is append-only: the correction is a new entry pointing at
 *   the original, both stay visible, and nothing offers to edit an entry.
 *   An investigation plan cannot be approved by the person who submitted it.
 *   A removed task is recoverable, and says so on its own page.
 */

test.describe("permissions on the task screens", () => {
  test("the manager sees the task register with its summary counts", async ({
    page,
  }) => {
    await page.goto("/tasks");
    await settled(page);

    await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: /Assigned to me/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Blocked/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Unassigned/ })).toBeVisible();
  });

  test("the three views of PRD 9.2 are all reachable", async ({ page }) => {
    await page.goto("/tasks");
    await settled(page);

    const group = page.getByRole("group", { name: "Task view" });
    await expect(group.getByRole("button", { name: "List" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await group.getByRole("button", { name: "Board" }).click();
    await page.waitForURL(/view=board/);
    await expect(group.getByRole("button", { name: "Board" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The board's columns are the statuses, minus the cancelled one.
    await expect(page.getByRole("region", { name: "Not started" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Blocked" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Cancelled" })).toHaveCount(0);

    await group.getByRole("button", { name: "Calendar" }).click();
    await page.waitForURL(/view=calendar/);
    await expect(group.getByRole("button", { name: "Calendar" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

test.describe("the task and activity journey, end to end", () => {
  // Generous, and for a measured reason: seventeen steps, each a real
  // mutation plus the route refresh behind it, against a database 127ms away,
  // and the tabbed case file means a step navigates before it acts. The
  // journey reached its last two steps inside fifteen minutes, so the budget
  // is the thing that was wrong rather than the product.
  test.setTimeout(25 * 60 * 1000);

  test("from an empty case to an approved plan and a corrected log", async ({
    page,
    browser,
  }) => {
    const stamp = Date.now().toString().slice(-7);
    const TITLE = `E2E taskwork enquiry ${stamp}`;
    const TASK = `E2E obtain the bank statements ${stamp}`;
    const SUBTASK = `E2E request the mandate ${stamp}`;

    const caseUrl = await openApprovedCase({
      page,
      browser,
      stamp,
      title: TITLE,
      clientName: `E2E Taskwork Holdings ${stamp} Ltd`,
      priority: "medium",
    });

    let taskUrl = "";

    await test.step("the case starts with no work and no plan", async () => {
      // The case file is tabbed (PRD 18, screen 9) and each tab reads only
      // its own data, so a test looking for the work has to ask for it.
      await page.goto(caseTab(caseUrl, "tasks"));
      await settled(page);
      const work = panel(page, "Work");
      await expect(work).toBeVisible();
      await expect(work.getByText("No tasks match those filters")).toBeVisible();

      await page.goto(caseTab(caseUrl, "plan"));
      await expect(
        panel(page, "Investigation plan").getByText(/No plan yet/i),
      ).toBeVisible();
    });

    await test.step("add a task to the case", async () => {
      await page.goto(caseTab(caseUrl, "tasks"));
      const work = panel(page, "Work");
      await work.getByRole("button", { name: /add a task/i }).click();

      await work.locator("#task-title-new").fill(TASK);
      await selectContaining(
        work.locator("#task-assignee-new"),
        "E2E Operations Manager",
      );
      await work.locator("#task-priority-new").selectOption("high");
      await work.locator("#task-due-new").fill(dueInDays(14));
      await work
        .locator("#task-description-new")
        .fill("Statements for the twelve months to the end of the period.");
      await work.getByRole("button", { name: /add the task/i }).click();

      await expect(work.getByText(/TSK-\d{4}-\d{6} created/i)).toBeVisible();
    });

    await test.step("it is on the case, and on the cross-case register", async () => {
      await expect(panel(page, "Work").getByRole("link", { name: TASK })).toBeVisible();

      await page.goto(`/tasks?search=${encodeURIComponent(stamp)}`);
      await settled(page);
      await page.getByRole("link", { name: TASK }).click();
      await page.waitForURL(/\/tasks\/[0-9a-f-]{36}/);
      taskUrl = page.url();

      await expect(page.getByRole("heading", { name: TASK, level: 1 })).toBeVisible();
      await expect(page.getByText("Not started").first()).toBeVisible();
    });

    await test.step("Blocked without a reason is refused", async () => {
      const status = panel(page, "Where it has got to");
      await status.locator("select#task-status").selectOption("blocked");
      await status.getByRole("button", { name: /move the task/i }).click();

      // The domain rule is what refuses it, so the message is the rule's.
      await expect(
        status.getByText(/A blocker nobody wrote down cannot be cleared/i),
      ).toBeVisible();
    });

    await test.step("Blocked with a reason moves it, and the blocker is visible", async () => {
      const status = panel(page, "Where it has got to");
      await status.locator("select#task-status").selectOption("blocked");
      await status
        .locator("#task-status-reason")
        .fill("Waiting on the bank to acknowledge the mandate");
      await status.getByRole("button", { name: /move the task/i }).click();

      await expect(status.getByText(/is now blocked/i)).toBeVisible();

      await page.goto(taskUrl);
      await expect(
        page.getByText(/Blocked: Waiting on the bank to acknowledge the mandate/),
      ).toBeVisible();
    });

    await test.step("the dropdown offers only the moves the machine permits", async () => {
      // A blocked task cannot go straight to completed: the work has to be
      // unblocked first, which is what makes the blocked column meaningful.
      const options = await panel(page, "Where it has got to")
        .locator("select#task-status option")
        .allInnerTexts();
      expect(options.join(" ")).toContain("In progress");
      expect(options.join(" ")).not.toContain("Completed");
    });

    await test.step("unblock it, and reassign it with a reason", async () => {
      const status = panel(page, "Where it has got to");
      await status.locator("select#task-status").selectOption("in_progress");
      await status.getByRole("button", { name: /move the task/i }).click();
      await expect(status.getByText(/is now in progress/i)).toBeVisible();

      const reassign = panel(page, "Who is doing it");
      await selectContaining(reassign.locator("#reassign-user"), "E2E Investigator");
      await reassign.locator("#reassign-reason").fill("Handed to the case investigator");
      await reassign.getByRole("button", { name: /^reassign$/i }).click();
      await expect(reassign.getByText(/Reassigned to/i)).toBeVisible();
    });

    await test.step("a sub-task keeps the parent open until it is closed", async () => {
      await page.goto(caseTab(caseUrl, "tasks"));
      await settled(page);

      const work = panel(page, "Work");
      await work.getByRole("button", { name: /add a task/i }).click();
      await work.locator("#task-title-new").fill(SUBTASK);
      await selectContaining(work.locator("#task-parent-new"), TASK);
      await work.getByRole("button", { name: /add the task/i }).click();
      await expect(work.getByText(/TSK-\d{4}-\d{6} created/i)).toBeVisible();

      await page.goto(taskUrl);
      await expect(
        panel(page, "Sub-tasks").getByRole("link", { name: SUBTASK }),
      ).toBeVisible();

      const status = panel(page, "Where it has got to");
      await status.locator("select#task-status").selectOption("completed");
      await status.getByRole("button", { name: /move the task/i }).click();
      await expect(
        status.getByText(/has 1 open sub-task. Close it first/i),
      ).toBeVisible();
    });

    await test.step("a comment, and the author can remove their own", async () => {
      const comments = panel(page, "Comments");
      await comments.getByRole("button", { name: /add a comment/i }).click();
      await comments
        .locator("#comment-body")
        .fill("Mandate sent by courier, acknowledgement expected within five days.");
      await comments.getByRole("button", { name: /^post$/i }).click();

      await expect(comments.getByText(/Mandate sent by courier/)).toBeVisible();

      page.once("dialog", (dialog) => dialog.accept());
      await comments
        .locator("li")
        .filter({ hasText: "Mandate sent by courier" })
        .getByRole("button")
        .click();
      await expect(comments.getByText(/Mandate sent by courier/)).toHaveCount(0);
    });

    await test.step("record an activity against the task", async () => {
      await page.goto(caseTab(caseUrl, "activity"));
      await settled(page);

      const log = panel(page, "Activity log");
      await expect(log.getByText(/Nothing recorded yet/i)).toBeVisible();

      await log.getByRole("button", { name: /record an activity/i }).click();
      await log.locator("#activity-type").selectOption("document_review");
      await log
        .locator("#activity-description")
        .fill("Reviewed the three supplier invoices the client provided.");
      await log.locator("#activity-location").fill("PDDC Accra office");
      await selectContaining(log.locator("#activity-task"), TASK);
      await log.getByRole("button", { name: /record it/i }).click();

      await expect(log.getByText(/ACT-\d{4}-\d{6} recorded/i)).toBeVisible();
      await expect(log.getByText(/Reviewed the three supplier invoices/)).toBeVisible();
    });

    await test.step("the log is append-only: a correction is a new entry", async () => {
      await page.goto(caseTab(caseUrl, "activity"));
      await settled(page);

      const log = panel(page, "Activity log");
      await log.getByRole("button", { name: /correct this entry/i }).click();
      await log.locator("#correction-reason").fill("There were four invoices, not three");
      await log
        .locator("#correction-description")
        .fill("Reviewed the four supplier invoices the client provided.");
      await log.getByRole("button", { name: /record the correction/i }).click();

      await expect(log.getByText(/recorded as a correction of ACT-/i)).toBeVisible();

      await page.goto(caseTab(caseUrl, "activity"));
      await settled(page);
      const refreshed = panel(page, "Activity log");

      // Both entries are there: the correction says what it corrects, and the
      // original says it has been superseded. The original's text is intact.
      await expect(refreshed.getByText(/^Corrects ACT-\d{4}-\d{6}$/)).toBeVisible();
      await expect(
        refreshed.getByText(/^Superseded by ACT-\d{4}-\d{6}$/),
      ).toBeVisible();
      await expect(
        refreshed.getByText(/Reviewed the three supplier invoices/),
      ).toBeVisible();
      await expect(
        refreshed.getByText(/Reviewed the four supplier invoices/),
      ).toBeVisible();
      await expect(
        refreshed.getByText(/There were four invoices, not three/),
      ).toBeVisible();

      // Nothing offers to edit or delete an entry, because nothing can, and a
      // superseded entry cannot be corrected a second time: the correction
      // chain has one head. So exactly one entry offers the control.
      await expect(
        refreshed.getByRole("button", { name: /correct this entry/i }),
      ).toHaveCount(1);
    });

    await test.step("draft an investigation plan and submit it", async () => {
      await page.goto(caseTab(caseUrl, "plan"));
      const plan = panel(page, "Investigation plan");
      await plan
        .locator("#plan-objective")
        .fill("Establish whether the three payments were authorised, and by whom.");
      await plan
        .locator("#plan-methodology")
        .fill(
          "Reconcile the invoices to the bank statements, then interview the two approvers.",
        );
      await plan.locator("#source-0").fill("Companies registry");
      await plan.locator("#personnel-0").fill("Lead investigator");
      await plan.locator("#deliverable-0").fill("Written report with exhibits");
      await plan.getByRole("button", { name: /draft the plan/i }).click();

      // The durable effect, not the banner: drafting a plan replaces the
      // empty-state form with the version itself, so the confirmation the
      // create form showed is unmounted along with the form. What somebody
      // sees afterwards is the plan, which is the better confirmation.
      await expect(plan.getByText(/Version 1, Draft/i)).toBeVisible();
      await expect(
        plan.getByRole("button", { name: /submit for review/i }),
      ).toBeVisible();

      await page.goto(caseTab(caseUrl, "plan"));
      await settled(page);
      const drafted = panel(page, "Investigation plan");
      await drafted.getByRole("button", { name: /submit for review/i }).click();
      // The durable effect again: submitting replaces the author's edit form
      // with the submitted version awaiting somebody else, so the form's
      // banner goes with the form. The status is the confirmation.
      await expect(drafted.getByText(/Awaiting review/i).first()).toBeVisible();
    });

    await test.step("its author cannot review their own plan", async () => {
      await page.goto(caseTab(caseUrl, "plan"));
      await settled(page);

      const plan = panel(page, "Investigation plan");
      await expect(plan.getByText(/You submitted this version/i)).toBeVisible();
      await expect(plan.getByRole("button", { name: /approve the plan/i })).toHaveCount(
        0,
      );
    });

    await test.step("a second person approves it, and version 1 is in force", async () => {
      const context = await browser.newContext({
        storageState: "playwright/.auth/admin.json",
      });
      try {
        const approver = await context.newPage();
        // The plan lives on its own tab, so the approver has to land there as
        // well. Opening the case without it lands on the summary, where the
        // panel does not exist at all.
        await approver.goto(caseTab(caseUrl, "plan"));
        await settled(approver);

        const plan = panel(approver, "Investigation plan");
        await plan.locator("select#plan-decision").selectOption("approve");
        await plan.locator("#plan-notes").fill("Methodology is proportionate.");
        await plan.getByRole("button", { name: /approve the plan/i }).click();
        await expect(plan.getByText(/Version 1 approved/i).first()).toBeVisible();
        await approver.close();
      } finally {
        await context.close();
      }

      await page.goto(caseTab(caseUrl, "plan"));
      await settled(page);
      await expect(
        panel(page, "Investigation plan").getByText(/Version 1, in force/i),
      ).toBeVisible();
    });

    await test.step("the manager is not offered removal at all", async () => {
      await page.goto(taskUrl);
      await settled(page);

      // PRD 16 grants X on tasks to no role: work is retired by cancelling it
      // with a reason. So the manager, who holds tasks:edit, sees the status
      // form and no removal form. Offering one would hand them a button whose
      // result they could not then see, which is what migration 0032 records.
      await expect(panel(page, "Where it has got to")).toBeVisible();
      await expect(panel(page, "Remove this task")).toHaveCount(0);
    });

    await test.step("the administrator removes it, and it comes back", async () => {
      const context = await browser.newContext({
        storageState: "playwright/.auth/admin.json",
      });
      try {
        const admin = await context.newPage();
        await admin.goto(taskUrl);
        await settled(admin);

        const removal = panel(admin, "Remove this task");
        await removal
          .locator("#task-remove-reason")
          .fill("Raised against the wrong case");
        admin.once("dialog", (dialog) => dialog.accept());
        await removal.getByRole("button", { name: /remove this task/i }).click();

        // The removal form is only rendered while the task is live, so the
        // durable confirmation has to be the banner, not the form's own reply.
        await expect(admin.getByText(/Task removed/i).first()).toBeVisible();
        await expect(panel(admin, "Remove this task")).toHaveCount(0);

        // And it is in the recycle bin, which is the other half of a soft
        // delete being recoverable rather than merely reversible in theory.
        await admin.goto("/admin/recycle-bin");
        await settled(admin);
        await expect(
          admin.getByRole("link", { name: TASK }),
        ).toBeVisible();

        await admin.goto(taskUrl);
        admin.once("dialog", (dialog) => dialog.accept());
        await admin.getByRole("button", { name: /^restore$/i }).click();
        await expect(admin.getByText(/Task removed/i)).toHaveCount(0);
        await expect(panel(admin, "Remove this task")).toBeVisible();
        await admin.close();
      } finally {
        await context.close();
      }
    });

    await test.step("the task register filters by status", async () => {
      await page.goto(`/tasks?search=${encodeURIComponent(stamp)}&status=blocked`);
      await settled(page);
      // Nothing on this case is blocked any more, so the filter is doing work.
      await expect(page.getByText("No tasks match those filters")).toBeVisible();

      await page.goto(`/tasks?search=${encodeURIComponent(stamp)}`);
      await settled(page);
      await expect(page.getByRole("link", { name: TASK })).toBeVisible();
      await expect(page.getByRole("link", { name: SUBTASK })).toBeVisible();
    });
  });
});

/** A yyyy-mm-dd date `days` from today, as a date input needs it. */
function dueInDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

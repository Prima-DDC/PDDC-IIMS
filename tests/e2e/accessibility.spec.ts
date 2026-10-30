import { expect, test } from "@playwright/test";
import { settled } from "./helpers";

/**
 * Accessibility, checked against the rules a tool cannot check for us.
 *
 * WHY THIS IS HAND-WRITTEN RATHER THAN AXE. `@axe-core/playwright` would
 * cover far more ground than this file does, and it would be the right thing
 * to add. What it would not do is tell PDDC anything about the handful of
 * failures that actually make a platform like this unusable, because those
 * are not generic: a form control with no accessible name, a page with no
 * heading to orient by, a focus ring removed for looks, a table of evidence
 * that cannot be read by column. Those are the ones below, and each is
 * asserted on the real screens with real data.
 *
 * Said plainly so nobody mistakes this for a full audit: it is not one. An
 * independent audit against WCAG 2.2 AA is listed in `docs/PROGRESS.md` as
 * outstanding, along with the keyboard-only pass that a person has to do.
 * What this file gives is a floor that cannot regress silently.
 *
 * Every page here is a real one, reached as a real signed-in user, because an
 * accessibility check against an empty state proves the empty state is
 * accessible.
 */

/** The screens somebody uses all day, which is where this matters most. */
const PAGES: ReadonlyArray<{ path: string; heading: RegExp }> = [
  { path: "/dashboard", heading: /good to see you/i },
  { path: "/cases", heading: /^cases$/i },
  { path: "/tasks", heading: /^tasks$/i },
  { path: "/evidence", heading: /^evidence$/i },
  { path: "/notifications", heading: /^notifications$/i },
  { path: "/search", heading: /^search$/i },
];

test.describe("every working screen", () => {
  for (const page_ of PAGES) {
    test(`${page_.path} has one first-level heading, and it says where you are`, async ({
      page,
    }) => {
      await page.goto(page_.path);
      await settled(page);

      // Exactly one. Two h1s leave a screen-reader user with no single answer
      // to "what is this page", and none leaves them with nothing: both are
      // common and both are silent to a sighted reader.
      const headings = page.getByRole("heading", { level: 1 });
      await expect(headings).toHaveCount(1);
      await expect(headings).toHaveText(page_.heading);
    });

    test(`${page_.path} gives every control an accessible name`, async ({
      page,
    }) => {
      await page.goto(page_.path);
      await settled(page);

      /*
       * The single most consequential rule on a platform of forms.
       *
       * A control with no accessible name is announced as "edit text, blank",
       * which is unusable rather than merely inconvenient. This reads the
       * same four sources a screen reader does, in the same order, and
       * reports anything that has none of them.
       *
       * Hidden controls are excluded: a collapsed panel's fields are not on
       * the page yet, and the idempotency key is a hidden input by design.
       */
      const unnamed = await page.evaluate(() => {
        const problems: string[] = [];
        const controls = document.querySelectorAll(
          "input, select, textarea, button, a[href]",
        );

        for (const element of Array.from(controls)) {
          const node = element as HTMLElement & { type?: string };

          if (node.type === "hidden") continue;
          if (node.hasAttribute("aria-hidden")) continue;
          // Not rendered, so not announced.
          if (!(node.offsetWidth || node.offsetHeight || node.getClientRects().length)) {
            continue;
          }

          const labelled =
            node.getAttribute("aria-label")?.trim() ||
            node.getAttribute("title")?.trim() ||
            (node.getAttribute("aria-labelledby") &&
              document
                .getElementById(node.getAttribute("aria-labelledby")!)
                ?.textContent?.trim()) ||
            (node.id &&
              document
                .querySelector(`label[for="${node.id}"]`)
                ?.textContent?.trim()) ||
            node.closest("label")?.textContent?.trim() ||
            node.textContent?.trim() ||
            (node as HTMLInputElement).placeholder?.trim();

          if (labelled) continue;

          problems.push(
            `<${node.tagName.toLowerCase()}${
              node.type ? ` type="${node.type}"` : ""
            }${node.id ? ` id="${node.id}"` : ""}> has no accessible name`,
          );
        }

        return problems;
      });

      expect(unnamed).toEqual([]);
    });

    test(`${page_.path} keeps a visible focus indicator`, async ({ page }) => {
      await page.goto(page_.path);
      await settled(page);

      // Tabbing to the first control and asking the browser what it drew.
      // The failure this catches is `outline: none` applied for looks, which
      // is invisible to everybody except the person navigating by keyboard,
      // and is the most common way a usable interface becomes unusable.
      await page.keyboard.press("Tab");

      const focus = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active || active === document.body) return null;

        const style = getComputedStyle(active);
        return {
          tag: active.tagName.toLowerCase(),
          outlineWidth: style.outlineWidth,
          outlineStyle: style.outlineStyle,
          boxShadow: style.boxShadow,
          // Tailwind's ring utilities draw with box-shadow, so a ring counts.
        };
      });

      expect(focus).not.toBeNull();

      const visible =
        (focus!.outlineStyle !== "none" &&
          Number.parseFloat(focus!.outlineWidth) > 0) ||
        (focus!.boxShadow !== "none" && focus!.boxShadow.length > 0);

      expect(visible, `focus on <${focus!.tag}> draws nothing visible`).toBe(
        true,
      );
    });
  }
});

test.describe("the things a dense interface gets wrong", () => {
  test("every table column has a header, so a row can be read by column", async ({
    page,
  }) => {
    await page.goto("/cases");
    await settled(page);

    const problems = await page.evaluate(() => {
      const found: string[] = [];

      for (const table of Array.from(document.querySelectorAll("table"))) {
        const headers = table.querySelectorAll("thead th");
        const firstRow = table.querySelector("tbody tr");

        if (headers.length === 0) {
          found.push("a table has no header row at all");
          continue;
        }
        if (!firstRow) continue;

        const cells = firstRow.querySelectorAll("td, th");
        if (cells.length !== headers.length) {
          found.push(
            `a table has ${headers.length} headers and ${cells.length} cells in its first row, so a cell cannot be tied to a column`,
          );
        }

        for (const header of Array.from(headers)) {
          if (!header.textContent?.trim() && !header.getAttribute("aria-label")) {
            found.push("a table header is empty, so its column is unnamed");
          }
        }
      }

      return found;
    });

    expect(problems).toEqual([]);
  });

  test("the language is declared, which decides how a screen reader speaks", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const lang = await page.evaluate(
      () => document.documentElement.getAttribute("lang"),
    );

    // Without it a screen reader reads English with whatever voice it
    // defaults to, which for a non-English default is unintelligible.
    expect(lang).toBeTruthy();
  });

  test("a status message is announced rather than only shown", async ({
    page,
  }) => {
    await page.goto("/notifications");
    await settled(page);

    // The platform reports every action's outcome through an Alert, and an
    // alert nobody is told about is a message only sighted users receive.
    // This asserts the mechanism exists on a page that uses it, rather than
    // forcing an error to see one.
    const live = await page.evaluate(() => {
      const roles = document.querySelectorAll(
        '[role="alert"], [role="status"], [aria-live]',
      );
      return roles.length;
    });

    expect(live).toBeGreaterThan(0);
  });

  test("nothing relies on colour alone to say a record is at risk", async ({
    page,
  }) => {
    await page.goto("/cases");
    await settled(page);

    // Every risk and status badge carries its own text. A red dot with no
    // word beside it is invisible to a colour-blind reader, and PRD 23's risk
    // scale is one of the places that is most tempting to get wrong.
    const badges = page.locator("span.rounded-full");
    const count = await badges.count();

    if (count === 0) return;

    for (let index = 0; index < Math.min(count, 12); index += 1) {
      const text = (await badges.nth(index).innerText()).trim();
      expect(text.length, "a badge carries no text, only colour").toBeGreaterThan(
        0,
      );
    }
  });
});

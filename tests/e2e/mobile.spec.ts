import { expect, test } from "@playwright/test";
import { settled } from "./helpers";

/**
 * Mobile and tablet behaviour, on a real phone viewport.
 *
 * The bottom navigation bar only exists below the md breakpoint, so a desktop
 * run would never see it. This project runs against the Pixel 7 device
 * profile.
 */

test.describe("bottom navigation", () => {
  // The project supplies a stored administrator session, so there is no
  // sign-in to do here.
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard");
    await settled(page);
  });

  test("the bottom bar is present and the side navigation is not", async ({ page }) => {
    const bottomNav = page.getByRole("navigation", { name: "Primary" });
    await expect(bottomNav).toBeVisible();

    // The desktop side navigation is hidden below md.
    await expect(page.getByRole("navigation", { name: "Sections" })).toBeHidden();
  });

  test("it offers no more than five primary destinations plus More", async ({ page }) => {
    const bottomNav = page.getByRole("navigation", { name: "Primary" });

    // Five is the most that stays thumb-reachable at phone width without the
    // labels truncating.
    const links = bottomNav.getByRole("link");
    const count = await links.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(5);

    await expect(bottomNav.getByRole("button", { name: /more/i })).toBeVisible();
  });

  test("tapping a destination navigates and marks itself current", async ({ page }) => {
    const bottomNav = page.getByRole("navigation", { name: "Primary" });

    await bottomNav.getByRole("link", { name: /cases/i }).click();
    await expect(page).toHaveURL(/\/cases/);

    await expect(
      bottomNav.getByRole("link", { name: /cases/i }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("the More sheet opens, lists the rest and closes on Escape", async ({ page }) => {
    const bottomNav = page.getByRole("navigation", { name: "Primary" });
    const more = bottomNav.getByRole("button", { name: /more/i });

    await more.click();

    const sheet = page.getByRole("dialog", { name: /more destinations/i });
    await expect(sheet).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "true");

    // Administration is a secondary destination, so it lives in the sheet.
    await expect(sheet.getByRole("link", { name: /administration/i })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("a destination in the More sheet navigates and closes the sheet", async ({ page }) => {
    const bottomNav = page.getByRole("navigation", { name: "Primary" });
    await bottomNav.getByRole("button", { name: /more/i }).click();

    const sheet = page.getByRole("dialog", { name: /more destinations/i });
    await sheet.getByRole("link", { name: /administration/i }).click();

    await expect(page).toHaveURL(/\/admin/);
    await expect(sheet).toBeHidden();
  });

  test("content clears the bar rather than sitting under it", async ({ page }) => {
    const bottomNav = page.getByRole("navigation", { name: "Primary" });
    const navBox = await bottomNav.boundingBox();
    expect(navBox).not.toBeNull();

    // `main` is a scrollable region whose box legitimately extends past the
    // viewport, so comparing boxes proves nothing. What matters is that it
    // reserves at least the bar's height below the last content, which is
    // what the mb-bottom-nav utility does.
    const reserved = await page.locator("main").evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).marginBottom),
    );
    expect(reserved).toBeGreaterThanOrEqual(navBox!.height);

    // And the final element is reachable once scrolled to the bottom.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const last = page.locator("main > div > *").last();
    const lastBox = await last.boundingBox();
    if (lastBox) {
      expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(navBox!.y + 2);
    }
  });

  test("there is no horizontal scrolling at phone width", async ({ page }) => {
    for (const path of ["/dashboard", "/admin", "/admin/users"]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} should not scroll sideways`).toBeLessThanOrEqual(1);
    }
  });

  test("touch targets on the bar are large enough", async ({ page }) => {
    const bottomNav = page.getByRole("navigation", { name: "Primary" });
    const links = bottomNav.getByRole("link");

    for (let i = 0; i < (await links.count()); i += 1) {
      const box = await links.nth(i).boundingBox();
      expect(box).not.toBeNull();
      // Comfortably above the 44px guideline.
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("mobile layout", () => {
  test("the dashboard is readable and the account menu works", async ({ page }) => {
    await page.goto("/dashboard");
    await settled(page);

    await expect(page.getByRole("heading", { name: /good to see you/i })).toBeVisible();

    // The account menu is reachable on a phone, where the name is collapsed.
    await page.locator("header button").last().click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /^sign out$/i })).toBeVisible();
  });

  test("a dense table scrolls inside its own container", async ({ page }) => {
    await page.goto("/admin/users");

    // The table is wider than a phone, so it scrolls in its wrapper rather
    // than pushing the page sideways.
    const scroller = page.locator("main .overflow-x-auto").first();
    await expect(scroller).toBeVisible();
  });
});

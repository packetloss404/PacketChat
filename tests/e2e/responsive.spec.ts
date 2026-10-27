import { type Page } from "@playwright/test";
import { expectClean, expect, test, watchPage } from "./support";

async function horizontalOverflow(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
}

for (const width of [390, 430, 768, 960, 1200, 1440]) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    const problems = watchPage(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/chat");
    await expect(page.locator("main#main-content")).toBeVisible();

    const { scrollWidth, clientWidth } = await horizontalOverflow(page);
    expect(scrollWidth, `document scrollWidth ${scrollWidth} exceeds viewport ${clientWidth}`).toBeLessThanOrEqual(clientWidth);

    expectClean(problems);
  });
}

test("the left rail collapses to a mobile overlay below 720px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chat");

  await expect(page.locator(".lr__nav").first()).toBeHidden();
  const toggle = page.getByRole("button", { name: "Open navigation" });
  await expect(toggle).toBeVisible();

  await toggle.click();
  await expect(page.locator(".app")).toHaveAttribute("data-mobilenav", "open");
  await expect(page.locator(".lr__nav").first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".app")).toHaveAttribute("data-mobilenav", "closed");
});

test("the left rail is docked at desktop widths", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/chat");

  await expect(page.locator(".lr__nav").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();
});

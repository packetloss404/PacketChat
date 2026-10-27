import { expectClean, expect, test, watchPage } from "./support";

test("chat renders the composer and applies the stored composer font size", async ({ page }) => {
  const problems = watchPage(page);

  await page.goto("/settings");
  await page.getByRole("tab", { name: /General/i }).click();
  await page.getByLabel("Composer font size").fill("16");

  await page.goto("/chat");
  const composer = page.locator("form.composer");
  await expect(composer).toBeVisible();
  await expect(page.getByPlaceholder(/Ask anything|Message /)).toBeVisible();

  const fontSize = await composer.evaluate((node) => getComputedStyle(node).getPropertyValue("--composer-font-size").trim());
  expect(fontSize).toBe("16px");

  expectClean(problems);
});

test("general preferences persist across a reload", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("tab", { name: /General/i }).click();

  const sendOnEnter = page.getByRole("switch", { name: "Send on Enter" });
  await expect(sendOnEnter).toBeChecked();
  await sendOnEnter.click();
  await expect(sendOnEnter).not.toBeChecked();

  const stored = await page.evaluate(() => window.localStorage.getItem("packetchat.settings.general.sendOnEnter"));
  expect(stored).toBe("0");

  await page.reload();
  await page.getByRole("tab", { name: /General/i }).click();
  await expect(page.getByRole("switch", { name: "Send on Enter" })).not.toBeChecked();
});

test("theme choice persists and applies before paint", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("tab", { name: /Appearance/i }).click();
  await page.getByRole("radio", { name: "Light" }).check();

  await expect(page.locator("html")).toHaveClass(/light/);
  const stored = await page.evaluate(() => window.localStorage.getItem("packetchat.settings.appearance.theme"));
  expect(stored).toBe("light");

  await page.reload();
  // The pre-hydration script applies the class from localStorage before React mounts.
  await expect(page.locator("html")).toHaveClass(/light/);
});

test("the account popover exposes exactly the documented entries", async ({ page }) => {
  const problems = watchPage(page);
  await page.goto("/chat");

  await page.locator(".lr__user").click();
  const menu = page.getByRole("menu", { name: "Account menu" });
  await expect(menu).toBeVisible();

  await expect(menu.getByRole("menuitem", { name: "Change password" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "API Keys" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "GitHub" })).toHaveAttribute("href", "https://github.com/packetloss404");
  await expect(menu.getByRole("button", { name: "Toggle theme" })).toBeVisible();

  await menu.getByRole("menuitem", { name: "Change password" }).click();
  await expect(page.getByRole("dialog", { name: "Change password" })).toBeVisible();
  await page.getByRole("dialog", { name: "Change password" }).getByRole("button", { name: "Close" }).click();

  expectClean(problems);
});

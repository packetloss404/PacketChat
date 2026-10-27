import { expectClean, expect, test, watchPage } from "./support";

const routes: Array<{ path: string; nav: string }> = [
  { path: "/chat", nav: "Chats" },
  { path: "/agents", nav: "Agents" },
  { path: "/prompts", nav: "Prompts" },
  { path: "/knowledge", nav: "Knowledge" },
  { path: "/providers", nav: "Models" },
  { path: "/projects", nav: "Projects" },
  { path: "/approvals", nav: "Approvals" },
  { path: "/admin/users", nav: "Users" },
  { path: "/admin/providers", nav: "Providers" },
  { path: "/admin/usage", nav: "Usage" },
  { path: "/admin/audit", nav: "Audit" },
  { path: "/admin/operations", nav: "Operations" }
];

for (const route of routes) {
  test(`renders ${route.path} without client or server errors`, async ({ page }) => {
    const problems = watchPage(page);

    const response = await page.goto(route.path);
    expect(response?.status(), `HTTP status for ${route.path}`).toBeLessThan(400);

    await expect(page.locator("main#main-content")).toBeVisible();
    await expect(page.locator(`.lr__nav a:has-text("${route.nav}")`).first()).toBeVisible();

    expectClean(problems);
  });
}

test("/ redirects to /chat", async ({ page }) => {
  const problems = watchPage(page);

  await page.goto("/");
  await expect(page).toHaveURL(/\/chat(\?|$)/);
  await expect(page.locator("main#main-content")).toBeVisible();

  expectClean(problems);
});

test("/settings shows the account, API-key, and preferences sections", async ({ page }) => {
  const problems = watchPage(page);

  await page.goto("/settings");
  await expect(page.locator("main#main-content")).toBeVisible();
  const rail = page.getByRole("tablist", { name: "Settings sections" });
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("tab", { name: /General/i })).toBeVisible();
  await expect(rail.getByRole("tab", { name: /Appearance/i })).toBeVisible();
  await expect(rail.getByRole("tab", { name: /API Keys/i })).toBeVisible();

  expectClean(problems);
});

test("/admin/approvals shortcut lands on the approvals queue", async ({ page }) => {
  const problems = watchPage(page);

  await page.goto("/admin/approvals");
  await expect(page).toHaveURL(/\/approvals(\?|$)/);

  expectClean(problems);
});

test("an unknown route renders the themed not-found surface", async ({ page }) => {
  const response = await page.goto("/this-route-does-not-exist-xyz");
  expect(response?.status()).toBe(404);
  await expect(page.getByText(/not found/i).first()).toBeVisible();
});

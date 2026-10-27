import { anonymous as test, expect, expectClean, watchPage } from "./support";

// Anonymous coverage: the `anonymous` fixture opens a context with no session cookie.
test("the login page renders the sign-in form without console errors", async ({ page }) => {
  const problems = watchPage(page);

  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /Sign in to PacketChat/i })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  // A signed-out visitor must not provoke a background refresh call that logs a
  // 403 to the console; expectClean fails on any unexpected console error.
  await page.waitForLoadState("networkidle");
  expectClean(problems);
});

test("a protected route redirects an anonymous visitor to /login", async ({ page }) => {
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/login/);
});

test("anonymous API calls are rejected with 401", async ({ request }) => {
  const response = await request.get("/api/projects");
  expect(response.status()).toBe(401);
});

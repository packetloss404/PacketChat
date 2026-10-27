import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

export const baseURL = process.env.PACKETCHAT_BASE_URL || process.env.APP_BASE_URL || "http://localhost:3000";

export function e2eCredentials() {
  const email = process.env.PACKETCHAT_E2E_EMAIL || process.env.PACKETCHAT_SMOKE_EMAIL;
  const password = process.env.PACKETCHAT_E2E_PASSWORD || process.env.PACKETCHAT_SMOKE_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Browser tests need an admin account. Set PACKETCHAT_E2E_EMAIL and PACKETCHAT_E2E_PASSWORD (or PACKETCHAT_SMOKE_EMAIL / PACKETCHAT_SMOKE_PASSWORD)."
    );
  }
  return { email, password };
}

// PacketChat rotates the refresh token and revokes the whole family on reuse, so
// a shared storageState is invalidated by the first test that refreshes it.
// Instead each worker logs in once and reuses one context: every page load
// refreshes against the newest cookie in the jar, and no old token is replayed.
// A per-tab init script clears localStorage on a page's first navigation so
// tests stay independent while an in-test reload still sees what the test set.
const CLEARED_FLAG = "__packetchat_e2e_localStorage_cleared";

export const test = base.extend<{ page: Page }, { authContext: BrowserContext }>({
  authContext: [
    async ({ browser }, use) => {
      const { email, password } = e2eCredentials();
      const context = await browser.newContext({ baseURL });
      const login = await context.request.post("/api/auth/login", { data: { email, password } });
      if (!login.ok()) {
        throw new Error(`E2E login failed: ${login.status()} ${await login.text()}`);
      }
      await use(context);
      await context.close();
    },
    { scope: "worker" }
  ],
  page: async ({ authContext }, use) => {
    const page = await authContext.newPage();
    await page.addInitScript((flag) => {
      try {
        if (!window.sessionStorage.getItem(flag)) {
          window.localStorage.clear();
          window.sessionStorage.setItem(flag, "1");
        }
      } catch {
        // Storage can be unavailable in a locked-down context; nothing to clear.
      }
    }, CLEARED_FLAG);
    try {
      await use(page);
    } finally {
      await page.close();
    }
  }
});

/** Anonymous fixture: a plain context with no session cookie. */
export const anonymous = base;

export type PageProblems = {
  consoleErrors: string[];
  pageErrors: string[];
  serverErrors: string[];
};

// A missing favicon and a deliberate anonymous 401/403/404 probe are not defects.
const IGNORABLE_CONSOLE = [
  /favicon/i,
  /Failed to load resource: the server responded with a status of 40[134]/i
];

/** Records console errors, uncaught page errors, and same-origin 5xx responses. */
export function watchPage(page: Page): PageProblems {
  const problems: PageProblems = { consoleErrors: [], pageErrors: [], serverErrors: [] };

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (IGNORABLE_CONSOLE.some((pattern) => pattern.test(text))) return;
    problems.consoleErrors.push(text);
  });

  page.on("pageerror", (error) => problems.pageErrors.push(error.message));

  page.on("response", (response) => {
    if (response.status() < 500) return;
    if (!response.url().startsWith(baseURL)) return;
    problems.serverErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });

  return problems;
}

export function expectClean(problems: PageProblems) {
  expect(problems.pageErrors, `uncaught page errors: ${problems.pageErrors.join(" | ")}`).toEqual([]);
  expect(problems.serverErrors, `same-origin 5xx responses: ${problems.serverErrors.join(" | ")}`).toEqual([]);
  expect(problems.consoleErrors, `console errors: ${problems.consoleErrors.join(" | ")}`).toEqual([]);
}

export { expect };

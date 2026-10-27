import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests run against an already-started PacketChat stack. Point them at a
 * different host with PACKETCHAT_BASE_URL and supply admin credentials with
 * PACKETCHAT_E2E_EMAIL / PACKETCHAT_E2E_PASSWORD (PACKETCHAT_SMOKE_* also work).
 *
 * They are not part of `npm run verify` because they need a live stack; run them
 * with `npm run test:e2e` after `npm run compose:up` and `npm run compose:migrate`.
 */
const baseURL = process.env.PACKETCHAT_BASE_URL || process.env.APP_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off"
  },
  projects: [
    {
      name: "chromium",
      testMatch: /.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});

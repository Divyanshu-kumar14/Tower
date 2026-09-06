import { defineConfig, devices } from "@playwright/test";

/**
 * T-10 local E2E config — mocked network, no backend required.
 *
 * Extends `frontend/playwright.config.ts` without touching it: same webServer
 * (Next.js dev on :3000, SSE heartbeat ready-check) so existing specs keep
 * passing. Run from the repo root:
 * `npx playwright test --config tests/e2e/playwright.config.ts`
 */
export default defineConfig({
  testDir: ".",
  timeout: 30 * 1000,
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/api/stream",
    reuseExistingServer: true,
    timeout: 120 * 1000,
    cwd: "../frontend",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

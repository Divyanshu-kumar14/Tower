import { defineConfig, devices } from "@playwright/test";

/**
 * TOWER Playwright config (T-07).
 * Serves the Next.js frontend locally; specs live in `./e2e`.
 * NOTE: `requestbar.spec.ts` self-skips when the T-08 radar page is not
 * mounted yet (the transmit console owns no route until page assembly).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30 * 1000,
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    /* `/` is 404 until T-08 mounts the radar page (Playwright only accepts
       2xx/3xx/400-403 as ready) — poll the always-200 SSE heartbeat instead. */
    url: "http://localhost:3000/api/stream",
    reuseExistingServer: true,
    timeout: 120 * 1000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

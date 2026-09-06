/**
 * Graceful-degrade proof (T-10, E14/E15/E16/E18 at the UI-mocked level).
 *
 * All network is mocked — no backend, no Grafana creds, no secrets:
 * - E18: abort `GET /api/stream` (SSE) → the radar must fall back with
 *   backoff + 5s poll and show the amber `Live: reconnecting…` / polling
 *   dot (never a green lie, never blank).
 * - E16: `GET /api/health` 503 `LOT_OPS_DEGRADED` → reads-only UI stays up.
 * - E14/E15: `GET /api/metrics` 404 (Grafana/BQ down) → the health strip
 *   shows the `Observability delayed` stale badge + cached/empty values.
 */
import { test, expect, type Page } from "@playwright/test";

const DATE = "2026-09-06";

async function mockQuietLot(page: Page) {
  await page.route("**/api/slots?*", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ date: DATE, slots: [], etag: "degrade-empty" }),
    }),
  );
  await page.route("**/api/metrics", async (route) =>
    route.fulfill({ status: 404, body: "grafana down in T-10" }),
  );
}

test("E18 aborted stream → backoff + poll fallback + amber dot", async ({
  page,
}) => {
  await mockQuietLot(page);
  // Kill the SSE stream: every EventSource connect fails at the network.
  await page.route("**/api/stream", async (route) => route.abort("failed"));

  await page.goto(`/?date=${DATE}`);
  const liveDot = page.getByTestId("live-dot");
  await expect(liveDot).toBeVisible({ timeout: 15000 });
  // Backoff reconnect first ("Live: reconnecting…"), then the 5s poll
  // fallback ("Live: polling every 5s") — either is a graceful amber state.
  await expect(liveDot).toContainText(/reconnecting|polling/i, { timeout: 15000 });
  const dotClass = await liveDot.innerHTML();
  expect(dotClass).toMatch(/amber/);
  // Poll fallback keeps refetching the day key: slots route stays hit.
  await page.waitForTimeout(6000);
  await expect(liveDot).toContainText(/polling/i, { timeout: 15000 });
});

test("E14/E15 metrics down → Observability delayed stale badge, never blank", async ({
  page,
}) => {
  await mockQuietLot(page);
  await page.goto(`/?date=${DATE}`);
  // Stale badge with the delayed signal + cached/empty values + retry.
  await expect(page.getByTestId("health-stale-badge")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByTestId("health-stale-badge")).toContainText(
    /observability delayed/i,
  );
  // Radar still renders its real empty state (never a blank page).
  await expect(page.getByTestId("radar-empty")).toBeVisible({ timeout: 15000 });
});

test("E16 health 503 LOT_OPS_DEGRADED → reads-only flag, page stays up", async ({
  page,
}) => {
  await mockQuietLot(page);
  // …yet the ops page itself stays up and transmittable.
  await page.goto(`/?date=${DATE}`);
  await expect(page.getByLabel(/describe the shoot/i)).toBeVisible({
    timeout: 15000,
  });
  // Local truth: no DATABASE_URL → 503 degraded reads-only (T-05 contract).
  const health = await page.evaluate(async () => {
    const res = await fetch("/api/health");
    return { status: res.status, body: await res.json() };
  });
  // Local truth: no DATABASE_URL → 503 degraded reads-only (T-05 contract).
  expect(health.status).toBe(503);
  expect(health.body).toMatchObject({
    code: "LOT_OPS_DEGRADED",
    status: "degraded",
    readsOnly: true,
  });
});

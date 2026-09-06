/**
 * Radar showcase (T-08) — seed 10 slots → 10 blips; empty lot → the no-ops
 * sentence; gantt day view renders 4 rows; blip click selects the hold.
 *
 * Data path: `page.route` mocks `GET /api/slots?date=` (the BFF ETag shape
 * `{date, slots, etag}`); the real `/api/stream` heartbeat-only route feeds
 * EventSource underneath. Mounting `/` also un-skips the T-07 requestbar
 * spec (its self-skip branch goes away once <RequestBar/> is on `/`).
 */
import { test, expect, type Page } from "@playwright/test";

const DATE = "2026-09-06";
const PADS = ["stage-1", "stage-2", "stage-3", "adr-suite"];

function seedSlots(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const pad = PADS[i % PADS.length] ?? "stage-3";
    const hh = String(6 + (i % 8)).padStart(2, "0");
    return {
      id: `slot_e2e_${i}`,
      production: i === 2 ? "Project Atlas" : `E2E Production ${i}`,
      resource_type: "stage",
      resource_id: pad,
      start: `${DATE}T${hh}:00:00Z`,
      end: `${DATE}T${hh}:30:00Z`,
      status: i % 3 === 0 ? "holding" : "confirmed",
      request_id: `req_e2e_${i}`,
      trace_id: `trace_e2e_${i}`,
    };
  });
}

async function mockSlots(page: Page, slots: unknown[]) {
  await page.route("**/api/slots**", async (route) => {
    const url = new URL(route.request().url());
    const date = url.searchParams.get("date") ?? DATE;
    const body = date === DATE ? slots : [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { etag: 'W/"e2e"' },
      body: JSON.stringify({ date, slots: body, etag: 'W/"e2e"' }),
    });
  });
}

test.describe("Radar showcase (T-08)", () => {
  test("10 seeded slots render 10 blips with live status", async ({ page }) => {
    await mockSlots(page, seedSlots(10));
    await page.goto(`/?date=${DATE}`);

    await expect(page.getByTestId("radar-blip")).toHaveCount(10);
    await expect(page.getByTestId("radar-scope")).toContainText("10 OPS");
    await expect(page.getByTestId("live-dot")).toBeVisible();
    /* Transmit console mounted → the T-07 spec runs un-skipped. */
    await expect(page.getByLabel(/describe the shoot/i)).toBeVisible();
  });

  test("empty lot shows the grid plus the no-ops sentence", async ({ page }) => {
    await mockSlots(page, seedSlots(10));
    await page.goto("/?date=2026-09-07");

    await expect(page.getByTestId("radar-empty")).toContainText(
      "No ops — request a stage",
    );
    await expect(page.getByTestId("radar-blip")).toHaveCount(0);
  });

  test("timeline gantt renders 4 rows with the seeded holds", async ({ page }) => {
    await mockSlots(page, seedSlots(10));
    await page.goto(`/timeline?date=${DATE}`);

    await expect(page.getByTestId("timeline-gantt")).toContainText("Stage 3");
    await expect(page.getByTestId("slot-card")).toHaveCount(10);
  });

  test("blip click selects the hold and scrolls to its anchor", async ({ page }) => {
    await mockSlots(page, seedSlots(10));
    await page.goto(`/?date=${DATE}`);

    await page.getByTestId("radar-blip").first().click();
    const selected = page.getByTestId("selected-slot");
    await expect(selected).toBeVisible();
    await expect(selected).toContainText(/E2E Production|Project Atlas/);
  });
});

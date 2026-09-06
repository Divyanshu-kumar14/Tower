/**
 * Conflict resolution showcase (T-09) — the 60s demo click path.
 *
 * Mocks:
 * - `POST /api/requests` → Sep 6 Atlas conflict + Stage-2-first alternative
 *   (PRD §7.4 shape, Stage-2-first ordering preserved from the API).
 * - `POST /api/reroute` → mocked 200 `{status:"confirmed", traceId}`.
 * - `GET /api/metrics` → 404 (backend-owned T-11) so the health spec asserts
 *   the Grafana-down stale badge instead of live KPIs.
 * - `GET /api/slots?date=` → seeded holds (radar renders blips underneath).
 *
 * Flow: transmit → drawer lists Stage 2 → `Reroute & Hold` → emerald
 * confirmation + traceId shown.
 */
import { test, expect, type Page } from "@playwright/test";

const DATE = "2026-09-06";

const CANNED_PARSE = {
  requestId: "req_demo",
  parsed: {
    slots: [
      {
        resource_type: "stage",
        resource_id: "stage-3",
        start: `${DATE}T06:00:00Z`,
        end: `${DATE}T18:00:00Z`,
      },
      {
        resource_type: "gear",
        resource_id: "alexa-65",
        start: `${DATE}T06:00:00Z`,
        end: `${DATE}T18:00:00Z`,
      },
    ],
    confidence: 0.92,
  },
  collision: {
    hasConflict: true,
    conflicts: [
      { resource_id: "stage-3", overlap: "08:00-10:00", blockedBy: "req_atlas" },
    ],
    alternatives: [
      {
        slot: {
          resource_id: "stage-2",
          start: `${DATE}T06:00:00Z`,
          end: `${DATE}T18:00:00Z`,
        },
        score: 0.95,
        reason: "Same size, free",
      },
      {
        slot: {
          resource_id: "stage-3",
          start: `${DATE}T18:00:00Z`,
          end: `${DATE}T20:00:00Z`,
        },
        score: 0.7,
        reason: "Same stage, later window",
      },
    ],
  },
  traceId: "trace_parse_demo",
};

const SEEDED_SLOTS = [
  {
    id: "slot_atlas",
    production: "Project Atlas",
    resource_type: "stage",
    resource_id: "stage-3",
    start: `${DATE}T08:00:00Z`,
    end: `${DATE}T10:00:00Z`,
    status: "confirmed",
    request_id: "req_atlas",
    trace_id: "trace_atlas",
  },
];

async function mockApi(page: Page) {
  await page.route("**/api/slots**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { etag: 'W/"conflict-e2e"' },
      body: JSON.stringify({ date: DATE, slots: SEEDED_SLOTS, etag: 'W/"conflict-e2e"' }),
    });
  });
  await page.route("**/api/requests", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-trace-id": "trace_parse_demo" },
      body: JSON.stringify(CANNED_PARSE),
    });
  });
  await page.route("**/api/metrics**", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ code: "NOT_FOUND", message: "T-11 owns /api/metrics" }),
    });
  });
}

test.describe("Conflict resolution (T-09)", () => {
  test("transmit → drawer lists Stage 2 → Reroute & Hold confirms with traceId", async ({
    page,
  }) => {
    await mockApi(page);
    await page.route("**/api/reroute", async (route) => {
      const body = (await route.request().postDataJSON()) as {
        requestId?: string;
        idempotencyKey?: string;
      };
      expect(body.requestId).toBe("req_demo");
      expect(typeof body.idempotencyKey).toBe("string");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-trace-id": "trace_reroute_demo" },
        body: JSON.stringify({
          status: "confirmed",
          slots: [],
          traceId: "trace_reroute_demo",
        }),
      });
    });

    await page.goto(`/?date=${DATE}`);

    await page.getByLabel(/describe the shoot/i).fill("Stage 3 tomorrow 6am-6pm, Alexa 65");
    await page.getByRole("button", { name: /transmit request/i }).click();

    /* Drawer docks with the Atlas block named + Stage-2-first order. */
    const drawer = page.getByTestId("conflict-drawer");
    await expect(drawer).toContainText("stage-3 conflict 08:00-10:00");
    await expect(drawer).toContainText("req_atlas");
    const rows = drawer.getByTestId("alternative-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("stage-2");
    await expect(rows.first()).toContainText("Same size, free");

    /* Reroute & Hold → emerald confirmation + traceId. */
    await drawer.getByRole("button", { name: /reroute and hold stage-2/i }).click();
    await expect(page.getByTestId("reroute-confirmation")).toContainText(
      "Rerouted & held — radar is green.",
    );
    await expect(page.getByTestId("reroute-trace")).toContainText("trace_reroute_demo");
  });

  test("health strip shows the stale badge while /api/metrics 404s", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(`/?date=${DATE}`);

    const health = page.getByTestId("lot-health");
    await expect(health).toBeVisible();
    await expect(page.getByTestId("health-stale-badge")).toContainText(
      "Observability delayed",
    );
  });

  test("stale alternative surfaces the refresh state on 409", async ({ page }) => {
    await mockApi(page);
    await page.route("**/api/reroute", async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "STALE_ALTERNATIVE",
          message: "alternative taken between check and hold",
        }),
      });
    });

    await page.goto(`/?date=${DATE}`);
    await page.getByLabel(/describe the shoot/i).fill("Stage 3 tomorrow 6am-6pm, Alexa 65");
    await page.getByRole("button", { name: /transmit request/i }).click();

    const drawer = page.getByTestId("conflict-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: /reroute and hold stage-2/i }).click();
    await expect(page.getByTestId("stale-alternative")).toContainText(
      /stale — refreshed alternatives/i,
    );
  });
});

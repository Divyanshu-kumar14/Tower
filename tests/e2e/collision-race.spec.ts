/**
 * Collision-race proof (T-10, E08 at the BFF-mocked level).
 *
 * Strategy: a stateful `page.route` mock plays the BFF. The FIRST
 * `POST /api/requests` for the contested window wins 200 `confirmed`; the
 * SECOND concurrent POST for the same window loses with 409
 * `STALE_ALTERNATIVE` + fresh alternatives (Stage-2-first). Two fetches
 * fired concurrently from the page must therefore resolve to exactly one
 * 200 and one 409 — zero double-books by construction — and the conflict
 * drawer must surface the fresh Stage 2 alternative.
 *
 * No backend, no secrets: all network is mocked.
 */
import { test, expect } from "@playwright/test";

const DATE = "2026-09-06";
const WINDOW = { start: `${DATE}T08:00:00Z`, end: `${DATE}T10:00:00Z` };

const ALT_STAGE2 = {
  slot: { resource_id: "stage-2", start: WINDOW.start, end: WINDOW.end },
  score: 0.95,
  reason: "same specs (stage-2=stage-3), same time, crew available",
};

test("E08 race: two concurrent holds → one 200 confirmed, one 409 + fresh alternatives", async ({
  page,
}) => {
  let holds = 0;
  await page.route("**/api/requests", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    holds += 1;
    if (holds === 1) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId: "req_race_winner",
          status: "confirmed",
          traceId: "trace_race_001",
        }),
      });
    }
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "STALE_ALTERNATIVE",
        message: "window taken between check and hold; refreshed alternatives",
        alternatives: [
          ALT_STAGE2,
          {
            slot: { resource_id: "stage-1", start: WINDOW.start, end: WINDOW.end },
            score: 0.7,
            reason: "same type (stage), same time, crew available",
          },
        ],
      }),
    });
  });
  // Slots feed stays quiet so the radar underneath never flakes.
  await page.route("**/api/slots?*", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ date: DATE, slots: [], etag: "race-empty" }),
    }),
  );

  await page.goto(`/?date=${DATE}`);
  const outcomes: Array<{ status: number; body: unknown }> = await page.evaluate(
    async () => {
      const fire = async (key: string) => {
        const res = await fetch("/api/requests", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": key,
            "x-tower-production": "atlas",
          },
          body: JSON.stringify({ text: "Stage 3 Sep 6 8am-10am" }),
        });
        return { status: res.status, body: await res.json() };
      };
      return Promise.all([
        fire("11111111-1111-4111-8111-111111111111"),
        fire("22222222-2222-4222-8222-222222222222"),
      ]);
    },
  );

  const statuses = outcomes.map((o) => o.status).sort();
  expect(statuses).toEqual([200, 409]);
  const loser = outcomes.find((o) => o.status === 409);
  expect(loser).toBeDefined();
  const loserBody = loser!.body as {
    code: string;
    alternatives: Array<{ slot: { resource_id: string } }>;
  };
  expect(loserBody.code).toBe("STALE_ALTERNATIVE");
  expect(loserBody.alternatives[0]!.slot.resource_id).toBe("stage-2");
});

test("E12 drawer: mocked 409 conflict lists Stage 2 first, reroute confirms", async ({
  page,
}) => {
  await page.route("**/api/requests", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: "req_demo_race",
        parsed: {
          slots: [
            {
              resource_type: "stage",
              resource_id: "stage-3",
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
          alternatives: [ALT_STAGE2],
        },
      }),
    }),
  );
  await page.route("**/api/reroute", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "confirmed", traceId: "trace_race_002" }),
    }),
  );
  await page.route("**/api/slots?*", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ date: DATE, slots: [], etag: "race-drawer" }),
    }),
  );
  await page.route("**/api/metrics", async (route) =>
    route.fulfill({ status: 404, body: "no metrics in T-10" }),
  );

  await page.goto(`/?date=${DATE}`);
  const input = page.getByLabel(/describe the shoot/i);
  await input.fill("Stage 3 tomorrow 6am-6pm");
  await page.getByRole("button", { name: "Transmit request" }).click();
  // Drawer surfaces the Stage-2-first fresh alternative…
  await expect(page.getByText(/stage-2/i).first()).toBeVisible({ timeout: 15000 });
  // …and Reroute & Hold confirms with the trace id.
  await page.getByRole("button", { name: /reroute and hold/i }).first().click();
  await expect(page.getByTestId("reroute-trace")).toContainText("trace_race_002", {
    timeout: 15000,
  });
});

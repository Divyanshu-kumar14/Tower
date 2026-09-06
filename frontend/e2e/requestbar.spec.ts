/**
 * RequestBar smoke (T-07) — transmit → parsing shimmer → conflict chips.
 *
 * Self-skip contract: page assembly is T-08. Until the radar layout mounts
 * <RequestBar/> on `/`, the suite skips (green, documented) instead of
 * failing — vitest owns the hard assertions meanwhile.
 */
import { test, expect } from "@playwright/test";

const CANNED_CONFLICT = {
  requestId: "req_e2e",
  parsed: {
    slots: [
      {
        resource_type: "stage",
        resource_id: "stage-3",
        start: "2026-09-06T06:00:00Z",
        end: "2026-09-06T18:00:00Z",
      },
      {
        resource_type: "gear",
        resource_id: "alexa-65",
        start: "2026-09-06T06:00:00Z",
        end: "2026-09-06T18:00:00Z",
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
          start: "2026-09-06T06:00:00Z",
          end: "2026-09-06T18:00:00Z",
        },
        score: 0.95,
        reason: "Same size, free",
      },
    ],
  },
  traceId: "trace_e2e",
};

test.describe("RequestBar (T-07)", () => {
  test("transmit parses to chips and announces the conflict", async ({
    page,
  }) => {
    await page.route("**/api/requests", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-trace-id": "trace_e2e" },
        body: JSON.stringify(CANNED_CONFLICT),
      });
    });
    await page.goto("/");

    const box = page.getByLabel(/describe the shoot/i);
    if ((await box.count()) === 0) {
      test.skip(true, "T-08 page assembly not mounted — no RequestBar on /");
      return;
    }

    await box.fill("Stage 3 tomorrow 6am-6pm, Alexa 65");
    await page.getByRole("button", { name: /transmit request/i }).click();

    /* Parsed chips land in the chip river. */
    await expect(page.getByLabel("Parsed request")).toContainText("stage-3");
    await expect(page.getByLabel("Parsed request")).toContainText("alexa-65");
    /* Live region announces the rose outcome. Scoped to the transmit
       console's own region (T-08 composes LiveDot + proposal notices that
       share role=status on the same page). */
    await expect(page.locator("#tower-request-live")).toContainText(/conflict/i);
  });

  test("empty transmit is rejected client-side with no API call", async ({
    page,
  }) => {
    let calls = 0;
    await page.route("**/api/requests", async (route) => {
      calls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(CANNED_CONFLICT),
      });
    });
    await page.goto("/");

    const box = page.getByLabel(/describe the shoot/i);
    if ((await box.count()) === 0) {
      test.skip(true, "T-08 page assembly not mounted — no RequestBar on /");
      return;
    }

    await page.getByRole("button", { name: /transmit request/i }).click();
    await expect(page.getByRole("alert").first()).toContainText(/empty/i);
    expect(calls).toBe(0);
  });
});

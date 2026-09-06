/**
 * GET /api/stream SSE tests (T-05) — framing contract for T-08 radar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdempotencyStoreForTests } from "../../../lib/idempotency";
import { resetRateLimiterForTests } from "../../../lib/rate-limit";
import { GET } from "../stream/route";
import { sseEvent } from "../../../lib/sse";

beforeEach(() => {
  resetRateLimiterForTests();
  resetIdempotencyStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/stream (SSE)", () => {
  it("serves text/event-stream with heartbeat and no phantom events", async () => {
    const res = await GET(new Request("http://localhost:3000/api/stream"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    expect(res.headers.get("x-trace-id")).toMatch(/^trace_/);
    const text = await res.text();
    expect(text).toContain(":heartbeat");
    // No demo domain events: radar must never render phantom slots.
    expect(text).not.toContain("event: slot:confirmed");
    expect(text).not.toContain("event: collision");
  });

  it("sseEvent builds valid slot:confirmed + collision frames", () => {
    const confirmed = sseEvent("slot:confirmed", {
      slotId: "slot_abc123",
      traceId: "trace_abc123",
      resource_id: "stage-2",
    });
    expect(confirmed).toContain("event: slot:confirmed");
    const confirmedPayload = JSON.parse(
      confirmed.split("\n").find((l) => l.startsWith("data:"))!.replace(/^data:\s?/, ""),
    );
    expect(confirmedPayload.resource_id).toBe("stage-2");
    const collision = sseEvent("collision", {
      requestId: "req_123",
      conflicts: [{ resource_id: "stage-3", overlap: "08:00-10:00", blockedBy: "req_atlas" }],
    });
    expect(collision).toContain("event: collision");
    const collisionPayload = JSON.parse(
      collision.split("\n").find((l) => l.startsWith("data:"))!.replace(/^data:\s?/, ""),
    );
    expect(collisionPayload.conflicts[0].blockedBy).toBe("req_atlas");
  });

  it("heartbeat-only wire carries no data lines (frames tested above)", async () => {
    const res = await GET(new Request("http://localhost:3000/api/stream"));
    const text = await res.text();
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data:"));
    expect(dataLines).toHaveLength(0);
  });
});

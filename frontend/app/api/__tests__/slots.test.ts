/**
 * GET /api/slots handler tests (T-05) — Zod date query, ETag/304,
 * agent-error mapping. Day-view fetch mocked via global fetch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdempotencyStoreForTests } from "../../../lib/idempotency";
import { resetRateLimiterForTests } from "../../../lib/rate-limit";
import { GET } from "../slots/route";

const SLOTS = [
  {
    id: "slot_atlas1",
    production: "Project Atlas",
    resource_type: "stage",
    resource_id: "stage-3",
    start: "2026-09-06T08:00:00Z",
    end: "2026-09-06T10:00:00Z",
    status: "confirmed",
    request_id: "req_atlas",
    trace_id: "trace_atlas",
  },
];

beforeEach(() => {
  resetRateLimiterForTests();
  resetIdempotencyStoreForTests();
  delete process.env.AGENT_BASE_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/slots", () => {
  it("invalid date → 422 INVALID_INTERVAL, no agent call", async () => {
    const captured: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request) => {
        captured.push(String(input));
        return Response.json({ date: "x", slots: [] }, { status: 200 });
      }) as typeof fetch,
    );
    const res = await GET(
      new Request("http://localhost:3000/api/slots?date=tomorrow"),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "INVALID_INTERVAL" });
    expect(captured).toHaveLength(0);
  });

  it("missing date → 422", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        Response.json(
          { date: "x", slots: [] },
          { status: 200 },
        )) as typeof fetch,
    );
    const res = await GET(new Request("http://localhost:3000/api/slots"));
    expect(res.status).toBe(422);
  });

  it("returns date + slots + etag with a matching ETag header", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        captured.push({ url: String(input), init: init ?? {} });
        return Response.json(
          { date: "2026-09-06", slots: SLOTS },
          { status: 200 },
        );
      }) as typeof fetch,
    );
    const res = await GET(
      new Request("http://localhost:3000/api/slots?date=2026-09-06"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      date: string;
      slots: unknown[];
      etag: string;
    };
    expect(body.date).toBe("2026-09-06");
    expect(body.slots).toHaveLength(1);
    expect(body.etag).toMatch(/^W\//);
    expect(res.headers.get("etag")).toBe(body.etag);
    // Trace propagates on the agent day-view fetch.
    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("x-trace-id")).toMatch(/^trace_/);
  });

  it("If-None-Match match → 304 with no body", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        Response.json(
          { date: "2026-09-06", slots: SLOTS },
          { status: 200 },
        )) as typeof fetch,
    );
    const first = await GET(
      new Request("http://localhost:3000/api/slots?date=2026-09-06"),
    );
    const etag = first.headers.get("etag") ?? "";
    expect(etag.length).toBeGreaterThan(0);
    const second = await GET(
      new Request("http://localhost:3000/api/slots?date=2026-09-06", {
        headers: { "If-None-Match": etag },
      }),
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("agent unreachable → 502 JSON (never throws)", async () => {
    vi.stubGlobal(
      "fetch",
      (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    );
    const res = await GET(
      new Request("http://localhost:3000/api/slots?date=2026-09-06"),
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

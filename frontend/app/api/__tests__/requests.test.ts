/**
 * POST /api/requests handler tests (T-05) — E01–E03, E19, E20, E24.
 *
 * The agent boundary is mocked via global `fetch` (never a live call —
 * the Python agent is NOT running here). E04/E07 self-merge + overnight
 * split are graph-owned (T-03); the BFF asserts their payloads pass
 * through untouched (see the `hasConflict` passthrough test).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdempotencyStoreForTests } from "../../../lib/idempotency";
import { resetRateLimiterForTests } from "../../../lib/rate-limit";
import { POST } from "../requests/route";

const KEY_A = "123e4567-e89b-42d3-a456-426614174000";
const KEY_B = "123e4567-e89b-42d3-a456-426614174001";
const NOW = "2026-09-06T00:00:00Z";
const TEXT = "Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm";

const AGENT_OK = {
  requestId: "req_123",
  parsed: {
    slots: [
      {
        resource_type: "stage",
        resource_id: "stage-3",
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
  traceId: "trace_abc123",
};

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function mockFetchOk(captured: CapturedCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return Response.json(AGENT_OK, { status: 200 });
  }) as typeof fetch;
}

function postRequests(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost:3000/api/requests", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tower-production": "atlas",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  resetRateLimiterForTests();
  resetIdempotencyStoreForTests();
  delete process.env.AGENT_BASE_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/requests validation (E01–E03)", () => {
  it("E01: empty text → 422 NEEDS_CLARIFICATION without calling the agent", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const res = await POST(
      postRequests({ text: "", now: NOW }, { "Idempotency-Key": KEY_A }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "NEEDS_CLARIFICATION",
      field: "text",
    });
    expect(captured).toHaveLength(0);
  });

  it("E01: whitespace-only text → 422 without calling the agent", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const res = await POST(
      postRequests({ text: "   ", now: NOW }, { "Idempotency-Key": KEY_A }),
    );
    expect(res.status).toBe(422);
    expect(captured).toHaveLength(0);
  });

  it("E01: malformed JSON body → 422 NEEDS_CLARIFICATION", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const res = await POST(
      postRequests("{not-json", { "Idempotency-Key": KEY_A }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "NEEDS_CLARIFICATION",
      field: "body",
    });
    expect(captured).toHaveLength(0);
  });

  it("E02: >500 chars → 422 NEEDS_CLARIFICATION, never silently truncated", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const res = await POST(
      postRequests(
        { text: "x".repeat(501), now: NOW },
        { "Idempotency-Key": KEY_A },
      ),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "NEEDS_CLARIFICATION",
      field: "text",
    });
    expect(captured).toHaveLength(0);
  });

  it("E02 boundary: exactly 500 chars forwards to the agent", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const res = await POST(
      postRequests(
        { text: "x".repeat(500), now: NOW },
        { "Idempotency-Key": KEY_A },
      ),
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
  });

  it("E03: naive `now` (no TZ offset) → 422 without calling the agent", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const res = await POST(
      postRequests(
        { text: TEXT, now: "2026-09-06T00:00:00" },
        { "Idempotency-Key": KEY_A },
      ),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "NEEDS_CLARIFICATION",
      field: "now",
    });
    expect(captured).toHaveLength(0);
  });

  it("missing Idempotency-Key header → 422", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const res = await POST(postRequests({ text: TEXT, now: NOW }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSE",
    });
    expect(captured).toHaveLength(0);
  });

  it("invalid (non-uuid) Idempotency-Key → 422", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const res = await POST(
      postRequests({ text: TEXT, now: NOW }, { "Idempotency-Key": "not-a-uuid" }),
    );
    expect(res.status).toBe(422);
    expect(captured).toHaveLength(0);
  });
});

describe("POST /api/requests happy path + trace/auth", () => {
  it("returns the PRD §7.4 shape with hasConflict + alternatives passthrough", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const res = await POST(
      postRequests({ text: TEXT, now: NOW }, { "Idempotency-Key": KEY_A }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestId).toBe("req_123");
    expect(body.collision.hasConflict).toBe(true);
    expect(body.collision.alternatives).toHaveLength(1);
    expect(body.parsed.confidence).toBe(0.92);
    expect(typeof body.traceId).toBe("string");
  });

  it("generates X-Trace-Id when absent and propagates it to the agent", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const res = await POST(
      postRequests({ text: TEXT, now: NOW }, { "Idempotency-Key": KEY_A }),
    );
    const traceId = res.headers.get("x-trace-id");
    expect(traceId).toMatch(/^trace_/);
    expect(captured).toHaveLength(1);
    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("x-trace-id")).toBe(traceId);
    expect(captured[0]?.url).toBe("http://localhost:8000/invoke");
  });

  it("echoes a client-supplied X-Trace-Id end to end", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const res = await POST(
      postRequests(
        { text: TEXT, now: NOW },
        { "Idempotency-Key": KEY_A, "X-Trace-Id": "trace_client123" },
      ),
    );
    expect(res.headers.get("x-trace-id")).toBe("trace_client123");
    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("x-trace-id")).toBe("trace_client123");
  });

  it("tags the actor in the agent payload and writes the audit line", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await POST(
      postRequests({ text: TEXT, now: NOW }, { "Idempotency-Key": KEY_A }),
    );
    expect(res.status).toBe(200);
    const sent = JSON.parse(String(captured[0]?.init.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(sent.actor).toBe("atlas");
    expect(sent.op).toBe("create_request");
    expect(logSpy).toHaveBeenCalledOnce();
    const audit = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(audit.actor).toBe("atlas");
    expect(audit.request_id).toBe("req_123");
    expect(typeof audit.trace_id).toBe("string");
    expect(audit.before).toBeNull();
    expect(audit.after).toBeDefined();
  });

  it("E20: missing x-tower-production → 401 without calling the agent", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const req = new Request("http://localhost:3000/api/requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      body: JSON.stringify({ text: TEXT, now: NOW }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(captured).toHaveLength(0);
  });

  it("passes agent 422 NEEDS_CLARIFICATION through with its status", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        Response.json(
          {
            code: "NEEDS_CLARIFICATION",
            field: "date",
            message: "Did you mean 2026-09-06?",
          },
          { status: 422 },
        )) as typeof fetch,
    );
    const res = await POST(
      postRequests({ text: TEXT, now: NOW }, { "Idempotency-Key": KEY_A }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "NEEDS_CLARIFICATION" });
  });
});

describe("POST /api/requests idempotency (E19)", () => {
  it("same key + same body → 409 IDEMPOTENT_REPLAY, agent called once", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const headers = { "Idempotency-Key": KEY_A };
    const first = await POST(postRequests({ text: TEXT, now: NOW }, headers));
    expect(first.status).toBe(200);
    const second = await POST(postRequests({ text: TEXT, now: NOW }, headers));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      code: "IDEMPOTENT_REPLAY",
      requestId: "req_123",
    });
    expect(captured).toHaveLength(1);
  });

  it("same key + different body → 422 IDEMPOTENCY_KEY_REUSE", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const headers = { "Idempotency-Key": KEY_A };
    const first = await POST(postRequests({ text: TEXT, now: NOW }, headers));
    expect(first.status).toBe(200);
    const second = await POST(
      postRequests({ text: "Stage 2 tomorrow 6am-6pm", now: NOW }, headers),
    );
    expect(second.status).toBe(422);
    expect(await second.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSE",
    });
    expect(captured).toHaveLength(1);
  });

  it("24h TTL: same key + same body after expiry forwards again (no 409)", async () => {
    let nowMs = 1_000_000;
    resetRateLimiterForTests(() => nowMs);
    resetIdempotencyStoreForTests(() => nowMs);
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    const headers = { "Idempotency-Key": KEY_A };
    const first = await POST(postRequests({ text: TEXT, now: NOW }, headers));
    expect(first.status).toBe(200);
    nowMs += 24 * 60 * 60 * 1000 + 1;
    const second = await POST(postRequests({ text: TEXT, now: NOW }, headers));
    expect(second.status).toBe(200);
    expect(captured).toHaveLength(2);
  });
});

describe("POST /api/requests rate limit (E24, fake time)", () => {
  it("10 rps/IP burst passes, 11th → 429 + Retry-After, no sleeps", async () => {
    let nowMs = 5_000_000;
    resetRateLimiterForTests(() => nowMs);
    resetIdempotencyStoreForTests(() => nowMs);
    const captured: CapturedCall[] = [];
    vi.stubGlobal("fetch", mockFetchOk(captured));
    for (let i = 0; i < 10; i += 1) {
      const key = `123e4567-e89b-42d3-a456-42661417${String(4000 + i)}`;
      const res = await POST(
        postRequests(
          { text: TEXT, now: NOW, nonce: i },
          { "Idempotency-Key": key },
        ),
      );
      expect(res.status).not.toBe(429);
    }
    expect(captured).toHaveLength(10);
    const limited = await POST(
      postRequests({ text: TEXT, now: NOW }, { "Idempotency-Key": KEY_B }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(captured).toHaveLength(10);
    void nowMs;
  });
});

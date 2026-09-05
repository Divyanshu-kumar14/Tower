/**
 * POST /api/reroute handler tests (T-05) — validation, E06, E19,
 * 409 STALE_ALTERNATIVE passthrough, E20. Agent mocked via global fetch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdempotencyStoreForTests } from "../../../lib/idempotency";
import { resetRateLimiterForTests } from "../../../lib/rate-limit";
import { POST } from "../reroute/route";

const KEY_A = "123e4567-e89b-42d3-a456-426614174000";
const ALT = {
  resource_id: "stage-2",
  start: "2026-09-06T06:00:00Z",
  end: "2026-09-06T18:00:00Z",
};

const AGENT_OK = {
  status: "confirmed",
  slots: [
    {
      id: "slot_reroute1",
      production: "atlas",
      resource_type: "stage",
      resource_id: "stage-2",
      start: "2026-09-06T06:00:00Z",
      end: "2026-09-06T18:00:00Z",
      status: "confirmed",
      request_id: "req_123",
      trace_id: "trace_abc123",
    },
  ],
  traceId: "trace_abc123",
};

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function postReroute(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost:3000/api/reroute", {
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

describe("POST /api/reroute validation", () => {
  it("E06: alternative end <= start → 422 INVALID_INTERVAL, no agent call", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        captured.push({ url: String(input), init: init ?? {} });
        return Response.json(AGENT_OK, { status: 200 });
      }) as typeof fetch,
    );
    const res = await POST(
      postReroute(
        {
          requestId: "req_123",
          alternative: {
            resource_id: "stage-2",
            start: "2026-09-06T18:00:00Z",
            end: "2026-09-06T06:00:00Z",
          },
        },
        { "Idempotency-Key": KEY_A },
      ),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "INVALID_INTERVAL" });
    expect(captured).toHaveLength(0);
  });

  it("missing Idempotency-Key → 422", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        captured.push({ url: String(input), init: init ?? {} });
        return Response.json(AGENT_OK, { status: 200 });
      }) as typeof fetch,
    );
    const res = await POST(
      postReroute({ requestId: "req_123", alternative: ALT }),
    );
    expect(res.status).toBe(422);
    expect(captured).toHaveLength(0);
  });

  it("E20: missing x-tower-production → 401", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        captured.push({ url: String(input), init: init ?? {} });
        return Response.json(AGENT_OK, { status: 200 });
      }) as typeof fetch,
    );
    const res = await POST(
      postReroute(
        { requestId: "req_123", alternative: ALT },
        { "Idempotency-Key": KEY_A, "x-tower-production": "" },
      ),
    );
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(0);
  });
});

describe("POST /api/reroute happy path + agent errors", () => {
  it("confirms and tags the actor with an audit line", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        captured.push({ url: String(input), init: init ?? {} });
        return Response.json(AGENT_OK, { status: 200 });
      }) as typeof fetch,
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await POST(
      postReroute(
        { requestId: "req_123", alternative: ALT },
        { "Idempotency-Key": KEY_A },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "confirmed" });
    expect(res.headers.get("x-trace-id")).toMatch(/^trace_/);
    const sent = JSON.parse(String(captured[0]?.init.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(sent.op).toBe("reroute");
    expect(sent.actor).toBe("atlas");
    const audit = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(audit.actor).toBe("atlas");
    expect(audit.request_id).toBe("req_123");
  });

  it("409 STALE_ALTERNATIVE passes through with its status + code", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        Response.json(
          {
            code: "STALE_ALTERNATIVE",
            message: "Alternative already taken; refreshed alternatives available",
          },
          { status: 409 },
        )) as typeof fetch,
    );
    const res = await POST(
      postReroute(
        { requestId: "req_123", alternative: ALT },
        { "Idempotency-Key": KEY_A },
      ),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "STALE_ALTERNATIVE" });
  });
});

describe("POST /api/reroute idempotency (E19)", () => {
  it("same key + same body replays the stored 200 (agent called once)", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        captured.push({ url: String(input), init: init ?? {} });
        return Response.json(AGENT_OK, { status: 200 });
      }) as typeof fetch,
    );
    const headers = { "Idempotency-Key": KEY_A };
    const first = await POST(
      postReroute({ requestId: "req_123", alternative: ALT }, headers),
    );
    expect(first.status).toBe(200);
    const second = await POST(
      postReroute({ requestId: "req_123", alternative: ALT }, headers),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "confirmed" });
    expect(captured).toHaveLength(1);
  });

  it("same key + different body → 422 IDEMPOTENCY_KEY_REUSE", async () => {
    const captured: CapturedCall[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        captured.push({ url: String(input), init: init ?? {} });
        return Response.json(AGENT_OK, { status: 200 });
      }) as typeof fetch,
    );
    const headers = { "Idempotency-Key": KEY_A };
    const first = await POST(
      postReroute({ requestId: "req_123", alternative: ALT }, headers),
    );
    expect(first.status).toBe(200);
    const second = await POST(
      postReroute(
        {
          requestId: "req_123",
          alternative: { ...ALT, resource_id: "stage-1" },
        },
        headers,
      ),
    );
    expect(second.status).toBe(422);
    expect(await second.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSE",
    });
    expect(captured).toHaveLength(1);
  });
});

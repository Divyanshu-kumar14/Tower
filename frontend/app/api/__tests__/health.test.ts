/**
 * GET /api/health tests (T-05, E16) — degraded/ok paths, never throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../health/route";

beforeEach(() => {
  delete process.env.DATABASE_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/health (E16)", () => {
  it("no DATABASE_URL locally → 503 LOT_OPS_DEGRADED reads-only JSON", async () => {
    const res = await GET(new Request("http://localhost:3000/api/health"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: "LOT_OPS_DEGRADED",
      status: "degraded",
      readsOnly: true,
    });
    const checks = body.checks as Record<string, string>;
    expect(typeof checks.postgres).toBe("string");
    expect(typeof checks.bigquery).toBe("string");
    expect(typeof checks.otlp).toBe("string");
  });

  it("DATABASE_URL present → 200 ok, reads allowed", async () => {
    process.env.DATABASE_URL = "postgres://localhost:5432/tower";
    try {
      const res = await GET(new Request("http://localhost:3000/api/health"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        status: "ok",
        readsOnly: false,
      });
    } finally {
      delete process.env.DATABASE_URL;
    }
  });

  it("always JSON content-type, never throws", async () => {
    const res = await GET(new Request("http://localhost:3000/api/health"));
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toBeDefined();
  });
});

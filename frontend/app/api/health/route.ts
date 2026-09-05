/**
 * GET /api/health (T-05, E16) — dependency checks with graceful degrade.
 *
 * Contract: NEVER throws, ALWAYS JSON. Postgres absent locally (no
 * `DATABASE_URL`) → `degraded` + 503 `LOT_OPS_DEGRADED` with the reads-only
 * mode flag; BigQuery + OTLP are stubs until T-06 wires the real probes.
 * Exempt from rate limiting so monitors can always scrape it.
 */
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const incoming = req.headers.get("x-trace-id")?.trim() ?? "";
    const traceId =
      incoming.length > 0 && incoming.length <= 128
        ? incoming
        : `trace_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const hasDatabaseUrl = (process.env.DATABASE_URL ?? "").trim().length > 0;
    const checks = {
      postgres: hasDatabaseUrl
        ? "up: connection string present (live SELECT probe lands in T-11)"
        : "degraded: DATABASE_URL absent locally",
      bigquery: "stub: ledger-mirror probe lands in T-06",
      otlp: "stub: Grafana Cloud OTLP probe lands in T-06",
    };
    if (!hasDatabaseUrl) {
      return Response.json(
        {
          code: "LOT_OPS_DEGRADED",
          status: "degraded",
          readsOnly: true,
          checks,
          traceId,
        },
        { status: 503, headers: { "x-trace-id": traceId } },
      );
    }
    return Response.json(
      { status: "ok", readsOnly: false, checks, traceId },
      { status: 200, headers: { "x-trace-id": traceId } },
    );
  } catch {
    // Last-resort envelope: health itself must never throw (E16).
    return Response.json(
      {
        code: "LOT_OPS_DEGRADED",
        status: "degraded",
        readsOnly: true,
      },
      { status: 503 },
    );
  }
}

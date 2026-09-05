/**
 * GET /api/slots?date= (T-05) — day-view slots + ETag.
 *
 * Contract (contracts/api.yaml): Zod `date` query (YYYY-MM-DD, else 422
 * INVALID_INTERVAL), weak ETag mirroring the body `etag`
 * (`If-None-Match` match → 304), trace propagated to the agent fetch.
 * Reads are public (producers see public conflicts; row-level auth on
 * writes only) — writes still require `x-tower-production` (E20).
 *
 * T-08 TanStack key (frontend): `['slots', date]` — `useRadarStream()`
 * writes SSE events into this cache; the 5s poll fallback refetches it.
 */
import { createHash, randomUUID } from "node:crypto";
import { AgentError, fetchSlotsFromAgent } from "../../../lib/agent";
import {
  getClientIp,
  getRateLimiter,
  rateLimitedResponse,
} from "../../../lib/rate-limit";
import { slotsQuerySchema } from "../../../lib/validator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function traceIdOf(req: Request): string {
  const incoming = req.headers.get("x-trace-id")?.trim() ?? "";
  if (incoming.length > 0 && incoming.length <= 128) return incoming;
  return `trace_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export async function GET(req: Request): Promise<Response> {
  const traceId = traceIdOf(req);
  try {
    const rate = getRateLimiter().check(getClientIp(req));
    if (!rate.allowed) return rateLimitedResponse(traceId, rate.retryAfterSec);

    const url = new URL(req.url);
    const parsed = slotsQuerySchema.safeParse({
      date: url.searchParams.get("date") ?? "",
    });
    if (!parsed.success) {
      return Response.json(
        {
          code: "INVALID_INTERVAL",
          message: "date must be YYYY-MM-DD",
        },
        { status: 422, headers: { "x-trace-id": traceId } },
      );
    }
    const { date } = parsed.data;

    let slots: unknown[];
    try {
      const agentRes = await fetchSlotsFromAgent(date, { traceId });
      slots = agentRes.slots;
    } catch (err) {
      if (err instanceof AgentError) {
        const passthrough =
          typeof err.detail === "object" && err.detail !== null
            ? err.detail
            : { code: err.code, message: err.message };
        return Response.json(passthrough, {
          status: err.status,
          headers: { "x-trace-id": traceId },
        });
      }
      throw err;
    }

    const etag = `W/"${createHash("sha256")
      .update(JSON.stringify({ date, slots }), "utf8")
      .digest("hex")
      .slice(0, 12)}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { etag, "x-trace-id": traceId },
      });
    }
    return Response.json(
      { date, slots, etag },
      { status: 200, headers: { etag, "x-trace-id": traceId } },
    );
  } catch {
    return Response.json(
      { code: "INTERNAL", message: "unexpected error" },
      { status: 500, headers: { "x-trace-id": traceId } },
    );
  }
}

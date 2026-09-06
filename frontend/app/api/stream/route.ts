/**
 * GET /api/stream (T-05) — SSE radar updates (`slot:confirmed`, `collision`).
 *
 * Framing contract (frozen): `event: <name>` + `data: <json>` frames,
 * `:heartbeat` comment lines to keep intermediaries from buffering.
 *
 * T-08 client contract (implemented in `frontend/hooks/useRadarStream.ts`):
 * EventSource with exponential-backoff reconnect; if disconnected for more
 * than 5s, fall back to polling `GET /api/slots` every 5s (E18) and show
 * the amber `Live: reconnecting…` dot. TanStack key `['slots', date]`.
 *
 * T-11 live-wire: production subscribes the TransformStream writer to the
 * agent event bus (Redis pubsub) and keeps the stream open with a 15s
 * heartbeat interval. Until then this handler emits heartbeat-only and
 * closes — deliberately NO demo domain events, so radar never renders
 * phantom slots. Frame shapes are unit-tested via `sseEvent` in
 * `../../../lib/sse` (kept out of this route module so Next's
 * typed-routes generation never type-checks a non-handler export).
 */
import { randomUUID } from "node:crypto";
import {
  getClientIp,
  getRateLimiter,
  rateLimitedResponse,
} from "../../../lib/rate-limit";

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

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const chunks: string[] = [`:heartbeat trace=${traceId}\n\n`];
    // Pump AFTER returning: TransformStream applies backpressure, so awaiting
    // writes before a reader attaches would deadlock. The pump is background
    // by design (this is how streaming works) — failures log loudly via
    // .catch, and .close() in `finally` always terminates the stream.
    const pump = (async (): Promise<void> => {
      try {
        for (const chunk of chunks) {
          await writer.write(encoder.encode(chunk));
        }
      } finally {
        await writer.close().catch(() => undefined);
      }
    })();
    pump.catch((err: unknown) => {
      console.error(
        JSON.stringify({ stream: "pump_failed", error: String(err) }),
      );
    });

    return new Response(readable, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-trace-id": traceId,
      },
    });
  } catch {
    return Response.json(
      { code: "INTERNAL", message: "unexpected error" },
      { status: 500, headers: { "x-trace-id": traceId } },
    );
  }
}

/**
 * POST /api/reroute (T-05) — transactional move to an alternative slot.
 *
 * Contract (contracts/api.yaml): validate the alternative (end > start else
 * 422 INVALID_INTERVAL), `Idempotency-Key` header UUIDv4 required, trace
 * generate+propagate, actor from auth, forward to the agent `/invoke`
 * (op `reroute`), 409 STALE_ALTERNATIVE passthrough from the agent.
 *
 * E19 here differs from /requests (which freezes 409 IDEMPOTENT_REPLAY):
 * this contract defines no replay code, so same key + same body replays
 * the stored 200 response, while same key + different body → 422
 * IDEMPOTENCY_KEY_REUSE.
 */
import { randomUUID } from "node:crypto";
import { AgentError, invokeReroute } from "../../../lib/agent";
import {
  auditLog,
  extractActor,
  unauthorizedResponse,
} from "../../../lib/auth";
import {
  computeBodyHash,
  getIdempotencyStore,
  IdempotencyKeyReuseError,
} from "../../../lib/idempotency";
import {
  getClientIp,
  getRateLimiter,
  rateLimitedResponse,
} from "../../../lib/rate-limit";
import {
  idempotencyKeySchema,
  rerouteRequestSchema,
} from "../../../lib/validator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function traceIdOf(req: Request): string {
  const incoming = req.headers.get("x-trace-id")?.trim() ?? "";
  if (incoming.length > 0 && incoming.length <= 128) return incoming;
  return `trace_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function json(
  data: unknown,
  status: number,
  traceId: string,
  extra?: Record<string, string>,
): Response {
  return Response.json(data, {
    status,
    headers: { "x-trace-id": traceId, ...extra },
  });
}

export async function POST(req: Request): Promise<Response> {
  const traceId = traceIdOf(req);
  try {
    const rate = getRateLimiter().check(getClientIp(req));
    if (!rate.allowed) return rateLimitedResponse(traceId, rate.retryAfterSec);

    let actor: { production: string; email?: string; verified: boolean };
    try {
      actor = await extractActor(req);
    } catch (err) {
      return unauthorizedResponse(
        traceId,
        err instanceof Error ? err.message : "unauthorized",
      );
    }

    const headerKey = (req.headers.get("idempotency-key") ?? "").trim();
    const parsedHeader = idempotencyKeySchema.safeParse(headerKey);
    if (!parsedHeader.success) {
      return json(
        {
          code: "IDEMPOTENCY_KEY_REUSE",
          message: "Idempotency-Key header must be uuidv4",
        },
        422,
        traceId,
      );
    }
    const key = parsedHeader.data;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json(
        {
          code: "NEEDS_CLARIFICATION",
          field: "body",
          message: "request body must be valid JSON",
        },
        422,
        traceId,
      );
    }
    const bodyRec =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
    if (
      typeof bodyRec.idempotencyKey === "string" &&
      bodyRec.idempotencyKey !== key
    ) {
      return json(
        {
          code: "IDEMPOTENCY_KEY_REUSE",
          message: "body idempotencyKey must match Idempotency-Key header",
        },
        422,
        traceId,
      );
    }

    const parsed = rerouteRequestSchema.safeParse({
      requestId: bodyRec.requestId,
      alternative: bodyRec.alternative,
      idempotencyKey: key,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".") ?? "";
      if (path.startsWith("alternative")) {
        return json(
          {
            code: "INVALID_INTERVAL",
            message: issue?.message ?? "invalid alternative slot",
          },
          422,
          traceId,
        );
      }
      if (path === "requestId") {
        return json(
          {
            code: "NEEDS_CLARIFICATION",
            field: "requestId",
            message: issue?.message ?? "requestId is required",
          },
          422,
          traceId,
        );
      }
      return json(
        {
          code: "IDEMPOTENCY_KEY_REUSE",
          message: issue?.message ?? "invalid idempotency key",
        },
        422,
        traceId,
      );
    }
    const { requestId, alternative } = parsed.data;

    const store = getIdempotencyStore();
    const bodyHash = computeBodyHash({
      requestId,
      alternative,
      idempotencyKey: key,
      actor: actor.production,
    });
    try {
      const replay = store.check(key, bodyHash);
      if (replay !== null) return json(replay.response, 200, traceId);
    } catch (err) {
      if (err instanceof IdempotencyKeyReuseError) {
        return json(
          {
            code: "IDEMPOTENCY_KEY_REUSE",
            message: "idempotencyKey already used with a different body",
          },
          422,
          traceId,
        );
      }
      throw err;
    }

    let agentRes: { status: string; slots: unknown; traceId: string };
    try {
      agentRes = await invokeReroute(
        {
          requestId,
          alternative,
          idempotencyKey: key,
          actor: actor.production,
          traceId,
        },
        { traceId },
      );
    } catch (err) {
      if (err instanceof AgentError) {
        const passthrough =
          typeof err.detail === "object" && err.detail !== null
            ? err.detail
            : { code: err.code, message: err.message };
        return json(passthrough, err.status, traceId);
      }
      throw err;
    }

    store.save(key, bodyHash, agentRes, requestId);
    auditLog({
      actor: actor.production,
      request_id: requestId,
      trace_id: traceId,
      before: { requestId },
      after: { alternative, status: agentRes.status },
    });
    return json(agentRes, 200, traceId);
  } catch {
    return json(
      { code: "INTERNAL", message: "unexpected error" },
      500,
      traceId,
    );
  }
}

/**
 * POST /api/requests (T-05) — NL text → parsed slots + collision report.
 *
 * Contract (contracts/api.yaml + PRD §7.4): Zod body, `Idempotency-Key`
 * header UUIDv4 required, `X-Trace-Id` generate+propagate, actor from auth,
 * forward `now` + actor to the agent `/invoke`, return the PRD shape with
 * `hasConflict` + alternatives passthrough.
 *
 * Error mapping: E01 empty → 422 NEEDS_CLARIFICATION; E02 >500 chars →
 * 422 NEEDS_CLARIFICATION (forward-as-clarification, NEVER silent
 * truncate); E19 same key+same body → 409 IDEMPOTENT_REPLAY, same key+
 * different body → 422 IDEMPOTENCY_KEY_REUSE; E20 missing/spoofed
 * production → 401; E24 over 10 rps/IP → 429 + Retry-After. Agent
 * 409/422 codes pass through with their original status.
 */
import { randomUUID } from "node:crypto";
import {
  AgentError,
  invokeCreateRequest,
} from "../../../lib/agent";
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
  createRequestSchema,
  exceedsClarificationLimit,
  idempotencyKeySchema,
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

    const parsed = createRequestSchema.safeParse({
      text: bodyRec.text,
      idempotencyKey: key,
      now: bodyRec.now,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".") ?? "";
      if (path === "text") {
        return json(
          {
            code: "NEEDS_CLARIFICATION",
            field: "text",
            message: issue?.message ?? "text must not be empty",
          },
          422,
          traceId,
        );
      }
      if (path === "now") {
        return json(
          {
            code: "NEEDS_CLARIFICATION",
            field: "now",
            message: "now must be TZ-aware ISO 8601",
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
    const { text, now } = parsed.data;

    if (exceedsClarificationLimit(text)) {
      return json(
        {
          code: "NEEDS_CLARIFICATION",
          field: "text",
          message: `input is ${text.length} chars (>500); please restate briefly`,
        },
        422,
        traceId,
      );
    }

    const store = getIdempotencyStore();
    const bodyHash = computeBodyHash({
      text,
      now,
      idempotencyKey: key,
      actor: actor.production,
    });
    try {
      const replay = store.check(key, bodyHash);
      if (replay !== null) {
        return json(
          {
            code: "IDEMPOTENT_REPLAY",
            requestId: replay.requestId,
            message: "Same idempotencyKey already processed",
          },
          409,
          traceId,
        );
      }
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

    let agentRes: {
      requestId: string;
      parsed: unknown;
      collision: unknown;
      traceId: string;
    };
    try {
      agentRes = await invokeCreateRequest(
        {
          text,
          idempotencyKey: key,
          now,
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

    store.save(key, bodyHash, agentRes, agentRes.requestId);
    auditLog({
      actor: actor.production,
      request_id: agentRes.requestId,
      trace_id: traceId,
      before: null,
      after: { text, now, requestId: agentRes.requestId },
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

/**
 * TOWER BFF → Agent `/invoke` client (T-05).
 *
 * Contract: base URL from `AGENT_BASE_URL` (default `http://localhost:8000`);
 * every call propagates `X-Trace-Id`; every call races a timeout via
 * AbortController; failures surface as typed {@link AgentError} (never raw).
 * `fetch` is injectable per call so handler tests mock the boundary without
 * any live agent (the Python agent is NOT running in this env).
 *
 * T-11 live-wire: the FastAPI/Agent-Engine wrapper implements
 * `POST /invoke` (op-dispatched: `create_request` | `reroute`) and
 * `GET /slots?date=`. Until then this client is exercised only via mocks.
 */

export const DEFAULT_AGENT_BASE_URL = "http://localhost:8000";

/** Sync-HTTP budget: P95 <3s per PRD G1; BFF aborts earlier to stay inside it. */
export const AGENT_TIMEOUT_MS = 2500;

export function getAgentBaseUrl(): string {
  const raw = process.env.AGENT_BASE_URL;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_AGENT_BASE_URL;
  return raw.trim().replace(/\/+$/, "");
}

export type AgentErrorCode =
  | "IDEMPOTENT_REPLAY"
  | "NEEDS_CLARIFICATION"
  | "STALE_ALTERNATIVE"
  | "INVALID_INTERVAL"
  | "IDEMPOTENCY_KEY_REUSE"
  | "AGENT_UPSTREAM"
  | "AGENT_TIMEOUT";

const KNOWN_CODES: ReadonlySet<string> = new Set([
  "IDEMPOTENT_REPLAY",
  "NEEDS_CLARIFICATION",
  "STALE_ALTERNATIVE",
  "INVALID_INTERVAL",
  "IDEMPOTENCY_KEY_REUSE",
]);

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly status: number;
  readonly traceId: string;
  readonly detail: unknown;

  constructor(opts: {
    code: AgentErrorCode;
    status: number;
    message: string;
    traceId: string;
    detail?: unknown;
  }) {
    super(opts.message);
    this.name = "AgentError";
    this.code = opts.code;
    this.status = opts.status;
    this.traceId = opts.traceId;
    this.detail = opts.detail ?? null;
  }
}

export type FetchImpl = typeof fetch;

export interface InvokeOptions {
  traceId: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorFromStatus(
  status: number,
  data: unknown,
  traceId: string,
  path: string,
): AgentError {
  const code =
    isRecord(data) && typeof data.code === "string" && KNOWN_CODES.has(data.code)
      ? (data.code as AgentErrorCode)
      : "AGENT_UPSTREAM";
  const message =
    isRecord(data) && typeof data.message === "string"
      ? data.message
      : `agent ${path} failed with status ${status}`;
  return new AgentError({ code, status, message, traceId, detail: data });
}

async function readJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * POST one op to the agent with trace propagation + timeout.
 * Normal: parsed JSON `T`. Empty/invalid/unreachable: typed AgentError.
 */
export async function invokeAgent<T>(
  path: string,
  body: unknown,
  opts: InvokeOptions,
): Promise<T> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? AGENT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await fetchImpl(`${getAgentBaseUrl()}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-trace-id": opts.traceId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AgentError({
          code: "AGENT_TIMEOUT",
          status: 504,
          message: `agent ${path} timed out after ${timeoutMs}ms`,
          traceId: opts.traceId,
        });
      }
      throw new AgentError({
        code: "AGENT_UPSTREAM",
        status: 502,
        message: `agent unreachable: ${err instanceof Error ? err.message : String(err)}`,
        traceId: opts.traceId,
      });
    }
    const data = await readJsonSafe(res);
    if (!res.ok) throw errorFromStatus(res.status, data, opts.traceId, path);
    return data as T;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", forwardAbort);
  }
}

/** Agent `create_request` op payload (BFF tags actor + trace per PRD §11). */
export interface CreateRequestInvokeBody {
  op: "create_request";
  text: string;
  idempotencyKey: string;
  now: string;
  actor: string;
  traceId: string;
}

/** Agent `reroute` op payload. */
export interface RerouteInvokeBody {
  op: "reroute";
  requestId: string;
  alternative: {
    resource_id: string;
    resource_type?: string;
    start: string;
    end: string;
  };
  idempotencyKey: string;
  actor: string;
  traceId: string;
}

export interface AgentCreateRequestResponse {
  requestId: string;
  parsed: {
    slots: unknown[];
    confidence: number;
  };
  collision: {
    hasConflict: boolean;
    conflicts: unknown[];
    alternatives: unknown[];
  };
  traceId: string;
}

export interface AgentRerouteResponse {
  status: "confirmed";
  slots: unknown[];
  traceId: string;
}

export function invokeCreateRequest(
  body: Omit<CreateRequestInvokeBody, "op">,
  opts: InvokeOptions,
): Promise<AgentCreateRequestResponse> {
  return invokeAgent<AgentCreateRequestResponse>(
    "/invoke",
    { ...body, op: "create_request" } satisfies CreateRequestInvokeBody,
    opts,
  );
}

export function invokeReroute(
  body: Omit<RerouteInvokeBody, "op">,
  opts: InvokeOptions,
): Promise<AgentRerouteResponse> {
  return invokeAgent<AgentRerouteResponse>(
    "/invoke",
    { ...body, op: "reroute" } satisfies RerouteInvokeBody,
    opts,
  );
}

export interface AgentSlotsResponse {
  date: string;
  slots: unknown[];
}

/**
 * GET day-view slots from the agent with trace propagation.
 * Normal: `{date, slots}`. Empty/invalid/unreachable: typed AgentError.
 */
export async function fetchSlotsFromAgent(
  date: string,
  opts: InvokeOptions,
): Promise<AgentSlotsResponse> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? AGENT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await fetchImpl(
        `${getAgentBaseUrl()}/slots?date=${encodeURIComponent(date)}`,
        {
          method: "GET",
          headers: { "x-trace-id": opts.traceId },
          signal: controller.signal,
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AgentError({
          code: "AGENT_TIMEOUT",
          status: 504,
          message: `agent /slots timed out after ${timeoutMs}ms`,
          traceId: opts.traceId,
        });
      }
      throw new AgentError({
        code: "AGENT_UPSTREAM",
        status: 502,
        message: `agent unreachable: ${err instanceof Error ? err.message : String(err)}`,
        traceId: opts.traceId,
      });
    }
    const data = await readJsonSafe(res);
    if (!res.ok) throw errorFromStatus(res.status, data, opts.traceId, "/slots");
    return data as AgentSlotsResponse;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", forwardAbort);
  }
}

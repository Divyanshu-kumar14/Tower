"use client";

/**
 * useLotMetrics (T-09) — KPI fetcher for the LotHealthStrip with an
 * injectable source. The drawer/radar own slots; health owns metrics.
 *
 * ── Backend contract for T-11 (owns `GET /api/metrics`) ──────────────
 * The default fetcher calls same-origin:
 *
 *   GET /api/metrics?date=YYYY-MM-DD
 *
 * Success (200, `application/json`):
 * ```json
 * {
 *   "date": "2026-09-06",
 *   "utilizationPct": 62.5,
 *   "activeConflicts": 1,
 *   "avgResolveSecs": 94,
 *   "updatedAt": "2026-09-06T12:00:00Z",
 *   "stale": false
 * }
 * ```
 * Field rules (frozen for T-11):
 * - `date` echoes the query date (`YYYY-MM-DD`).
 * - `utilizationPct` is a number in `[0, 100]` (lot utilization %).
 * - `activeConflicts` is an integer `>= 0`.
 * - `avgResolveSecs` is a number `>= 0` (mean conflict resolve time).
 * - `updatedAt` is ISO 8601 UTC when the aggregates were computed.
 * - `stale: true` is a soft signal — render cached values + the stale badge.
 *
 * Degraded paths (Grafana-down UX, PRD E15 — tested, not a gap):
 * - `429` → serve the 30s-cached value + `updated Xs ago` (Retry-After noted).
 * - `404` / `5xx` / network failure → hook returns `stale` with the last
 *   cached values (or empty placeholders on first load); the strip shows
 *   `Observability delayed` and never blocks holds.
 * - Until T-11 ships the route, same-origin `GET /api/metrics` 404s, so the
 *   hook is *permanently stale* in T-09 — that IS the specified behavior.
 *
 * Caching: TanStack `staleTime` 30s (`LOT_METRICS_STALE_MS`) keeps the last
 * good payload (`placeholderData: prev`) across refetches; `updatedAgo`
 * ticks every second for the `updated Xs ago` readout.
 *
 * SSE note: remote-collision pulses ride `useRadarStream` invalidation of
 * `['slots', date]`; metrics re-poll on their own 30s cadence only. Surfacing
 * `collision` SSE payloads as drawer conflicts is a T-11 follow-up (see
 * ConflictDrawer header) — this hook stays parse-local on purpose.
 */
import * as React from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";

export interface LotMetrics {
  /** Lot utilization %, 0–100. */
  utilizationPct: number;
  /** Open conflicts for the date. */
  activeConflicts: number;
  /** Mean conflict resolve time, seconds. */
  avgResolveSecs: number;
}

export type LotMetricsStatus = "loading" | "live" | "stale";

/** 30s cache — matches the PRD §6.5 Grafana-429 path. */
export const LOT_METRICS_STALE_MS = 30_000;

export const lotMetricsKeys = {
  all: ["lot-metrics"] as const,
  byDate: (date: string) => ["lot-metrics", date] as const,
};

export type LotMetricsFetcher = (
  date: string,
  signal?: AbortSignal,
) => Promise<LotMetrics>;

export class MetricsUnavailableError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MetricsUnavailableError";
    this.status = status;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Guard the T-11 payload shape — fail loudly, never render garbage KPIs. */
export function parseLotMetricsBody(body: unknown): LotMetrics {
  if (!isRecord(body)) throw new MetricsUnavailableError(502, "metrics payload is not an object");
  const { utilizationPct, activeConflicts, avgResolveSecs } = body;
  if (
    typeof utilizationPct !== "number" ||
    !Number.isFinite(utilizationPct) ||
    utilizationPct < 0 ||
    utilizationPct > 100
  ) {
    throw new MetricsUnavailableError(502, "metrics payload has invalid utilizationPct");
  }
  if (
    typeof activeConflicts !== "number" ||
    !Number.isInteger(activeConflicts) ||
    activeConflicts < 0
  ) {
    throw new MetricsUnavailableError(502, "metrics payload has invalid activeConflicts");
  }
  if (
    typeof avgResolveSecs !== "number" ||
    !Number.isFinite(avgResolveSecs) ||
    avgResolveSecs < 0
  ) {
    throw new MetricsUnavailableError(502, "metrics payload has invalid avgResolveSecs");
  }
  return { utilizationPct, activeConflicts, avgResolveSecs };
}

/** Default source: same-origin BFF route (T-11 owned — 404s until then). */
export async function fetchLotMetrics(
  date: string,
  signal?: AbortSignal,
): Promise<LotMetrics> {
  let res: Response;
  try {
    res = await fetch(`/api/metrics?date=${encodeURIComponent(date)}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new MetricsUnavailableError(0, "metrics unreachable — check the connection");
  }
  if (!res.ok) {
    throw new MetricsUnavailableError(
      res.status,
      `metrics unavailable (HTTP ${res.status}) — observability delayed`,
    );
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    throw new MetricsUnavailableError(502, "metrics payload is not JSON");
  }
  return parseLotMetricsBody(body);
}

/** `updated 3s ago` / `updated 2m 5s ago` — the PRD §6.5 readout. */
export function formatUpdatedAgo(nowMs: number, updatedAtMs: number | null): string {
  if (updatedAtMs === null || updatedAtMs <= 0) return "never updated";
  const secs = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
  if (secs < 60) return `updated ${secs}s ago`;
  const mins = Math.floor(secs / 60);
  const rest = secs % 60;
  return rest === 0 ? `updated ${mins}m ago` : `updated ${mins}m ${rest}s ago`;
}

export interface UseLotMetricsOptions {
  /** Injectable source — tests pass a stub; prod uses `fetchLotMetrics`. */
  fetcher?: LotMetricsFetcher;
}

export interface UseLotMetricsReturn {
  metrics: LotMetrics | null;
  status: LotMetricsStatus;
  /** Epoch ms of the last successful payload (TanStack `dataUpdatedAt`). */
  updatedAt: number | null;
  updatedAgo: string;
  isStale: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useLotMetrics(
  date: string,
  options: UseLotMetricsOptions = {},
): UseLotMetricsReturn {
  const fetcher = options.fetcher ?? fetchLotMetrics;
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  const query = useQuery({
    queryKey: lotMetricsKeys.byDate(date),
    queryFn: ({ signal }) => fetcher(date, signal),
    staleTime: LOT_METRICS_STALE_MS,
    gcTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
    /* Keep the last good payload visible while a refetch fails (E15). */
    placeholderData: (prev) => prev,
  });

  /* 1s ticker for the `updated Xs ago` readout only — cheap, local. */
  React.useEffect(() => {
    if (query.dataUpdatedAt === 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [query.dataUpdatedAt]);

  const metrics = query.data ?? null;
  const updatedAt = query.dataUpdatedAt === 0 ? null : query.dataUpdatedAt;
  const failed = query.isError;
  const status: LotMetricsStatus =
    metrics !== null && !failed ? "live" : query.isPending && metrics === null ? "loading" : "stale";

  return {
    metrics,
    status,
    updatedAt,
    updatedAgo: formatUpdatedAgo(nowMs, updatedAt),
    isStale: status === "stale",
    error: failed ? (query.error instanceof Error ? query.error : new Error(String(query.error))) : null,
    refetch: () => void query.refetch(),
  };
}

/** Invalidate the day's metrics (reroute confirm path reuses this). */
export function invalidateLotMetrics(queryClient: QueryClient, date: string): void {
  void queryClient.invalidateQueries({ queryKey: lotMetricsKeys.byDate(date) });
}

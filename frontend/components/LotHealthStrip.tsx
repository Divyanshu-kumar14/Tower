"use client";

/**
 * LotHealthStrip (T-09) — the KPI ops line: utilization, active conflicts,
 * avg resolve. A single asymmetric strip (NOT three equal cards — craft
 * floor refuses the hero-metric template): label rail on the left, inline
 * KPI segments split by hairline dividers, freshness readout on the right.
 *
 * Data: `useLotMetrics(date)` (fetcher injectable via prop for tests).
 * `GET /api/metrics` does NOT exist yet (T-11 backend) → the hook returns
 * `stale` and this strip shows cached/empty values + the `Observability
 * delayed` badge + the `LiveDot` stream status from `useRadarStream`
 * (passed in as props — the page owns the single subscription). This IS
 * the Grafana-down UX path (PRD E15), tested with fake timers, not a gap.
 *
 * Mount contract: keeps `data-mount="lot-health"` + `aria-label="Lot
 * health"` so the T-08 placeholder tests and e2e keep passing.
 */
import * as React from "react";
import type { RadarStreamStatus } from "../hooks/useRadarStream";
import {
  useLotMetrics,
  type LotMetricsFetcher,
} from "../hooks/useLotMetrics";
import { cn } from "./ui/utils";

export interface LotHealthStripProps {
  /** Viewed UTC date, YYYY-MM-DD. */
  date: string;
  /** Live status owned by the page's `useRadarStream(date)` subscription. */
  streamStatus: RadarStreamStatus;
  /** Epoch ms of the last applied SSE event (mono readout). */
  lastEventAt: number | null;
  /** Injectable metrics source — tests pass a stub. */
  fetcher?: LotMetricsFetcher;
}

function formatResolve(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const r = Math.round(secs % 60);
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

function Kpi({
  label,
  value,
  stale,
}: {
  label: string;
  value: string;
  stale: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 px-4 first:pl-0 last:pr-0">
      <span
        className={cn(
          "tower-data text-lg font-semibold tabular-nums",
          stale ? "text-slate-400" : "text-slate-100",
        )}
      >
        {value}
      </span>
      <span className="whitespace-nowrap text-[12px] font-medium text-slate-400">
        {label}
      </span>
    </div>
  );
}

export function LotHealthStrip({
  date,
  streamStatus,
  lastEventAt,
  fetcher,
}: LotHealthStripProps) {
  const { metrics, status, updatedAgo, isStale, refetch } = useLotMetrics(date, {
    fetcher,
  });
  const stale = isStale || status === "loading";

  const eventTime =
    lastEventAt !== null ? new Date(lastEventAt).toISOString().slice(11, 19) : null;

  return (
    <section
      aria-label="Lot health"
      data-mount="lot-health"
      data-testid="lot-health"
      data-health={status}
      className="border border-slate-800 bg-slate-950"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
        {/* Label rail — asymmetric anchor, deliberately narrow. */}
        <div className="flex min-w-[118px] flex-col gap-1">
          <span className="text-[13px] font-semibold text-slate-200">Lot health</span>
          <span className="tower-data text-[11px] text-slate-400">{date}</span>
        </div>

        {/* Status: live emerald vs `Observability delayed` stale badge. */}
        {stale ? (
          <p className="flex items-center gap-2">
            <span
              data-testid="health-stale-badge"
              role="status"
              className="inline-flex items-center gap-1.5 rounded-[2px] border border-amber-400/50 bg-amber-400/10 px-2 py-1 text-[12px] font-semibold text-amber-200"
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-400" />
              Observability delayed
            </span>
            <button
              type="button"
              onClick={refetch}
              className="tower-focus rounded-[2px] border border-slate-700 px-2 py-1 text-[12px] font-semibold text-slate-200 transition-colors duration-150 ease-out hover:border-cyan-400 hover:text-cyan-300"
            >
              Retry
            </button>
          </p>
        ) : (
          <p className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-emerald-400"
            />
            <span className="text-[12px] font-semibold text-emerald-200">Live</span>
          </p>
        )}

        {/* KPI segments — inline with dividers, uneven widths, never cards. */}
        <div
          className="flex min-w-0 flex-1 flex-wrap items-center divide-x divide-slate-800"
          aria-label="Lot key figures"
        >
          <Kpi
            label="utilization"
            value={metrics !== null ? `${metrics.utilizationPct.toFixed(1)}%` : "—"}
            stale={stale}
          />
          <Kpi
            label="active conflicts"
            value={metrics !== null ? String(metrics.activeConflicts) : "—"}
            stale={stale}
          />
          <Kpi
            label="avg resolve"
            value={metrics !== null ? formatResolve(metrics.avgResolveSecs) : "—"}
            stale={stale}
          />
        </div>

        {/* Freshness + stream readout (mono data, slate-400 ≥4.5:1). */}
        <p className="tower-data ml-auto text-[11px] text-slate-400">
          {status === "loading" ? "probing observability…" : updatedAgo}
          <span aria-hidden="true"> · </span>
          <span
            className={cn(
              streamStatus === "live" ? "text-emerald-200" : "text-amber-200",
            )}
          >
            {streamStatus === "live" ? "STREAM LIVE" : streamStatus === "reconnecting" ? "STREAM RECONNECTING" : "STREAM POLLING"}
          </span>
          {eventTime ? <span> · EVENT {eventTime}</span> : null}
        </p>
      </div>
      {stale ? (
        <p className="tower-secondary border-t border-slate-800/80 px-4 py-2 text-[12px]">
          Metrics cache is older than 30s or unreachable — holds still confirm
          from the local ledger. Grafana link wires in T-11.
        </p>
      ) : null}
    </section>
  );
}

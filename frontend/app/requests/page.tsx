"use client";

/**
 * `/requests` (T-09) — history + audit: every filed request as a ledger
 * row (production, window, status, trace link).
 *
 * Source: the TanStack slots cache (`['slots', date]` keys T-07/T-08
 * populate — parse responses invalidate it, SSE `slot:confirmed` refreshes
 * it), merged across cached dates + a live fetch for the viewed date, so
 * the table works warm (post-demo clicks) AND cold (direct navigation).
 * Rows derive from slots (one row per stage hold; crew/gear kin collapse
 * into the production cell) — the parse-result history rides along because
 * every parse writes through this same cache.
 *
 * TraceLink (see `components/TraceLink.tsx` — kept out of this page module
 * because Next.js pages may only export the page component): mono trace id
 * + copy-to-clipboard. Tempo deep-link shape (T-11 wires
 * `NEXT_PUBLIC_GRAFANA_URL`):
 *   {GRAFANA_URL}/explore?orgId=1&left={"datasource":{"type":"tempo"},"queries":[{"queryType":"traceql","query":"trace_id=\"<traceId>\""}]}
 * Until T-11 sets the env var, the link renders as copy-only with the shape
 * documented in the `title` tooltip — never a dead link.
 */
import * as React from "react";
import { Suspense } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { LiveDot } from "../../components/RadarScope";
import { useRadarStream } from "../../hooks/useRadarStream";
import { slotKeys } from "../../lib/query-client";
import { slotSchema, slotsQuerySchema, type Slot } from "../../lib/validator";
import { Badge } from "../../components/ui/badge";
import { TraceLink } from "../../components/TraceLink";
import { cn } from "../../components/ui/utils";

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fetchSlots(date: string): Promise<Slot[]> {
  const res = await fetch(`/api/slots?date=${encodeURIComponent(date)}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Slots unavailable (HTTP ${res.status}) — check the connection and retry.`,
    );
  }
  const body = (await res.json()) as { slots?: unknown[] };
  const list = Array.isArray(body.slots) ? body.slots : [];
  const out: Slot[] = [];
  for (const raw of list) {
    const parsed = slotSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

interface HistoryRow {
  key: string;
  production: string;
  resourceId: string;
  window: string;
  status: Slot["status"];
  traceId: string;
  kin: string[];
}

function toRows(slots: Slot[]): HistoryRow[] {
  const kinByRequest = new Map<string, string[]>();
  for (const s of slots) {
    if (s.resource_type === "stage") continue;
    const list = kinByRequest.get(s.request_id) ?? [];
    list.push(s.resource_id);
    kinByRequest.set(s.request_id, list);
  }
  return slots
    .filter((s) => s.resource_type === "stage")
    .map((s) => ({
      key: s.id,
      production: s.production,
      resourceId: s.resource_id,
      window: `${s.start.slice(0, 10)} ${s.start.slice(11, 16)}–${s.end.slice(11, 16)}`,
      status: s.status,
      traceId: s.trace_id,
      kin: kinByRequest.get(s.request_id) ?? [],
    }))
    .sort((a, b) => (a.window < b.window ? -1 : a.window > b.window ? 1 : 0));
}

function statusBadge(status: Slot["status"]) {
  if (status === "confirmed") return <Badge variant="confirmed">confirmed</Badge>;
  if (status === "holding") return <Badge variant="holding">holding</Badge>;
  return <Badge variant="neutral">released</Badge>;
}

function RequestsInner() {
  const searchParams = useSearchParams();
  const rawDate = searchParams.get("date");
  const checkedDate = rawDate ? slotsQuerySchema.safeParse({ date: rawDate }) : null;
  const date = checkedDate?.success ? checkedDate.data.date : todayUTC();

  const queryClient = useQueryClient();
  const stream = useRadarStream(date);
  const slotsQuery = useQuery({
    queryKey: slotKeys.byDate(date),
    queryFn: () => fetchSlots(date),
  });

  /* Merge the live date query with every warm ['slots', *] cache entry. */
  const cached = queryClient.getQueriesData<Slot[]>({ queryKey: slotKeys.all });
  const merged = React.useMemo(() => {
    const byId = new Map<string, Slot>();
    for (const [, data] of cached) {
      if (!Array.isArray(data)) continue;
      for (const s of data) byId.set(s.id, s);
    }
    for (const s of slotsQuery.data ?? []) byId.set(s.id, s);
    return [...byId.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cached.length, slotsQuery.data]);

  const rows = React.useMemo(() => toRows(merged), [merged]);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pb-16 pt-6">
      <header className="flex flex-wrap items-center gap-3">
        <a
          href="/"
          className="tower-focus rounded-[2px] border border-slate-700 px-3 py-1.5 text-[13px] font-semibold text-slate-200 transition-colors duration-150 ease-out hover:border-cyan-400 hover:text-cyan-300"
        >
          ← Radar
        </a>
        <h1 className="text-xl font-bold tracking-tight text-slate-100">
          Request history{" "}
          <span className="tower-data text-sm font-normal text-slate-400">{date}</span>
        </h1>
        <div className="ml-auto">
          <LiveDot status={stream.status} lastEventAt={stream.lastEventAt} />
        </div>
      </header>

      {rawDate && checkedDate && !checkedDate.success ? (
        <p role="status" className="text-[13px] text-amber-200">
          {`Invalid ?date "${rawDate}" — showing today. Use YYYY-MM-DD.`}
        </p>
      ) : null}

      {slotsQuery.isError ? (
        <p role="alert" className="text-[13px] text-rose-300">
          {slotsQuery.error instanceof Error
            ? slotsQuery.error.message
            : "Slots unavailable — check the connection and retry."}{" "}
          <button
            type="button"
            onClick={() => void slotsQuery.refetch()}
            className="tower-focus rounded-[2px] border border-slate-700 px-2 py-1 text-[12px] font-semibold text-slate-200 transition-colors duration-150 ease-out hover:border-cyan-400 hover:text-cyan-300"
          >
            Retry
          </button>
        </p>
      ) : null}

      {slotsQuery.isLoading && rows.length === 0 ? (
        <p className="tower-secondary text-[13px]">Loading the ledger…</p>
      ) : rows.length === 0 ? (
        <div className="border border-slate-800 px-4 py-6">
          <p className="text-[13px] font-semibold text-slate-200">No requests on the wire</p>
          <p className="tower-secondary mt-1 text-[13px]">
            File a request from the radar and it lands here with its trace.
          </p>
          <a
            href={`/?date=${date}`}
            className="tower-focus mt-3 inline-block rounded-[2px] border border-slate-700 px-3 py-1.5 text-[13px] font-semibold text-slate-200 transition-colors duration-150 ease-out hover:border-cyan-400 hover:text-cyan-300"
          >
            Open the radar →
          </a>
        </div>
      ) : (
        <div className="overflow-x-auto border border-slate-800">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <caption className="sr-only">
              Filed requests: production, window, status, trace link
            </caption>
            <thead>
              <tr className="border-b border-slate-800">
                {["Production", "Window", "Status", "Trace"].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-4 py-2 text-[12px] font-semibold uppercase tracking-wide text-slate-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={row.key}
                  data-testid="request-row"
                  className={cn(
                    "border-b border-slate-800/60 last:border-b-0",
                    i % 2 === 1 && "bg-slate-900/40",
                  )}
                >
                  <td className="px-4 py-2.5">
                    <p className="text-[13px] font-semibold text-slate-100">
                      {row.production}
                    </p>
                    <p className="tower-data text-[11px] text-slate-400">
                      {row.resourceId}
                      {row.kin.length > 0 ? ` · ${row.kin.join(", ")}` : ""}
                    </p>
                  </td>
                  <td className="tower-data px-4 py-2.5 text-[12px] text-slate-300">
                    {row.window}
                  </td>
                  <td className="px-4 py-2.5">{statusBadge(row.status)}</td>
                  <td className="max-w-[220px] px-4 py-2.5">
                    <TraceLink traceId={row.traceId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="tower-data text-[11px] text-slate-500">
        {rows.length} HOLDS · SOURCE: TANSTACK SLOTS CACHE + LIVE FETCH · TEMPO LINK WIRES IN T-11
      </p>
    </main>
  );
}

export default function RequestsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
          <p className="tower-secondary text-[13px]">Loading history…</p>
        </main>
      }
    >
      <RequestsInner />
    </Suspense>
  );
}

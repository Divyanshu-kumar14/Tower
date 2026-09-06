"use client";

/**
 * `/` (T-08) — the ops stream: transmit console on top, radar scope beneath.
 *
 * Composition (PRD §6.1): TowerQueryProvider (layout) + RequestBar (T-07,
 * driven by `useParse`) + RadarScope + LiveDot. No hero, no metric cards,
 * no split layout — one vertical stream. The lot-health strip is T-09:
 * a typed `LotHealthMount` placeholder reserves its place.
 *
 * Wiring owned here:
 * - `useRadarStream(date)` invalidates `['slots', date]` on SSE events;
 *   this page reads the same key, so the scope re-renders live.
 * - `onSelectSlot` sets `selectedSlot` AND scrolls to the `slot-<id>`
 *   timeline anchor (the selected-hold card below the scope; the same
 *   anchor id scheme the `/timeline` gantt uses, which T-09's drawer
 *   will reuse).
 * - `onProposeMove` surfaces a proposal notice — the actual reroute POST
 *   is T-09/T-05 territory, never fired from here.
 */
import * as React from "react";
import { Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { RequestBar, type RequestBarParseState } from "../components/RequestBar";
import { ConflictDrawer } from "../components/ConflictDrawer";
import { LotHealthStrip } from "../components/LotHealthStrip";
import {
  LiveDot,
  RadarScope,
  type ProposedMove,
  type SelectedSlot,
} from "../components/RadarScope";
import { SlotCard } from "../components/SlotCard";
import { useParse } from "../hooks/useParse";
import { useRadarStream } from "../hooks/useRadarStream";
import { slotKeys } from "../lib/query-client";
import { slotSchema, slotsQuerySchema, type Slot } from "../lib/validator";

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fetchSlots(date: string): Promise<Slot[]> {
  const res = await fetch(`/api/slots?date=${encodeURIComponent(date)}`, {
    /* Browser HTTP cache would 304 with no body TanStack can't reuse —
       the BFF ETag path stays exercised via curl/tests, not this fetch. */
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

function HomeInner() {
  const searchParams = useSearchParams();
  const rawDate = searchParams.get("date");
  const checkedDate = rawDate ? slotsQuerySchema.safeParse({ date: rawDate }) : null;
  const date = checkedDate?.success ? checkedDate.data.date : todayUTC();
  const dateNotice =
    rawDate && checkedDate && !checkedDate.success
      ? `Invalid ?date "${rawDate}" — showing today. Use YYYY-MM-DD.`
      : null;

  const parse = useParse();
  const stream = useRadarStream(date);
  const slotsQuery = useQuery({
    queryKey: slotKeys.byDate(date),
    queryFn: () => fetchSlots(date),
  });
  const [selectedSlot, setSelectedSlot] = React.useState<SelectedSlot | null>(null);
  const [proposal, setProposal] = React.useState<ProposedMove | null>(null);
  /* Drawer dismissal is keyed by request — a new conflict re-opens it. */
  const [dismissedFor, setDismissedFor] = React.useState<string | null>(null);

  const slots = slotsQuery.data ?? [];

  /* T-09: the drawer opens on the parse conflict (request-level so the
     canned demo needs no blip selection first; the selected hold rides
     along when present). SSE remote-collision surfacing stays a T-11
     follow-up — see ConflictDrawer header. */
  const drawerOpen =
    parse.hasConflict && parse.requestId !== null && dismissedFor !== parse.requestId;

  const parseState: RequestBarParseState = {
    status: parse.status,
    chips: parse.chips,
    clarification: parse.clarification,
    unknownResource: parse.unknownResource,
    error: parse.error,
    notice: parse.notice,
    hasConflict: parse.hasConflict,
    conflicts: parse.conflicts,
    traceId: parse.traceId,
  };

  const handleSelect = (sel: SelectedSlot | null) => {
    setSelectedSlot(sel);
    if (sel) {
      requestAnimationFrame(() => {
        document.getElementById(`slot-${sel.slotId}`)?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      });
    }
  };

  const selected =
    selectedSlot !== null ? slots.find((s) => s.id === selectedSlot.slotId) ?? null : null;
  const selectedKin = selected
    ? slots.filter(
        (s) => s.request_id === selected.request_id && s.resource_type !== "stage",
      )
    : [];

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pb-16 pt-6">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100">
            TOWER{" "}
            <span className="tower-secondary text-sm font-normal">
              Studio lot air-traffic control
            </span>
          </h1>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <LiveDot status={stream.status} lastEventAt={stream.lastEventAt} />
          <a
            href={`/timeline?date=${date}`}
            className="tower-focus rounded-[2px] border border-slate-700 px-3 py-1.5 text-[13px] font-semibold text-slate-200 transition-colors duration-150 ease-out hover:border-cyan-400 hover:text-cyan-300"
          >
            Day timeline →
          </a>
        </div>
      </header>

      {dateNotice ? (
        <p role="status" className="text-[13px] text-amber-200">
          {dateNotice}
        </p>
      ) : null}

      <RequestBar
        onSubmit={(text, key) => void parse.submit(text, key)}
        isLoading={parse.status === "parsing"}
        parse={parse.status === "idle" ? null : parseState}
        shakeKey={parse.shakeKey}
        onSuggestionSelect={(s) => void parse.submit(s)}
      />

      {slotsQuery.isError ? (
        <p role="alert" className="flex flex-wrap items-center gap-3 text-[13px] text-rose-300">
          {slotsQuery.error instanceof Error
            ? slotsQuery.error.message
            : "Slots unavailable — check the connection and retry."}
          <button
            type="button"
            onClick={() => void slotsQuery.refetch()}
            className="tower-focus rounded-[2px] border border-slate-700 px-2 py-1 text-[12px] font-semibold text-slate-200 transition-colors duration-150 ease-out hover:border-cyan-400 hover:text-cyan-300"
          >
            Retry
          </button>
        </p>
      ) : null}

      <RadarScope
        slots={slots}
        date={date}
        selectedSlot={selectedSlot}
        onSelectSlot={handleSelect}
        onProposeMove={setProposal}
        conflicts={parse.conflicts}
        isLoading={slotsQuery.isLoading}
      />

      {selected ? (
        <article
          id={`slot-${selected.id}`}
          data-testid="selected-slot"
          aria-label="Selected hold"
          className="scroll-mt-4 border border-cyan-400/40 bg-cyan-400/5 px-4 py-3"
        >
          <p className="mb-2 text-[13px] font-semibold text-slate-200">
            Selected hold{" "}
            <span className="tower-data text-[11px] font-normal text-slate-400">
              {selected.resource_id} · ANCHOR slot-{selected.id}
            </span>
          </p>
          <SlotCard
            slot={selected}
            crewLabels={selectedKin.filter((s) => s.resource_type === "crew").map((s) => s.resource_id)}
            gearLabels={selectedKin.filter((s) => s.resource_type === "gear").map((s) => s.resource_id)}
            conflicted={parse.conflicts.some((c) => c.resource_id === selected.resource_id)}
            selected
            onSelect={() => handleSelect(null)}
          />
          <a
            href={`/timeline?date=${date}#slot-${selected.id}`}
            className="tower-focus tower-data mt-2 inline-block text-[12px] text-cyan-300 underline"
          >
            Open in day timeline →
          </a>
        </article>
      ) : null}

      {proposal ? (
        <p
          role="status"
          data-testid="proposal-notice"
          className="tower-data border border-cyan-400/40 bg-cyan-400/5 px-4 py-2 text-[12px] text-cyan-200"
        >
          Proposed {proposal.slotId} → {proposal.toResourceId}{" "}
          {proposal.toStart.slice(11, 16)}–{proposal.toEnd.slice(11, 16)} — confirm
          in the conflict drawer.
        </p>
      ) : null}

      <ConflictDrawer
        date={date}
        requestId={parse.requestId}
        conflicts={parse.conflicts}
        alternatives={parse.alternatives}
        selectedSlot={selectedSlot}
        proposedMove={proposal}
        traceId={parse.traceId}
        open={drawerOpen}
        onClose={() => setDismissedFor(parse.requestId)}
        onRerouted={() => setProposal(null)}
        onRefreshAlternatives={() => void slotsQuery.refetch()}
      />

      <LotHealthStrip
        date={date}
        streamStatus={stream.status}
        lastEventAt={stream.lastEventAt}
      />
    </main>
  );
}

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
          <p className="tower-secondary text-[13px]">Loading the lot…</p>
        </main>
      }
    >
      <HomeInner />
    </Suspense>
  );
}

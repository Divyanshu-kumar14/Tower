"use client";

/**
 * `/timeline` (T-08) — gantt day view. `?date&stage` are Zod-validated
 * search params (invalid values fall back with a notice naming the problem
 * + recovery, never a blank or a throw). Composes the same `['slots', date]`
 * cache + `useRadarStream` live status as `/`, so both views stay in sync.
 */
import * as React from "react";
import { Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
import { TimelineGantt } from "../../components/TimelineGantt";
import {
  LiveDot,
  type ProposedMove,
  type SelectedSlot,
} from "../../components/RadarScope";
import { useRadarStream } from "../../hooks/useRadarStream";
import { slotKeys } from "../../lib/query-client";
import { slotSchema, slotsQuerySchema, type Slot } from "../../lib/validator";
import { cn } from "../../components/ui/utils";

const stageParamSchema = z.enum(["stage-1", "stage-2", "stage-3", "adr-suite"]);

const STAGE_CHIPS = [
  { id: null as string | null, label: "All pads" },
  { id: "stage-3", label: "Stage 3" },
  { id: "stage-2", label: "Stage 2" },
  { id: "stage-1", label: "Stage 1" },
  { id: "adr-suite", label: "ADR Suite" },
];

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

function TimelineInner() {
  const searchParams = useSearchParams();
  const rawDate = searchParams.get("date");
  const rawStage = searchParams.get("stage");

  const checkedDate = rawDate ? slotsQuerySchema.safeParse({ date: rawDate }) : null;
  const date = checkedDate?.success ? checkedDate.data.date : todayUTC();
  const checkedStage = rawStage ? stageParamSchema.safeParse(rawStage) : null;
  const stageFilter = checkedStage?.success ? checkedStage.data : null;

  const notices: string[] = [];
  if (rawDate && checkedDate && !checkedDate.success) {
    notices.push(`Invalid ?date "${rawDate}" — showing today. Use YYYY-MM-DD.`);
  }
  if (rawStage && checkedStage && !checkedStage.success) {
    notices.push(`Unknown ?stage "${rawStage}" — showing all pads.`);
  }

  const stream = useRadarStream(date);
  const slotsQuery = useQuery({
    queryKey: slotKeys.byDate(date),
    queryFn: () => fetchSlots(date),
  });
  const [selectedSlot, setSelectedSlot] = React.useState<SelectedSlot | null>(null);
  const [proposal, setProposal] = React.useState<ProposedMove | null>(null);

  const slots = slotsQuery.data ?? [];

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
          Day timeline{" "}
          <span className="tower-data text-sm font-normal text-slate-400">{date}</span>
        </h1>
        <div className="ml-auto">
          <LiveDot status={stream.status} lastEventAt={stream.lastEventAt} />
        </div>
      </header>

      {notices.map((notice) => (
        <p key={notice} role="status" className="text-[13px] text-amber-200">
          {notice}
        </p>
      ))}

      <nav aria-label="Stage filter" className="flex flex-wrap gap-2">
        {STAGE_CHIPS.map((chip) => {
          const active = stageFilter === chip.id;
          const href =
            chip.id === null
              ? `/timeline?date=${date}`
              : `/timeline?date=${date}&stage=${chip.id}`;
          return (
            <a
              key={chip.label}
              href={href}
              aria-current={active ? "true" : undefined}
              className={cn(
                "tower-focus rounded-[2px] border px-3 py-1.5 text-[13px] font-semibold transition-colors duration-150 ease-out",
                active
                  ? "border-cyan-400 bg-cyan-400/10 text-cyan-200"
                  : "border-slate-700 text-slate-200 hover:border-cyan-400 hover:text-cyan-300",
              )}
            >
              {chip.label}
            </a>
          );
        })}
      </nav>

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

      <TimelineGantt
        slots={slots}
        date={date}
        selectedSlot={selectedSlot}
        onSelectSlot={setSelectedSlot}
        isLoading={slotsQuery.isLoading}
        onProposeMove={setProposal}
        stageFilter={stageFilter}
      />

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
    </main>
  );
}

export default function TimelinePage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
          <p className="tower-secondary text-[13px]">Loading the timeline…</p>
        </main>
      }
    >
      <TimelineInner />
    </Suspense>
  );
}

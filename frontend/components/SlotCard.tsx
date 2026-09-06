"use client";

/**
 * SlotCard (T-08) — one hold on the lot, rendered inside TimelineGantt rows
 * and the home page's selected-hold anchor.
 *
 * Presentational + selection only: a real `<button>` (free keyboard +
 * focus), production set as React text (escaped — XSS E21 is proven by the
 * snapshot test, the radar tooltip path is DOMPurified separately).
 * Status tints follow the pinned world: emerald confirmed / amber holding /
 * slate released; `conflicted` overlays a rose stripe wash (the gantt is a
 * measuring canvas, which earns the stripe); `selected` draws the cyan ATC
 * ring. Timecodes + trace IDs are JetBrains Mono (`.tower-data`); names are
 * Inter. 150ms ease-out on state changes, no bounce.
 */
import * as React from "react";
import { cn } from "./ui/utils";

export interface SlotCardData {
  id: string;
  production: string;
  resource_type: "stage" | "gear" | "crew";
  resource_id: string;
  start: string;
  end: string;
  status: "holding" | "confirmed" | "released";
  request_id: string;
  trace_id: string;
}

export interface SlotCardProps {
  slot: SlotCardData;
  /** Same-request crew holds, e.g. ["crew-maya"]. */
  crewLabels?: string[];
  /** Same-request gear holds, e.g. ["alexa-65"]. */
  gearLabels?: string[];
  /** Overlaps a peer on the same pad → rose-striped (US-02). */
  conflicted?: boolean;
  selected?: boolean;
  onSelect?: (slotId: string) => void;
  className?: string;
}

const STATUS_TONE: Record<SlotCardData["status"], string> = {
  confirmed: "border-emerald-400/50 bg-emerald-400/10 text-emerald-100",
  holding: "border-amber-400/50 bg-amber-400/10 text-amber-100",
  released: "border-slate-700 bg-slate-800/50 text-slate-400",
};

export function SlotCard({
  slot,
  crewLabels = [],
  gearLabels = [],
  conflicted = false,
  selected = false,
  onSelect,
  className,
}: SlotCardProps) {
  const window = `${slot.start.slice(11, 16)}–${slot.end.slice(11, 16)}`;
  const detail =
    [...crewLabels, ...gearLabels].length > 0
      ? [...crewLabels, ...gearLabels].join(" · ")
      : null;

  return (
    <button
      type="button"
      data-testid="slot-card"
      data-slot-id={slot.id}
      aria-pressed={selected}
      aria-label={`${slot.production}, ${slot.resource_id} ${window}${conflicted ? ", conflicting" : ""}`}
      onClick={() => onSelect?.(slot.id)}
      style={
        conflicted
          ? {
              backgroundImage:
                "repeating-linear-gradient(45deg, rgb(244 63 94 / 0.28) 0 8px, transparent 8px 16px)",
            }
          : undefined
      }
      className={cn(
        "tower-focus flex min-h-[52px] w-full flex-col justify-center gap-0.5 overflow-hidden rounded-[2px] border px-2 py-1 text-left transition-colors duration-150 ease-out",
        STATUS_TONE[slot.status],
        conflicted && "border-rose-500 bg-rose-500/10 text-rose-100",
        selected && "outline outline-2 outline-offset-1 outline-cyan-400",
        className,
      )}
    >
      <span className="truncate text-[13px] font-semibold leading-tight text-slate-100">
        {slot.production}
      </span>
      <span className="tower-data truncate text-[11px] leading-tight opacity-90">
        {slot.resource_id} · {window}
      </span>
      {detail ? (
        <span className="tower-data truncate text-[10px] leading-tight opacity-75">
          {detail}
        </span>
      ) : null}
      <span className="tower-data truncate text-[10px] leading-tight opacity-60">
        trace {slot.trace_id}
      </span>
    </button>
  );
}

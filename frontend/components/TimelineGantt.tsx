"use client";

/**
 * TimelineGantt (T-08) — day view of the lot: 4 stage rows × 00–24h in
 * 30-minute buckets, holds as absolute-positioned SlotCards.
 *
 * - Collision overlap on a pad renders rose-striped (US-02; the gantt is a
 *   measuring canvas, which earns the stripe) via the same overlap rule as
 *   the graph (`slot-check.ts`).
 * - Overnight holds (E07) clip to the viewed date with chevron cut-marks;
 *   zero-duration / end<=start data is rejected client-side (never
 *   rendered, never sent).
 * - Drag-to-reroute: horizontal drag snaps to 30min buckets, pre-validates
 *   through `canPlaceSlot`, then calls `onProposeMove` — invalid drops
 *   shake + toast with NO api call (T-09/T-05 own mutations).
 * - Virtualization (E23): only holds intersecting the viewport ± one
 *   viewport buffer mount; see the windowing math below.
 * - Keyboard: every hold is a real `<button>` (SlotCard); selection
 *   toggles and reports upward for T-09's drawer.
 */
import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { SlotCard, type SlotCardData } from "./SlotCard";
import type { ProposedMove, SelectedSlot } from "./RadarScope";
import {
  canPlaceSlot,
  clipSlotToDate,
  slotsOverlap,
  validateInterval,
} from "../lib/slot-check";
import { cn } from "./ui/utils";
import { Skeleton } from "./ui/skeleton";

export interface TimelineGanttProps {
  /** All slots for the date (stage rows render `resource_type === "stage"`). */
  slots: SlotCardData[];
  /** Viewed UTC date, YYYY-MM-DD. */
  date: string;
  selectedSlot: SelectedSlot | null;
  onSelectSlot: (sel: SelectedSlot | null) => void;
  /** Resource ids known to be conflicted (parse collisions) — rose pulse. */
  conflictResourceIds?: string[];
  isLoading?: boolean;
  onProposeMove?: (move: ProposedMove) => void;
  /** `?stage=` filter — non-matching rows dim, never unmount. */
  stageFilter?: string | null;
}

interface StageRow {
  id: string;
  label: string;
  sub: string;
}

/* Ops priority: the demo conflict lives on Stage 3, so it reads first. */
const STAGE_ROWS: StageRow[] = [
  { id: "stage-3", label: "Stage 3", sub: "3000 SQFT" },
  { id: "stage-2", label: "Stage 2", sub: "3000 SQFT · ALT" },
  { id: "stage-1", label: "Stage 1", sub: "2000 SQFT" },
  { id: "adr-suite", label: "ADR Suite", sub: "DIALOGUE" },
];

const BUCKETS_PER_DAY = 48;
const LANE_MIN_W = 1280;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Placed {
  slot: SlotCardData;
  segStart: number;
  segEnd: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function shiftIso(iso: string, deltaMin: number): string {
  const ms = Date.parse(iso) + deltaMin * 60 * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:00Z`;
}

function reasonMessage(reason: string, resourceId: string): string {
  if (reason === "INVALID_INTERVAL") {
    return "Move rejected — zero-length window. Drag further or pick a new window.";
  }
  if (reason.startsWith("OVERLAP:")) {
    const blocker = reason.slice("OVERLAP:".length);
    return `Move rejected — overlaps ${blocker} on ${resourceId}. Pick a clear window.`;
  }
  if (reason === "SEPARATION_VIOLATION") {
    return "Move rejected — 30min stage turnaround violated. Slide further out.";
  }
  if (reason === "CREW_REST_VIOLATION") {
    return "Move rejected — 11h crew rest violated. Pick a rested window.";
  }
  return "Move rejected — that window is not placeable. Pick another.";
}

export function TimelineGantt({
  slots,
  date,
  selectedSlot,
  onSelectSlot,
  conflictResourceIds = [],
  isLoading = false,
  onProposeMove,
  stageFilter = null,
}: TimelineGanttProps) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const laneRef = React.useRef<HTMLDivElement>(null);
  const shakeRef = React.useRef<HTMLDivElement>(null);
  const [view, setView] = React.useState({ left: 0, width: 0 });
  const [laneW, setLaneW] = React.useState(LANE_MIN_W);
  const [toast, setToast] = React.useState<{ id: number; msg: string } | null>(null);
  const [dragPx, setDragPx] = React.useState<{ slotId: string; dx: number } | null>(null);
  const dragRef = React.useRef<{ slotId: string; startX: number } | null>(null);
  const toastTimerRef = React.useRef<number | null>(null);

  React.useEffect(
    () => () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const measure = React.useCallback(() => {
    const vp = viewportRef.current;
    if (vp) setView({ left: vp.scrollLeft, width: vp.clientWidth });
    const w = laneRef.current?.getBoundingClientRect().width ?? 0;
    setLaneW(w > 0 ? w : LANE_MIN_W);
  }, []);

  React.useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const showToast = (msg: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), msg });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4000);
  };

  /**
   * Guard-reject shake: restart the CSS animation synchronously via reflow.
   * No key-remount — remounting would detach focused/dragged nodes and
   * replay every blip entrance on each reject.
   */
  const triggerShake = () => {
    const el = shakeRef.current;
    if (!el) return;
    el.classList.remove("animate-tower-shake");
    void el.offsetWidth;
    el.classList.add("animate-tower-shake");
  };

  const dayStartMs = Date.parse(`${date}T00:00:00Z`);
  const dayValid = Number.isFinite(dayStartMs);

  const stageSlots = React.useMemo(
    () => slots.filter((s) => s.resource_type === "stage"),
    [slots],
  );

  /* Same-request crew/gear labels for each card (US-01 chip river parity). */
  const kinByRequest = React.useMemo(() => {
    const map = new Map<string, { crew: string[]; gear: string[] }>();
    for (const s of slots) {
      let kin = map.get(s.request_id);
      if (!kin) {
        kin = { crew: [], gear: [] };
        map.set(s.request_id, kin);
      }
      if (s.resource_type === "crew") kin.crew.push(s.resource_id);
      if (s.resource_type === "gear") kin.gear.push(s.resource_id);
    }
    return map;
  }, [slots]);

  const placedByRow = React.useMemo(() => {
    const out = new Map<string, Placed[]>();
    if (!dayValid) return out;
    for (const row of STAGE_ROWS) {
      const list: Placed[] = [];
      for (const s of stageSlots) {
        if (s.resource_id !== row.id) continue;
        /* Zero-duration / end<=start rejected client-side: never rendered. */
        if (!validateInterval(s.start, s.end)) continue;
        const seg = clipSlotToDate(s, date);
        if (!seg) continue;
        list.push({
          slot: s,
          segStart: seg.startMs,
          segEnd: seg.endMs,
          continuesBefore: seg.continuesBefore,
          continuesAfter: seg.continuesAfter,
        });
      }
      out.set(row.id, list);
    }
    return out;
  }, [stageSlots, date, dayValid]);

  /* Peer-overlap conflicts per row (union with parse-reported conflicts). */
  const conflictedIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const list of placedByRow.values()) {
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a) continue;
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          if (!b) continue;
          if (slotsOverlap(a.segStart, a.segEnd, b.segStart, b.segEnd)) {
            ids.add(a.slot.id);
            ids.add(b.slot.id);
          }
        }
      }
    }
    return ids;
  }, [placedByRow]);

  /* Windowing math (E23): the lane maps 1440min → laneW px.
   * visible minutes = [scrollLeft, scrollLeft + viewportW] / pxPerMin.
   * A hold mounts iff its segment intersects visible ± one full viewport
   * buffer on each side; everything else renders no DOM. With 500 holds on
   * a 375px viewport only ~dozens mount. Width 0 (unmeasured/jsdom) →
   * render all rather than render nothing. */
  const pxPerMin = laneW / 1440;
  const visStartMin = view.width > 0 ? view.left / pxPerMin : 0;
  const visEndMin = view.width > 0 ? (view.left + view.width) / pxPerMin : 1440;
  const bufferMin = view.width > 0 ? view.width / pxPerMin : 1440;

  const inWindow = (p: Placed): boolean => {
    if (view.width === 0 || !dayValid) return true;
    const lo = dayStartMs + (visStartMin - bufferMin) * 60 * 1000;
    const hi = dayStartMs + (visEndMin + bufferMin) * 60 * 1000;
    return p.segEnd > lo && p.segStart < hi;
  };

  const totalPlaced = [...placedByRow.values()].reduce((n, l) => n + l.length, 0);

  const select = (slotId: string, resourceId: string) => {
    if (selectedSlot?.slotId === slotId) onSelectSlot(null);
    else onSelectSlot({ slotId, resourceId });
  };

  /* ---- drag-to-reroute (horizontal, 30min snap, same pad) ---- */

  const onCellPointerDown = (e: React.PointerEvent<HTMLDivElement>, slotId: string) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    dragRef.current = { slotId, startX: e.clientX };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* jsdom / no capture — moves still track while over the cell. */
    }
  };

  const onCellPointerMove = (e: React.PointerEvent<HTMLDivElement>, slotId: string) => {
    const drag = dragRef.current;
    if (!drag || drag.slotId !== slotId) return;
    setDragPx({ slotId, dx: e.clientX - drag.startX });
  };

  const onCellPointerUp = (e: React.PointerEvent<HTMLDivElement>, slot: SlotCardData) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragPx(null);
    if (!drag || drag.slotId !== slot.id) return;
    const dx = e.clientX - drag.startX;
    /* Sub-threshold: a click — the SlotCard button selects, no proposal. */
    if (Math.abs(dx) < 4) return;
    const deltaMin = Math.round(dx / pxPerMin / 30) * 30;
    if (deltaMin === 0) return;
    const toStart = shiftIso(slot.start, deltaMin);
    const toEnd = shiftIso(slot.end, deltaMin);
    const candidate = { ...slot, start: toStart, end: toEnd };
    const check = canPlaceSlot(candidate, stageSlots, { ignoreId: slot.id });
    if (!check.ok) {
      triggerShake();
      showToast(reasonMessage(check.reason, slot.resource_id));
      return;
    }
    onProposeMove?.({
      slotId: slot.id,
      fromResourceId: slot.resource_id,
      toResourceId: slot.resource_id,
      toStart,
      toEnd,
      reason: "OK",
    });
  };

  const onCellPointerCancel = () => {
    dragRef.current = null;
    setDragPx(null);
  };

  const ticks = Array.from({ length: 13 }, (_, i) => i * 2);

  return (
    <section
      aria-label={`Day timeline for ${date}`}
      data-testid="timeline-gantt"
      className="border border-slate-800 bg-slate-950"
    >
      <div className="flex items-center gap-2 border-b border-slate-800/80 px-4 py-2">
        <span className="text-[13px] font-semibold text-slate-200">Day timeline</span>
        <span className="tower-data text-[11px] text-slate-400">{date}</span>
        <span className="tower-data ml-auto text-[11px] text-slate-500">
          {isLoading ? "LOADING" : `${totalPlaced} HOLDS`}
        </span>
      </div>

      <div ref={shakeRef} className="relative">
        {isLoading ? (
          <div className="space-y-2 px-4 py-4" data-testid="gantt-loading" aria-hidden="true">
            {STAGE_ROWS.map((row) => (
              <Skeleton key={row.id} className="h-[68px] w-full" />
            ))}
          </div>
        ) : totalPlaced === 0 ? (
          <div data-testid="gantt-empty">
            <div aria-hidden="true" className="tower-grid h-40 w-full opacity-60" />
            <p className="px-4 py-3 text-[13px] text-slate-400">
              No ops — request a stage
            </p>
          </div>
        ) : (
          <div
            ref={viewportRef}
            onScroll={measure}
            data-testid="gantt-viewport"
            className="overflow-x-auto"
          >
            <div style={{ minWidth: `${128 + LANE_MIN_W}px` }}>
              {/* Hour ruler — scrolls with the lanes. */}
              <div className="flex border-b border-slate-800/80">
                <div className="sticky left-0 z-10 w-32 shrink-0 bg-slate-950" aria-hidden="true" />
                <div className="relative h-6 min-w-0 flex-1" aria-hidden="true">
                  {ticks.map((h) => (
                    <span
                      key={h}
                      className="tower-data absolute top-1 text-[10px] text-slate-500"
                      style={{ left: `${(h / 24) * 100}%` }}
                    >
                      {pad2(h)}:00
                    </span>
                  ))}
                </div>
              </div>

              {STAGE_ROWS.map((row, rowIndex) => {
                const list = placedByRow.get(row.id) ?? [];
                const dimmed = stageFilter !== null && stageFilter !== row.id;
                return (
                  <div
                    key={row.id}
                    className={cn(
                      "flex border-b border-slate-800/60 last:border-b-0",
                      dimmed && "opacity-40",
                    )}
                  >
                    <div className="sticky left-0 z-10 w-32 shrink-0 border-r border-slate-800 bg-slate-950 px-2 py-2">
                      <p className="text-[13px] font-semibold leading-tight text-slate-200">
                        {row.label}
                      </p>
                      <p className="tower-data text-[10px] leading-tight text-slate-500">
                        {row.sub} · {list.length}
                      </p>
                    </div>
                    <div
                      ref={rowIndex === 0 ? laneRef : undefined}
                      data-testid="gantt-lane"
                      className="relative h-[68px] min-w-0 flex-1"
                      style={{ minWidth: `${LANE_MIN_W}px` }}
                    >
                      {/* 30-minute bucket lattice (the measuring canvas). */}
                      <div aria-hidden="true" className="absolute inset-0 flex">
                        {Array.from({ length: BUCKETS_PER_DAY }, (_, i) => (
                          <div
                            key={i}
                            className="h-full flex-1 border-l border-slate-800/70 first:border-l-0"
                          />
                        ))}
                      </div>
                      {list.filter(inWindow).map((p) => {
                        const leftPct = ((p.segStart - dayStartMs) / DAY_MS) * 100;
                        const widthPct = Math.max(
                          ((p.segEnd - p.segStart) / DAY_MS) * 100,
                          0.8,
                        );
                        const kin = kinByRequest.get(p.slot.request_id);
                        const conflicted =
                          conflictedIds.has(p.slot.id) ||
                          conflictResourceIds.includes(p.slot.resource_id);
                        const isDragged = dragPx?.slotId === p.slot.id;
                        return (
                          <div
                            key={p.slot.id}
                            id={`slot-${p.slot.id}`}
                            data-testid="gantt-cell"
                            className="absolute inset-y-1 scroll-mt-4"
                            style={{
                              left: `${leftPct}%`,
                              width: `${widthPct}%`,
                              transform: isDragged
                                ? `translateX(${dragPx?.dx ?? 0}px)`
                                : undefined,
                              willChange: isDragged ? "transform" : undefined,
                            }}
                            onPointerDown={(e) => onCellPointerDown(e, p.slot.id)}
                            onPointerMove={(e) => onCellPointerMove(e, p.slot.id)}
                            onPointerUp={(e) => onCellPointerUp(e, p.slot)}
                            onPointerCancel={onCellPointerCancel}
                          >
                            {p.continuesBefore ? (
                              <span
                                aria-hidden="true"
                                className="absolute -left-1 top-1/2 z-10 -translate-y-1/2 text-cyan-300"
                              >
                                <ChevronLeft className="size-3" />
                              </span>
                            ) : null}
                            <SlotCard
                              slot={p.slot}
                              crewLabels={kin?.crew}
                              gearLabels={kin?.gear}
                              conflicted={conflicted}
                              selected={selectedSlot?.slotId === p.slot.id}
                              onSelect={(id) => select(id, p.slot.resource_id)}
                              className="h-full"
                            />
                            {p.continuesAfter ? (
                              <span
                                aria-hidden="true"
                                className="absolute -right-1 top-1/2 z-10 -translate-y-1/2 text-cyan-300"
                              >
                                <ChevronRight className="size-3" />
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {toast ? (
        <p
          key={toast.id}
          role="alert"
          data-testid="gantt-toast"
          className="flex items-center gap-2 border-t border-rose-500/40 bg-rose-500/10 px-4 py-2 text-[13px] text-rose-200"
        >
          {toast.msg}
        </p>
      ) : null}

      <p className="tower-data border-t border-slate-800/80 px-4 py-2 text-[11px] text-slate-500">
        DRAG A HOLD TO PROPOSE A MOVE · 30MIN SNAP · ENTER SELECTS
      </p>
    </section>
  );
}

"use client";

/**
 * RadarScope (T-08) — the ATC lot map: SVG concentric scope, 4 stage pads,
 * holds as blips angled by time-of-day.
 *
 * - Pads: Stage 1/2/3 + ADR Suite (seed ids `stage-1/2/3`, `adr-suite`) at
 *   slightly off-axis positions — hand-placed, never a template cross.
 * - Blips: emerald confirmed / amber holding / slate released, rose pulse
 *   on conflicted resources (US-02). 150ms ease-out enter/conflict via
 *   framer-motion `layout` + AnimatePresence, no bounce.
 * - Time is encoded as angle (00:00 top, clockwise) so position means
 *   something; hover/focus tooltip shows production · window · crew · trace
 *   through DOMPurify (XSS E21).
 * - Click (or Enter/Space) reports `onSelectSlot` — T-08 wires it to the
 *   `slot-<id>` timeline anchor scroll; the drawer is T-09, so selection
 *   state lives upward (`selectedSlot`) and no drawer is built here.
 * - Drag-to-propose: pointer drag → nearest pad + 30min-snapped window →
 *   `slot-check.ts` pre-validate → `onProposeMove` (no direct agent call;
 *   T-09/T-05 own mutations). Invalid drops shake + toast, no API call.
 * - 50+ blips cluster by stage (count nodes, no tab-through storm).
 * - Keyboard: every blip is a focusable SVG node with a themed focus ring;
 *   conflicts announce through an ARIA live region.
 * - Empty lot renders the grid + "No ops — request a stage" (never blank).
 *
 * This module also exports the T-09 mount contract: `SelectedSlot`,
 * `ProposedMove`, `LiveDot`, and the typed `LotHealthMount` placeholder.
 */
import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import DOMPurify from "dompurify";
import type { ConflictInfo } from "../hooks/useParse";
import type { RadarStreamStatus } from "../hooks/useRadarStream";
import { canPlaceSlot } from "../lib/slot-check";
import { cn } from "./ui/utils";
import { Skeleton } from "./ui/skeleton";

/* ------------------------------------------------------------------ */
/* Mount contract (T-09 reads this)                                    */
/* ------------------------------------------------------------------ */

/** Upward selection: the held slot id + the pad it sits on. */
export interface SelectedSlot {
  slotId: string;
  resourceId: string;
}

/** Pre-validated drag proposal — T-09 posts it to `POST /api/reroute`. */
export interface ProposedMove {
  slotId: string;
  fromResourceId: string;
  toResourceId: string;
  /** ISO 8601 UTC. */
  toStart: string;
  /** ISO 8601 UTC. */
  toEnd: string;
  reason: string;
}

export interface RadarSlot {
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

export interface RadarScopeProps {
  /** All slots for the date — stage holds render as blips. */
  slots: RadarSlot[];
  /** Viewed UTC date, YYYY-MM-DD. */
  date: string;
  selectedSlot: SelectedSlot | null;
  onSelectSlot: (sel: SelectedSlot | null) => void;
  onProposeMove: (move: ProposedMove) => void;
  conflicts?: ConflictInfo[];
  isLoading?: boolean;
}

/* ------------------------------------------------------------------ */
/* Scope geometry + math (exported for unit tests)                     */
/* ------------------------------------------------------------------ */

export const RADAR_SIZE = 600;
const CENTER = 300;
/** Blip count that collapses individual nodes into stage clusters. */
export const CLUSTER_AT = 50;

interface PadDef {
  x: number;
  y: number;
  label: string;
  sub: string;
}

export const STAGE_PADS: Record<string, PadDef> = {
  "stage-1": { x: 300, y: 104, label: "Stage 1", sub: "2000 SQFT" },
  "stage-2": { x: 494, y: 278, label: "Stage 2", sub: "3000 · ALT" },
  "stage-3": { x: 290, y: 496, label: "Stage 3", sub: "3000 SQFT" },
  "adr-suite": { x: 106, y: 322, label: "ADR Suite", sub: "DIALOGUE" },
};

/** Minutes since UTC midnight for an ISO datetime (0 on garbage). */
export function startMinutesOfDay(iso: string): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Clock position for a minute-of-day: 00:00 top, clockwise. */
export function minutesToAngle(min: number): number {
  return (min / 1440) * 360 - 90;
}

export function angleToMinutes(angleDeg: number): number {
  const norm = ((((angleDeg + 90) % 360) + 360) % 360 + 360) % 360;
  return (norm / 360) * 1440;
}

export function nearestPad(x: number, y: number): string {
  let best = "stage-3";
  let bestD = Number.POSITIVE_INFINITY;
  for (const [id, pad] of Object.entries(STAGE_PADS)) {
    const d = (pad.x - x) ** 2 + (pad.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/** Deterministic blip orbit: time angle + id-hashed ring around the pad. */
export function blipPosition(
  slot: Pick<RadarSlot, "id" | "start" | "resource_id">,
  index: number,
): { x: number; y: number } {
  const pad = STAGE_PADS[slot.resource_id] ?? { x: CENTER, y: CENTER };
  const angle = (minutesToAngle(startMinutesOfDay(slot.start)) * Math.PI) / 180;
  let hash = 0;
  for (let i = 0; i < slot.id.length; i++) {
    hash = (hash * 31 + slot.id.charCodeAt(i)) >>> 0;
  }
  const ring = 34 + (hash % 3) * 11 + (index % 4) * 2;
  return { x: pad.x + Math.cos(angle) * ring, y: pad.y + Math.sin(angle) * ring };
}

export function minutesToIso(date: string, minutes: number): string {
  const day = Date.parse(`${date}T00:00:00Z`);
  const ms = (Number.isFinite(day) ? day : 0) + Math.round(minutes) * 60 * 1000;
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00Z`;
}

const STATUS_FILL: Record<RadarSlot["status"], string> = {
  confirmed: "#34d399",
  holding: "#fbbf24",
  released: "#64748b",
};

function moveErrorMessage(reason: string, toResource: string): string {
  if (reason === "INVALID_INTERVAL") {
    return "Move rejected — zero-length window. Drag further or pick a new window.";
  }
  if (reason.startsWith("OVERLAP:")) {
    const blocker = reason.slice("OVERLAP:".length);
    return `Move rejected — overlaps ${blocker} on ${toResource}. Drop on a clear window.`;
  }
  if (reason === "SEPARATION_VIOLATION") {
    return "Move rejected — 30min stage turnaround violated. Drop further out.";
  }
  if (reason === "CREW_REST_VIOLATION") {
    return "Move rejected — 11h crew rest violated. Drop on a rested window.";
  }
  return "Move rejected — that window is not placeable. Drop elsewhere.";
}

/* ------------------------------------------------------------------ */
/* LiveDot — the single live-status readout (T-09 reads the same hook) */
/* ------------------------------------------------------------------ */

export function LiveDot({
  status,
  lastEventAt,
}: {
  status: RadarStreamStatus;
  lastEventAt: number | null;
}) {
  const live = status === "live";
  const label =
    status === "live"
      ? "Live"
      : status === "reconnecting"
        ? "Live: reconnecting…"
        : "Live: polling every 5s";
  const eventTime =
    lastEventAt !== null ? new Date(lastEventAt).toISOString().slice(11, 19) : null;
  return (
    <p data-testid="live-dot" role="status" className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className={cn(
          "size-2 rounded-full",
          live ? "bg-emerald-400" : "animate-tower-blip bg-amber-400",
        )}
      />
      <span className={cn("text-[13px] font-semibold", live ? "text-emerald-200" : "text-amber-200")}>
        {label}
      </span>
      {eventTime ? (
        <span className="tower-data text-[11px] text-slate-500">EVENT {eventTime}</span>
      ) : null}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* LotHealthMount — typed placeholder. T-09 builds the strip HERE.     */
/* ------------------------------------------------------------------ */

export interface LotHealthSlotProps {
  date: string;
}

export function LotHealthMount({ date }: LotHealthSlotProps) {
  return (
    <section
      aria-label="Lot health"
      data-mount="lot-health"
      className="border border-dashed border-slate-700 px-4 py-3"
    >
      <p className="text-[13px] font-semibold text-slate-300">Lot health</p>
      <p className="tower-secondary text-[13px]">
        Health strip mounts here in T-09 — utilization, active conflicts,
        resolve time. <span className="tower-data">{date}</span>
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* RadarScope                                                          */
/* ------------------------------------------------------------------ */

export function RadarScope({
  slots,
  date,
  selectedSlot,
  onSelectSlot,
  onProposeMove,
  conflicts = [],
  isLoading = false,
}: RadarScopeProps) {
  const stageSlots = React.useMemo(
    () => slots.filter((s) => s.resource_type === "stage"),
    [slots],
  );
  const conflictedResources = React.useMemo(
    () => new Set(conflicts.map((c) => c.resource_id)),
    [conflicts],
  );
  const clustered = stageSlots.length >= CLUSTER_AT;

  const kinByRequest = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of slots) {
      if (s.resource_type !== "crew") continue;
      const list = map.get(s.request_id) ?? [];
      list.push(s.resource_id);
      map.set(s.request_id, list);
    }
    return map;
  }, [slots]);

  const svgRef = React.useRef<SVGSVGElement>(null);
  const shakeRef = React.useRef<HTMLDivElement>(null);
  const [hover, setHover] = React.useState<{ slot: RadarSlot; x: number; y: number } | null>(null);
  const [drag, setDrag] = React.useState<{
    slotId: string;
    x: number;
    y: number;
    startX: number;
    startY: number;
  } | null>(null);
  const [dragError, setDragError] = React.useState<string | null>(null);

  /**
   * Guard-reject shake: restart the CSS animation synchronously via reflow.
   * No key-remount — remounting would detach focused/dragged SVG nodes and
   * replay every blip entrance on each reject.
   */
  const triggerShake = () => {
    const el = shakeRef.current;
    if (!el) return;
    el.classList.remove("animate-tower-shake");
    void el.offsetWidth;
    el.classList.add("animate-tower-shake");
  };

  const svgPoint = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: clientX, y: clientY };
    const scale = RADAR_SIZE / rect.width;
    return { x: (clientX - rect.left) * scale, y: (clientY - rect.top) * scale };
  };

  const toggle = (slot: RadarSlot) => {
    setHover(null);
    if (selectedSlot?.slotId === slot.id) onSelectSlot(null);
    else onSelectSlot({ slotId: slot.id, resourceId: slot.resource_id });
  };

  const windowOf = (slot: RadarSlot) =>
    `${slot.start.slice(11, 16)}–${slot.end.slice(11, 16)}`;

  const tooltipHtml = (slot: RadarSlot): string => {
    const crew = kinByRequest.get(slot.request_id) ?? [];
    return DOMPurify.sanitize(
      `<div><strong>${slot.production}</strong></div>` +
        `<div>${slot.resource_id} · ${windowOf(slot)}</div>` +
        (crew.length > 0 ? `<div>crew: ${crew.join(", ")}</div>` : "") +
        `<div>trace ${slot.trace_id}</div>`,
    );
  };

  /* ---- drag-to-propose ---- */

  const onBlipPointerDown = (
    e: React.PointerEvent<SVGGElement>,
    slot: RadarSlot,
    pos: { x: number; y: number },
  ) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const p = svgPoint(e.clientX, e.clientY);
    setDrag({ slotId: slot.id, x: p.x, y: p.y, startX: p.x, startY: p.y });
    setDragError(null);
    void pos;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* jsdom / no capture — svg-level move/up still track the drag. */
    }
  };

  const onScopePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const p = svgPoint(e.clientX, e.clientY);
    setDrag({ ...drag, x: p.x, y: p.y });
  };

  const onScopePointerUp = () => {
    if (!drag) return;
    const { slotId, x, y, startX, startY } = drag;
    setDrag(null);
    /* Sub-threshold: a click — selection already handled, no proposal. */
    if (Math.hypot(x - startX, y - startY) < 6) return;
    const slot = stageSlots.find((s) => s.id === slotId);
    if (!slot) return;
    const toResource = nearestPad(x, y);
    const pad = STAGE_PADS[toResource];
    if (!pad) return;
    const angleDeg = (Math.atan2(y - pad.y, x - pad.x) * 180) / Math.PI;
    const snapped = Math.round(angleToMinutes(angleDeg) / 30) * 30;
    const durationMin = Math.round(
      (Date.parse(slot.end) - Date.parse(slot.start)) / 60000,
    );
    if (!Number.isFinite(durationMin) || durationMin <= 0) {
      triggerShake();
      setDragError(moveErrorMessage("INVALID_INTERVAL", toResource));
      return;
    }
    const toStart = minutesToIso(date, snapped);
    const toEnd = minutesToIso(date, snapped + durationMin);
    const check = canPlaceSlot(
      { ...slot, resource_id: toResource, start: toStart, end: toEnd },
      stageSlots,
      { ignoreId: slot.id },
    );
    if (!check.ok) {
      triggerShake();
      setDragError(moveErrorMessage(check.reason, toResource));
      return;
    }
    onProposeMove({
      slotId: slot.id,
      fromResourceId: slot.resource_id,
      toResourceId: toResource,
      toStart,
      toEnd,
      reason: "OK",
    });
  };

  const clusterCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of stageSlots) counts.set(s.resource_id, (counts.get(s.resource_id) ?? 0) + 1);
    return counts;
  }, [stageSlots]);

  const conflictAnnouncement =
    conflicts.length > 0
      ? `Conflict: ${conflicts.map((c) => `${c.resource_id} ${c.overlap}, blocked by ${c.blockedBy}`).join("; ")}.`
      : "";

  return (
    <section
      aria-label="Lot radar scope"
      data-testid="radar-scope"
      className="border border-slate-800 bg-slate-950"
    >
      <div className="flex items-center gap-2 border-b border-slate-800/80 px-4 py-2">
        <span className="text-[13px] font-semibold text-slate-200">Lot radar</span>
        <span className="tower-data text-[11px] text-slate-400">{date}</span>
        <span className="tower-data ml-auto text-[11px] text-slate-500">
          {isLoading ? "LOADING" : `${stageSlots.length} OPS`}
        </span>
        <a
          href={`/timeline?date=${date}`}
          className="tower-focus rounded-[2px] border border-slate-700 px-2 py-1 text-[12px] font-semibold text-slate-200 transition-colors duration-150 ease-out hover:border-cyan-400 hover:text-cyan-300"
        >
          Timeline →
        </a>
      </div>

      <div ref={shakeRef} className="relative">
        {isLoading ? (
          <div data-testid="radar-loading" aria-hidden="true" className="px-4 py-4">
            <Skeleton className="aspect-square w-full max-w-[560px]" />
          </div>
        ) : stageSlots.length === 0 ? (
          <div data-testid="radar-empty">
            <svg
              viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`}
              aria-hidden="true"
              className="h-auto w-full max-w-[560px] opacity-70"
            >
              {[70, 120, 170, 220, 265].map((r) => (
                <circle
                  key={r}
                  cx={CENTER}
                  cy={CENTER}
                  r={r}
                  fill="none"
                  stroke="#1e293b"
                  strokeWidth={1}
                />
              ))}
              <line x1={CENTER - 265} y1={CENTER} x2={CENTER + 265} y2={CENTER} stroke="#1e293b" />
              <line x1={CENTER} y1={CENTER - 265} x2={CENTER} y2={CENTER + 265} stroke="#1e293b" />
            </svg>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <p className="text-[13px] text-slate-400">No ops — request a stage</p>
              <button
                type="button"
                onClick={() => document.getElementById("tower-request-text")?.focus()}
                className="tower-focus rounded-[2px] border border-slate-700 px-2 py-1 text-[12px] font-semibold text-slate-200 transition-colors duration-150 ease-out hover:border-cyan-400 hover:text-cyan-300"
              >
                File a request
              </button>
            </div>
          </div>
        ) : (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`}
            role="group"
            aria-label={`${stageSlots.length} operations on scope`}
            data-testid="radar-svg"
            className="h-auto w-full touch-none select-none"
            onPointerMove={onScopePointerMove}
            onPointerUp={onScopePointerUp}
            onPointerCancel={() => setDrag(null)}
          >
            <style>{`.tower-sweep{transform-origin:300px 300px;animation:tower-sweep 9s linear infinite}@keyframes tower-sweep{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.tower-sweep{animation:none}}`}</style>

            {/* Rings + crosshair (slate-700/600 carry the dial; labels slate-400). */}
            {[70, 120, 170, 220, 265].map((r) => (
              <circle
                key={r}
                cx={CENTER}
                cy={CENTER}
                r={r}
                fill="none"
                stroke="#334155"
                strokeWidth={1}
              />
            ))}
            <line x1={CENTER - 265} y1={CENTER} x2={CENTER + 265} y2={CENTER} stroke="#475569" strokeWidth={1} />
            <line x1={CENTER} y1={CENTER - 265} x2={CENTER} y2={CENTER + 265} stroke="#475569" strokeWidth={1} />
            {[
              { t: "00", x: CENTER, y: 22 },
              { t: "06", x: 584, y: CENTER + 4 },
              { t: "12", x: CENTER, y: 584 },
              { t: "18", x: 16, y: CENTER + 4 },
            ].map((tick) => (
              <text
                key={tick.t}
                x={tick.x}
                y={tick.y}
                textAnchor="middle"
                fontSize={11}
                fill="#94a3b8"
                fontFamily="var(--font-jetbrains-mono), monospace"
              >
                {tick.t}
              </text>
            ))}

            {/* Sweep — the single authored motion (CSS so reduced-motion kills it). */}
            <line x1={CENTER} y1={CENTER} x2={CENTER} y2={35} stroke="#22d3ee" strokeOpacity={0.55} strokeWidth={1.5} className="tower-sweep" />
            <circle cx={CENTER} cy={CENTER} r={3} fill="#22d3ee" />

            {/* Pads. */}
            {Object.entries(STAGE_PADS).map(([id, pad]) => {
              const active = selectedSlot !== null && selectedSlot.resourceId === id;
              return (
                <g key={id}>
                  <rect
                    x={pad.x - 46}
                    y={pad.y - 24}
                    width={92}
                    height={48}
                    fill="#0f172a"
                    stroke={active ? "#22d3ee" : "#475569"}
                    strokeWidth={active ? 2 : 1}
                  />
                  <text x={pad.x} y={pad.y - 2} textAnchor="middle" fontSize={13} fontWeight={600} fill="#e2e8f0">
                    {pad.label}
                  </text>
                  <text
                    x={pad.x}
                    y={pad.y + 14}
                    textAnchor="middle"
                    fontSize={9}
                    fill="#94a3b8"
                    fontFamily="var(--font-jetbrains-mono), monospace"
                  >
                    {pad.sub}
                  </text>
                </g>
              );
            })}

            {/* Blips or stage clusters. */}
            {clustered ? (
              <g>
                {Object.entries(STAGE_PADS).map(([id, pad]) => {
                  const count = clusterCounts.get(id) ?? 0;
                  if (count === 0) return null;
                  return (
                    <g key={id} role="img" aria-label={`${pad.label}: ${count} operations, clustered by stage`}>
                      <rect
                        x={pad.x - 30}
                        y={pad.y - 62}
                        width={60}
                        height={26}
                        fill="#020617"
                        stroke="#fbbf24"
                        strokeWidth={1.5}
                      />
                      <text
                        x={pad.x}
                        y={pad.y - 44}
                        textAnchor="middle"
                        fontSize={12}
                        fill="#fde68a"
                        fontFamily="var(--font-jetbrains-mono), monospace"
                      >
                        ×{count}
                      </text>
                    </g>
                  );
                })}
              </g>
            ) : (
              <AnimatePresence>
                {stageSlots.map((slot, index) => {
                  const pos = blipPosition(slot, index);
                  const conflicted = conflictedResources.has(slot.resource_id);
                  const selected = selectedSlot?.slotId === slot.id;
                  return (
                    <motion.g
                      key={slot.id}
                      data-testid="radar-blip"
                      data-slot-id={slot.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${slot.production}, ${slot.resource_id} ${windowOf(slot)}${conflicted ? ", conflicting" : ""}`}
                      aria-pressed={selected}
                      layout
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.5 }}
                      transition={{ duration: 0.15, ease: "easeOut" }}
                      style={{
                        transformBox: "fill-box",
                        transformOrigin: "center",
                        cursor: "grab",
                      }}
                      className="tower-focus"
                      onClick={() => toggle(slot)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggle(slot);
                        } else if (e.key === "Escape") {
                          setHover(null);
                        }
                      }}
                      onMouseEnter={() => setHover({ slot, x: pos.x, y: pos.y })}
                      onMouseLeave={() => setHover((h) => (h?.slot.id === slot.id ? null : h))}
                      onFocus={() => setHover({ slot, x: pos.x, y: pos.y })}
                      onBlur={() => setHover((h) => (h?.slot.id === slot.id ? null : h))}
                      onPointerDown={(e) => onBlipPointerDown(e, slot, pos)}
                    >
                      <circle
                        cx={pos.x}
                        cy={pos.y}
                        r={selected ? 9 : 7}
                        fill={conflicted ? "#f43f5e" : STATUS_FILL[slot.status]}
                        stroke="#020617"
                        strokeWidth={2}
                        className={conflicted ? "animate-tower-blip" : undefined}
                      />
                      {selected ? (
                        <circle
                          cx={pos.x}
                          cy={pos.y}
                          r={14}
                          fill="none"
                          stroke="#22d3ee"
                          strokeWidth={2}
                        />
                      ) : null}
                    </motion.g>
                  );
                })}
              </AnimatePresence>
            )}

            {/* Drag ghost + drop target. */}
            {drag ? (
              <g aria-hidden="true">
                <circle
                  cx={drag.x}
                  cy={drag.y}
                  r={9}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                />
              </g>
            ) : null}
          </svg>
        )}

        {/* DOMPurified hover tooltip (XSS E21). */}
        {hover && !clustered ? (
          <div
            role="tooltip"
            data-testid="radar-tooltip"
            className="tower-data pointer-events-none absolute z-20 max-w-[240px] -translate-x-1/2 rounded-[2px] border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 shadow-[0_8px_24px_rgb(0_0_0/0.55)]"
            style={{
              left: `${Math.min(Math.max((hover.x / RADAR_SIZE) * 100, 14), 86)}%`,
              top: `${Math.max((hover.y / RADAR_SIZE) * 100 - 14, 2)}%`,
            }}
            dangerouslySetInnerHTML={{ __html: tooltipHtml(hover.slot) }}
          />
        ) : null}
      </div>

      {dragError ? (
        <p
          role="alert"
          data-testid="radar-toast"
          className="border-t border-rose-500/40 bg-rose-500/10 px-4 py-2 text-[13px] text-rose-200"
        >
          {dragError}
        </p>
      ) : null}

      {conflicts.length > 0 ? (
        /* Visible conflict line, deliberately NOT a live region: the
           transmit console's live region already announces this conflict
           once — a second live region would double-speak it. */
        <p
          data-testid="radar-conflicts"
          className="border-t border-rose-500/40 bg-rose-500/10 px-4 py-2 text-[13px] text-rose-200"
        >
          {conflictAnnouncement} Alternatives list in the conflict drawer.
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {stageSlots.length} operations on scope
        {clustered ? ", clustered by stage" : ""}.
      </p>

      <p className="tower-data border-t border-slate-800/80 px-4 py-2 text-[11px] text-slate-500">
        DRAG A BLIP TO PROPOSE A MOVE · ENTER SELECTS · CLICK SCROLLS TO HOLD
      </p>
    </section>
  );
}

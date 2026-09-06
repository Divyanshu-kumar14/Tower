/**
 * slot-check.ts (T-08) — client mirror of the deterministic slot graph.
 *
 * MIRROR of `agent/graph/slot_graph.py` — the Python graph is authoritative;
 * this module exists for instant drag feedback only (shake + toast, no API
 * call on invalid drops). Parity rules:
 * - Overlap: `existing.start < S.end && S.start < existing.end`
 *   (touching edges do NOT overlap — separation minima may still reject).
 * - Separation minima: stage 30min turnaround, gear 15min swap,
 *   crew 11h union rest.
 * - `end > start` enforced (E06 `INVALID_INTERVAL`); `released` holds never
 *   block placement (audit only).
 */

export type MirrorResourceType = "stage" | "gear" | "crew";
export type MirrorSlotStatus = "holding" | "confirmed" | "released";

export interface MirrorSlot {
  id: string;
  resource_type: MirrorResourceType;
  resource_id: string;
  /** ISO 8601 UTC datetimes (frozen contract field names). */
  start: string;
  end: string;
  status?: MirrorSlotStatus;
}

export type PlaceReason =
  | "OK"
  | `OVERLAP:${string}`
  | "SEPARATION_VIOLATION"
  | "CREW_REST_VIOLATION"
  | "INVALID_INTERVAL";

export interface PlaceCheck {
  ok: boolean;
  reason: PlaceReason;
}

/** Separation minima, ms — mirrors STAGE_TURNAROUND / GEAR_SWAP / CREW_REST. */
export const STAGE_TURNAROUND_MS = 30 * 60 * 1000;
export const GEAR_SWAP_MS = 15 * 60 * 1000;
export const CREW_REST_MS = 11 * 60 * 60 * 1000;

/** ATC separation minimum for a resource type. Fails loudly on unknown. */
export function requiredGapMs(resourceType: MirrorResourceType): number {
  switch (resourceType) {
    case "stage":
      return STAGE_TURNAROUND_MS;
    case "gear":
      return GEAR_SWAP_MS;
    case "crew":
      return CREW_REST_MS;
  }
}

/** E06 guard: both ends finite and `end > start`. */
export function validateInterval(start: string, end: string): boolean {
  const s = Date.parse(start);
  const e = Date.parse(end);
  return Number.isFinite(s) && Number.isFinite(e) && e > s;
}

/**
 * Overlap rule — strict. Touching (`a_end === b_start`) is NOT an overlap;
 * separation minima may still reject it in `canPlaceSlot`.
 */
export function slotsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

interface Peer {
  slot: MirrorSlot;
  s: number;
  e: number;
}

/**
 * Client `canPlace` — mirrors `SlotRegistry.can_place` (overlap scan, then
 * nearest-live-neighbour separation). `ignoreId` exempts the dragged slot
 * itself so a no-op drop validates clean.
 */
export function canPlaceSlot(
  candidate: MirrorSlot,
  existing: readonly MirrorSlot[],
  opts?: { ignoreId?: string },
): PlaceCheck {
  const s = Date.parse(candidate.start);
  const e = Date.parse(candidate.end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
    return { ok: false, reason: "INVALID_INTERVAL" };
  }
  const peers: Peer[] = [];
  for (const x of existing) {
    if (x.resource_id !== candidate.resource_id) continue;
    if (x.id === opts?.ignoreId) continue;
    if ((x.status ?? "confirmed") === "released") continue;
    const xs = Date.parse(x.start);
    const xe = Date.parse(x.end);
    if (!Number.isFinite(xs) || !Number.isFinite(xe) || xe <= xs) continue;
    peers.push({ slot: x, s: xs, e: xe });
  }
  peers.sort((a, b) => a.s - b.s);

  for (const p of peers) {
    if (slotsOverlap(p.s, p.e, s, e)) {
      return { ok: false, reason: `OVERLAP:${p.slot.id}` };
    }
  }

  const gap = requiredGapMs(candidate.resource_type);
  let pred: Peer | null = null;
  let succ: Peer | null = null;
  for (const p of peers) {
    if (p.e <= s && (pred === null || p.e > pred.e)) pred = p;
    if (p.s >= e && (succ === null || p.s < succ.s)) succ = p;
  }
  const rest = candidate.resource_type === "crew";
  if (pred !== null && s - pred.e < gap) {
    return { ok: false, reason: rest ? "CREW_REST_VIOLATION" : "SEPARATION_VIOLATION" };
  }
  if (succ !== null && succ.s - e < gap) {
    return { ok: false, reason: rest ? "CREW_REST_VIOLATION" : "SEPARATION_VIOLATION" };
  }
  return { ok: true, reason: "OK" };
}

export interface DaySegment {
  startMs: number;
  endMs: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * Clip a slot to one UTC calendar date for day-view rendering.
 * Mirrors `split_overnight` (E07): a `22:00–06:00` hold renders as a tail
 * segment on day one and a head segment on day two (flags mark the cut
 * edge). Returns null when the slot shows nothing on that date — including
 * zero-duration / end<=start, which is rejected client-side and never
 * rendered, never sent.
 */
export function clipSlotToDate(slot: MirrorSlot, date: string): DaySegment | null {
  const s = Date.parse(slot.start);
  const e = Date.parse(slot.end);
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(s) ||
    !Number.isFinite(e) ||
    !Number.isFinite(dayStart) ||
    e <= s
  ) {
    return null;
  }
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const cs = Math.max(s, dayStart);
  const ce = Math.min(e, dayEnd);
  if (ce <= cs) return null;
  return {
    startMs: cs,
    endMs: ce,
    continuesBefore: s < dayStart,
    continuesAfter: e > dayEnd,
  };
}

/**
 * TOWER inventory data-access stub (T-02) for `GET /inventory?date=`.
 *
 * Data-access ONLY: SQL template + Redis cache-key/TTL helpers. No BFF route
 * logic here (no Request/Response, no Next.js imports) — routes land in T-05.
 *
 * Field names mirror contracts/slot.py Slot (frozen across OpenAPI / TS /
 * Zod / Pydantic): {id, production, resource_type, resource_id, start, end,
 * status, request_id, trace_id}.
 */

/** Redis TTL for day-view inventory (60s per TOWER_IMPLEMENTATION_PLAN §1B). */
export const INVENTORY_TTL_SECONDS = 60;

export type ResourceType = "stage" | "gear" | "crew";
export type SlotStatus = "holding" | "confirmed" | "released";

/** Day-view slot row — mirrors OpenAPI components/schemas/Slot. */
export interface InventorySlot {
  id: string;
  production: string;
  resource_type: ResourceType;
  resource_id: string;
  start: string;
  end: string;
  status: SlotStatus;
  request_id: string;
  trace_id: string;
}

/**
 * Day-view read: all slots overlapping a calendar date (UTC), ordered for
 * radar/gantt rendering. `$1` is `YYYY-MM-DD` (validated by slotsQuerySchema).
 */
export const GET_INVENTORY_BY_DATE_SQL = `SELECT
  s.id,
  s.production,
  s.resource_type,
  s.resource_id,
  s.start_ts AS "start",
  s.end_ts AS "end",
  s.status,
  s.request_id,
  s.trace_id
FROM slots s
WHERE s.start_ts::date = $1::date
ORDER BY s.resource_id, s.start_ts`;

/** Redis read-through key for a day view, e.g. `tower:inventory:2026-09-06`. */
export function inventoryCacheKey(date: string): string {
  return `tower:inventory:${date}`;
}

/**
 * T-02 stub — throws until T-05 wires Postgres + Redis.
 *
 * Intended flow (T-05): `GET tower:inventory:<date>`; on hit return cached
 * JSON; on miss run GET_INVENTORY_BY_DATE_SQL against Postgres, then
 * `SETEX <key> 60 <json>` (INVENTORY_TTL_SECONDS).
 */
export async function getInventoryByDate(date: string): Promise<InventorySlot[]> {
  void date;
  throw new Error(
    "T-02 stub: wire Postgres + Redis in T-05 (see GET_INVENTORY_BY_DATE_SQL).",
  );
}

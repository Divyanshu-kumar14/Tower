/**
 * TOWER BFF validators — Zod stub mirroring contracts/api.yaml (T-01).
 *
 * Field names frozen across OpenAPI / TS / Zod / Pydantic:
 * {id, production, resource_type, resource_id, start, end, status, request_id, trace_id}.
 * Fail loudly: every object uses `.strict()` (reject unknown keys),
 * datetimes must be ISO 8601 UTC, intervals enforce end > start
 * (422 INVALID_INTERVAL).
 */
import { z } from "zod";

export const resourceTypeSchema = z.enum(["stage", "gear", "crew"]);

export const slotStatusSchema = z.enum(["holding", "confirmed", "released"]);

export const errorCodeSchema = z.enum([
  "IDEMPOTENT_REPLAY",
  "NEEDS_CLARIFICATION",
  "STALE_ALTERNATIVE",
  "INVALID_INTERVAL",
  "IDEMPOTENCY_KEY_REUSE",
]);

const utcDatetime = z.string().datetime({ offset: true });

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: "date must be YYYY-MM-DD",
});

/** Canonical slot — mirrors OpenAPI components/schemas/Slot. */
export const slotSchema = z
  .object({
    id: z.string().min(1),
    production: z.string().min(1),
    resource_type: resourceTypeSchema,
    resource_id: z.string().min(1),
    start: utcDatetime,
    end: utcDatetime,
    status: slotStatusSchema,
    request_id: z.string().min(1),
    trace_id: z.string().min(1),
  })
  .strict()
  .refine((v) => new Date(v.end).getTime() > new Date(v.start).getTime(), {
    message: "INVALID_INTERVAL: end must be after start",
    path: ["end"],
  });

/** Parser output before hold — mirrors OpenAPI ParsedSlot. */
export const parsedSlotSchema = z
  .object({
    resource_type: resourceTypeSchema,
    resource_id: z.string().min(1),
    start: utcDatetime,
    end: utcDatetime,
  })
  .strict()
  .refine((v) => new Date(v.end).getTime() > new Date(v.start).getTime(), {
    message: "INVALID_INTERVAL: end must be after start",
    path: ["end"],
  });

/** Ranked alternative / reroute target — mirrors OpenAPI AlternativeSlot. */
export const alternativeSlotSchema = z
  .object({
    resource_id: z.string().min(1),
    resource_type: resourceTypeSchema.optional(),
    start: utcDatetime,
    end: utcDatetime,
  })
  .strict()
  .refine((v) => new Date(v.end).getTime() > new Date(v.start).getTime(), {
    message: "INVALID_INTERVAL: end must be after start",
    path: ["end"],
  });

/** POST /api/requests body — mirrors OpenAPI CreateRequestRequest. */
export const createRequestSchema = z
  .object({
    text: z
      .string()
      .min(1, { message: "text must not be empty" })
      .max(2000, { message: "text must be <= 2000 chars" })
      .refine((s) => s.trim().length > 0, {
        message: "text must not be blank",
      }),
    idempotencyKey: z.string().uuid({ message: "idempotencyKey must be uuidv4" }),
    now: utcDatetime,
  })
  .strict();

/** POST /api/reroute body — mirrors OpenAPI RerouteRequest. */
export const rerouteRequestSchema = z
  .object({
    requestId: z.string().min(1),
    alternative: alternativeSlotSchema,
    idempotencyKey: z.string().uuid({ message: "idempotencyKey must be uuidv4" }),
  })
  .strict();

/** GET /api/slots?date= query — mirrors OpenAPI date param. */
export const slotsQuerySchema = z
  .object({
    date: dateOnly,
  })
  .strict();

export type ResourceType = z.infer<typeof resourceTypeSchema>;
export type SlotStatus = z.infer<typeof slotStatusSchema>;
export type Slot = z.infer<typeof slotSchema>;
export type ParsedSlot = z.infer<typeof parsedSlotSchema>;
export type AlternativeSlot = z.infer<typeof alternativeSlotSchema>;
export type CreateRequestInput = z.infer<typeof createRequestSchema>;
export type RerouteRequestInput = z.infer<typeof rerouteRequestSchema>;
export type SlotsQuery = z.infer<typeof slotsQuerySchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;

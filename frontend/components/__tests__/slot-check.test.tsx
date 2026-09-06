/**
 * @vitest-environment jsdom
 *
 * slot-check tests (T-08) — parity with `agent/graph/slot_graph.py`:
 * overlap rule, separation minima, end>start reject, released-holds,
 * self-ignore, and overnight clipping for the day view.
 */
import { describe, expect, it } from "vitest";
import {
  canPlaceSlot,
  clipSlotToDate,
  requiredGapMs,
  slotsOverlap,
  validateInterval,
  type MirrorSlot,
} from "../../lib/slot-check";

function slot(over: Partial<MirrorSlot> = {}): MirrorSlot {
  return {
    id: "slot_new",
    resource_type: "stage",
    resource_id: "stage-3",
    start: "2026-09-06T06:00:00Z",
    end: "2026-09-06T07:00:00Z",
    status: "holding",
    ...over,
  };
}

describe("slotsOverlap", () => {
  it("overlaps on strict intersection", () => {
    expect(slotsOverlap(6, 10, 8, 12)).toBe(true);
    expect(slotsOverlap(8, 12, 6, 10)).toBe(true);
  });

  it("touching edges do NOT overlap", () => {
    expect(slotsOverlap(6, 8, 8, 10)).toBe(false);
    expect(slotsOverlap(8, 10, 6, 8)).toBe(false);
  });
});

describe("requiredGapMs", () => {
  it("mirrors the graph minima", () => {
    expect(requiredGapMs("stage")).toBe(30 * 60 * 1000);
    expect(requiredGapMs("gear")).toBe(15 * 60 * 1000);
    expect(requiredGapMs("crew")).toBe(11 * 60 * 60 * 1000);
  });
});

describe("validateInterval", () => {
  it("rejects zero-duration and end<start (E06)", () => {
    expect(validateInterval("2026-09-06T06:00:00Z", "2026-09-06T06:00:00Z")).toBe(false);
    expect(validateInterval("2026-09-06T07:00:00Z", "2026-09-06T06:00:00Z")).toBe(false);
    expect(validateInterval("2026-09-06T06:00:00Z", "2026-09-06T06:01:00Z")).toBe(true);
  });
});

describe("canPlaceSlot", () => {
  it("places on an empty lot", () => {
    expect(canPlaceSlot(slot(), [])).toEqual({ ok: true, reason: "OK" });
  });

  it("rejects overlap with OVERLAP:<id>", () => {
    const existing = [
      slot({ id: "slot_atlas", start: "2026-09-06T08:00:00Z", end: "2026-09-06T10:00:00Z", status: "confirmed" }),
    ];
    const check = canPlaceSlot(
      slot({ start: "2026-09-06T09:00:00Z", end: "2026-09-06T11:00:00Z" }),
      existing,
    );
    expect(check).toEqual({ ok: false, reason: "OVERLAP:slot_atlas" });
  });

  it("rejects a 29min turnaround gap, accepts 30min (stage)", () => {
    const existing = [
      slot({ id: "a", start: "2026-09-06T08:00:00Z", end: "2026-09-06T10:00:00Z", status: "confirmed" }),
    ];
    expect(
      canPlaceSlot(slot({ start: "2026-09-06T10:29:00Z", end: "2026-09-06T11:00:00Z" }), existing).ok,
    ).toBe(false);
    expect(
      canPlaceSlot(slot({ start: "2026-09-06T10:30:00Z", end: "2026-09-06T11:00:00Z" }), existing),
    ).toEqual({ ok: true, reason: "OK" });
  });

  it("enforces gear 15min swap and crew 11h rest", () => {
    const gearHold = slot({
      id: "g",
      resource_type: "gear",
      resource_id: "alexa-65",
      start: "2026-09-06T08:00:00Z",
      end: "2026-09-06T10:00:00Z",
      status: "confirmed",
    });
    expect(
      canPlaceSlot(
        slot({ resource_type: "gear", resource_id: "alexa-65", start: "2026-09-06T10:14:00Z", end: "2026-09-06T11:00:00Z" }),
        [gearHold],
      ).reason,
    ).toBe("SEPARATION_VIOLATION");

    const crewHold = slot({
      id: "c",
      resource_type: "crew",
      resource_id: "crew-maya",
      start: "2026-09-05T22:00:00Z",
      end: "2026-09-06T06:00:00Z",
      status: "confirmed",
    });
    const early = canPlaceSlot(
      slot({ resource_type: "crew", resource_id: "crew-maya", start: "2026-09-06T08:00:00Z", end: "2026-09-06T10:00:00Z" }),
      [crewHold],
    );
    expect(early.reason).toBe("CREW_REST_VIOLATION");
    const rested = canPlaceSlot(
      slot({ resource_type: "crew", resource_id: "crew-maya", start: "2026-09-06T17:00:00Z", end: "2026-09-06T18:00:00Z" }),
      [crewHold],
    );
    expect(rested).toEqual({ ok: true, reason: "OK" });
  });

  it("released holds never block", () => {
    const existing = [
      slot({ id: "old", start: "2026-09-06T06:00:00Z", end: "2026-09-06T07:00:00Z", status: "released" }),
    ];
    expect(canPlaceSlot(slot(), existing)).toEqual({ ok: true, reason: "OK" });
  });

  it("ignores the dragged slot itself (no-op drops validate clean)", () => {
    const self = slot({ id: "slot_drag" });
    expect(canPlaceSlot(self, [self], { ignoreId: "slot_drag" })).toEqual({
      ok: true,
      reason: "OK",
    });
  });

  it("rejects INVALID_INTERVAL without touching peers", () => {
    expect(
      canPlaceSlot(slot({ start: "2026-09-06T07:00:00Z", end: "2026-09-06T07:00:00Z" }), []),
    ).toEqual({ ok: false, reason: "INVALID_INTERVAL" });
  });
});

describe("clipSlotToDate", () => {
  it("clips a same-day hold to itself", () => {
    const seg = clipSlotToDate(slot(), "2026-09-06");
    expect(seg).not.toBeNull();
    expect(seg?.continuesBefore).toBe(false);
    expect(seg?.continuesAfter).toBe(false);
  });

  it("splits an overnight hold across midnight (E07)", () => {
    const night = slot({ start: "2026-09-06T22:00:00Z", end: "2026-09-07T06:00:00Z" });
    const tail = clipSlotToDate(night, "2026-09-06");
    const head = clipSlotToDate(night, "2026-09-07");
    expect(tail?.continuesAfter).toBe(true);
    expect(tail?.continuesBefore).toBe(false);
    expect(head?.continuesBefore).toBe(true);
    expect(head?.continuesAfter).toBe(false);
    expect(head?.startMs).toBe(Date.parse("2026-09-07T00:00:00Z"));
  });

  it("returns null off-date and for zero-duration (rejected, never rendered)", () => {
    expect(clipSlotToDate(slot(), "2026-09-07")).toBeNull();
    expect(
      clipSlotToDate(slot({ start: "2026-09-06T06:00:00Z", end: "2026-09-06T06:00:00Z" }), "2026-09-06"),
    ).toBeNull();
  });
});

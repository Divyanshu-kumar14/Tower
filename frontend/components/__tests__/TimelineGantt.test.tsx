/**
 * @vitest-environment jsdom
 *
 * TimelineGantt tests (T-08) — 4 stage rows, absolute holds, overlap
 * striping, overnight rendering, zero-duration rejection, drag propose /
 * reject, and E23 windowing (viewport + 1 buffer).
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TimelineGantt } from "../TimelineGantt";
import type { SlotCardData } from "../SlotCard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DATE = "2026-09-06";

function makeSlot(i: number, over: Partial<SlotCardData> = {}): SlotCardData {
  const pads = ["stage-1", "stage-2", "stage-3", "adr-suite"];
  const pad = pads[i % pads.length] ?? "stage-3";
  const startMin = (6 + Math.floor(i / 4)) * 60 + (i % 2 === 0 ? 0 : 30);
  const endMin = startMin + 30;
  const stamp = (m: number) =>
    `${DATE}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00Z`;
  return {
    id: `slot_${i}`,
    production: `Production ${i}`,
    resource_type: "stage",
    resource_id: pad,
    start: stamp(startMin),
    end: stamp(endMin),
    status: "confirmed",
    request_id: `req_${i}`,
    trace_id: `trace_${i}`,
    ...over,
  };
}

const noop = () => {};

describe("TimelineGantt", () => {
  it("renders 4 stage rows with holds as cards", () => {
    const slots = Array.from({ length: 8 }, (_, i) => makeSlot(i));
    render(
      <TimelineGantt slots={slots} date={DATE} selectedSlot={null} onSelectSlot={noop} />,
    );
    for (const label of ["Stage 1", "Stage 2", "Stage 3", "ADR Suite"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByTestId("slot-card")).toHaveLength(8);
  });

  it("shows the real empty state when the lot is clear", () => {
    render(
      <TimelineGantt slots={[]} date={DATE} selectedSlot={null} onSelectSlot={noop} />,
    );
    expect(screen.getByTestId("gantt-empty")).toHaveTextContent("No ops — request a stage");
  });

  it("renders shimmer rows while loading", () => {
    render(
      <TimelineGantt slots={[]} date={DATE} selectedSlot={null} onSelectSlot={noop} isLoading />,
    );
    expect(screen.getByTestId("gantt-loading")).toBeInTheDocument();
  });

  it("stripes overlapping holds on the same pad (US-02)", () => {
    const slots = [
      makeSlot(0, { id: "a", resource_id: "stage-3", start: `${DATE}T08:00:00Z`, end: `${DATE}T10:00:00Z` }),
      makeSlot(1, { id: "b", resource_id: "stage-3", start: `${DATE}T09:00:00Z`, end: `${DATE}T11:00:00Z` }),
    ];
    const { container } = render(
      <TimelineGantt slots={slots} date={DATE} selectedSlot={null} onSelectSlot={noop} />,
    );
    const striped = container.querySelectorAll('[data-slot-id]');
    expect(striped).toHaveLength(2);
    for (const el of Array.from(striped)) {
      expect(el.getAttribute("style") ?? "").toContain("repeating-linear-gradient");
    }
  });

  it("rejects zero-duration data client-side — never rendered, never sent", () => {
    const slots = [
      makeSlot(0, { id: "zero", start: `${DATE}T08:00:00Z`, end: `${DATE}T08:00:00Z` }),
      makeSlot(1, { id: "fine" }),
    ];
    const { container } = render(
      <TimelineGantt slots={slots} date={DATE} selectedSlot={null} onSelectSlot={noop} />,
    );
    expect(container.querySelector('[data-slot-id="zero"]')).toBeNull();
    expect(container.querySelector('[data-slot-id="fine"]')).not.toBeNull();
  });

  it("renders overnight holds clipped to the date with cut marks (E07)", () => {
    const slots = [
      makeSlot(0, {
        id: "night",
        resource_id: "stage-2",
        start: `${DATE}T22:00:00Z`,
        end: "2026-09-07T06:00:00Z",
      }),
    ];
    const { container } = render(
      <TimelineGantt slots={slots} date={DATE} selectedSlot={null} onSelectSlot={noop} />,
    );
    expect(container.querySelector('[data-slot-id="night"]')).not.toBeNull();
    /* Head segment renders on the next date too. */
    const { container: next } = render(
      <TimelineGantt slots={slots} date="2026-09-07" selectedSlot={null} onSelectSlot={noop} />,
    );
    expect(next.querySelector('[data-slot-id="night"]')).not.toBeNull();
  });

  it("selects and toggles through SlotCard buttons", () => {
    const onSelectSlot = vi.fn();
    const slots = [makeSlot(0, { id: "s1", resource_id: "stage-3" })];
    const { rerender } = render(
      <TimelineGantt slots={slots} date={DATE} selectedSlot={null} onSelectSlot={onSelectSlot} />,
    );
    fireEvent.click(screen.getByTestId("slot-card"));
    expect(onSelectSlot).toHaveBeenCalledWith({ slotId: "s1", resourceId: "stage-3" });
    rerender(
      <TimelineGantt
        slots={slots}
        date={DATE}
        selectedSlot={{ slotId: "s1", resourceId: "stage-3" }}
        onSelectSlot={onSelectSlot}
      />,
    );
    fireEvent.click(screen.getByTestId("slot-card"));
    expect(onSelectSlot).toHaveBeenLastCalledWith(null);
  });

  it("drag-to-reroute proposes a clear window and rejects an overlap (no API)", () => {
    /* jsdom has no PointerEvent — without the shim, fireEvent drops
       clientX and every drop computes NaN. Browsers are unaffected. */
    vi.stubGlobal("PointerEvent", MouseEvent as unknown as typeof PointerEvent);
    const onProposeMove = vi.fn();
    const slots = [
      makeSlot(0, { id: "drag", resource_id: "stage-1", start: `${DATE}T06:00:00Z`, end: `${DATE}T07:00:00Z` }),
      makeSlot(1, { id: "block", resource_id: "stage-1", start: `${DATE}T10:00:00Z`, end: `${DATE}T11:00:00Z` }),
    ];
    render(
      <TimelineGantt slots={slots} date={DATE} selectedSlot={null} onSelectSlot={noop} onProposeMove={onProposeMove} />,
    );
    const cells = screen.getAllByTestId("gantt-cell");
    /* +200px at 0.8889 px/min snaps to +4h → 10:00, overlapping `block`. */
    fireEvent.pointerDown(cells[0] as Element, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cells[0] as Element, { clientX: 300, pointerId: 1 });
    fireEvent.pointerUp(cells[0] as Element, { clientX: 300, pointerId: 1 });
    expect(onProposeMove).not.toHaveBeenCalled();
    expect(screen.getByTestId("gantt-toast")).toHaveTextContent(/overlaps block/);

    /* Small shift to 08:00 is clear → proposes. */
    fireEvent.pointerDown(cells[0] as Element, { clientX: 100, button: 0, pointerId: 2 });
    fireEvent.pointerMove(cells[0] as Element, { clientX: 212, pointerId: 2 });
    fireEvent.pointerUp(cells[0] as Element, { clientX: 212, pointerId: 2 });
    expect(onProposeMove).toHaveBeenCalledTimes(1);
    const move = onProposeMove.mock.calls[0]?.[0] as { slotId: string; toStart: string; toEnd: string };
    expect(move.slotId).toBe("drag");
    expect(move.toStart).toBe(`${DATE}T08:00:00Z`);
    expect(move.toEnd).toBe(`${DATE}T09:00:00Z`);
  });

  it("virtualizes 100+ holds: viewport + 1 buffer mount (E23)", () => {
    const pad = (n: number) => String(n).padStart(2, "0");
    /* Ends past midnight roll to the next date (valid ISO, E07 spill). */
    const stamp = (day: string, m: number) =>
      `${day}T${pad(Math.floor(m / 60))}:${pad(m % 60)}:00Z`;
    const slots: SlotCardData[] = Array.from({ length: 120 }, (_, i) => {
      const startMin = i * 12;
      const endMin = startMin + 30;
      const endDay = endMin >= 1440 ? "2026-09-07" : DATE;
      return {
        id: `slot_${i}`,
        production: `Production ${i}`,
        resource_type: "stage",
        resource_id: "stage-3",
        start: stamp(DATE, startMin),
        end: stamp(endDay, endMin % 1440),
        status: "confirmed",
        request_id: `req_${i}`,
        trace_id: `trace_${i}`,
      };
    });
    const { container } = render(
      <TimelineGantt slots={slots} date={DATE} selectedSlot={null} onSelectSlot={noop} />,
    );
    /* Unmeasured (jsdom zeros) renders everything — then constrain. */
    expect(container.querySelectorAll('[data-testid="gantt-cell"]')).toHaveLength(120);

    const viewport = screen.getByTestId("gantt-viewport");
    const lane = container.querySelector('[data-testid="gantt-lane"]') as HTMLElement;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 375 });
    lane.getBoundingClientRect = () =>
      ({ width: 1280, height: 68, top: 0, left: 0, bottom: 68, right: 1280, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    const mounted = container.querySelectorAll('[data-testid="gantt-cell"]');
    /* Visible 0–422min + 422min buffer → ~71 of 120 mount. */
    expect(mounted.length).toBeLessThan(120);
    expect(mounted.length).toBeGreaterThan(0);
    expect(container.querySelector('[data-slot-id="slot_0"]')).not.toBeNull();
    expect(container.querySelector('[data-slot-id="slot_119"]')).toBeNull();
  });
});

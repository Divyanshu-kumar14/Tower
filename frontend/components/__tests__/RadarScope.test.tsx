/**
 * @vitest-environment jsdom
 *
 * RadarScope tests (T-08) — blip field, conflicts + live region, keyboard
 * selection, DOMPurified tooltips (E21), clustering at 50+, drag propose /
 * reject, and the T-09 mount-contract exports.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  LiveDot,
  LotHealthMount,
  RadarScope,
  type RadarSlot,
} from "../RadarScope";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DATE = "2026-09-06";
const PADS = ["stage-1", "stage-2", "stage-3", "adr-suite"];

function makeSlot(i: number, over: Partial<RadarSlot> = {}): RadarSlot {
  const pad = PADS[i % PADS.length] ?? "stage-3";
  const hh = String(6 + (i % 12)).padStart(2, "0");
  return {
    id: `slot_${i}`,
    production: `Production ${i}`,
    resource_type: "stage",
    resource_id: pad,
    start: `${DATE}T${hh}:00:00Z`,
    end: `${DATE}T${hh}:30:00Z`,
    status: i % 3 === 0 ? "holding" : "confirmed",
    request_id: `req_${i}`,
    trace_id: `trace_${i}`,
    ...over,
  };
}

function tenSlots(): RadarSlot[] {
  return Array.from({ length: 10 }, (_, i) => makeSlot(i));
}

const noop = () => {};

describe("RadarScope", () => {
  it("renders one blip per stage slot (gear/crew never mount as blips)", () => {
    const slots: RadarSlot[] = [
      ...tenSlots(),
      makeSlot(100, { id: "gear_1", resource_type: "gear", resource_id: "alexa-65" }),
      makeSlot(101, { id: "crew_1", resource_type: "crew", resource_id: "crew-maya" }),
    ];
    render(
      <RadarScope slots={slots} date={DATE} selectedSlot={null} onSelectSlot={noop} onProposeMove={noop} />,
    );
    expect(screen.getAllByTestId("radar-blip")).toHaveLength(10);
    expect(screen.getByTestId("radar-scope")).toHaveTextContent("10 OPS");
  });

  it("shows the real empty state — grid plus sentence, never blank", () => {
    render(
      <RadarScope slots={[]} date={DATE} selectedSlot={null} onSelectSlot={noop} onProposeMove={noop} />,
    );
    expect(screen.getByTestId("radar-empty")).toHaveTextContent("No ops — request a stage");
    expect(screen.getByRole("button", { name: /file a request/i })).toBeInTheDocument();
  });

  it("renders shimmer skeletons while loading", () => {
    render(
      <RadarScope slots={[]} date={DATE} selectedSlot={null} onSelectSlot={noop} onProposeMove={noop} isLoading />,
    );
    expect(screen.getByTestId("radar-loading")).toBeInTheDocument();
  });

  it("pulses conflicted-resource blips rose and announces the blocker (US-02)", () => {
    const slots = tenSlots();
    render(
      <RadarScope
        slots={slots}
        date={DATE}
        selectedSlot={null}
        onSelectSlot={noop}
        onProposeMove={noop}
        conflicts={[{ resource_id: "stage-3", overlap: "08:00-10:00", blockedBy: "req_atlas" }]}
      />,
    );
    const live = screen.getByTestId("radar-conflicts");
    expect(live).toHaveTextContent("stage-3");
    expect(live).toHaveTextContent("req_atlas");
    const pulsing = screen
      .getAllByTestId("radar-blip")
      .filter((b) => b.querySelector(".animate-tower-blip") !== null);
    expect(pulsing.length).toBeGreaterThan(0);
  });

  it("selects on click and toggles on second click", () => {
    const onSelectSlot = vi.fn();
    const slots = tenSlots();
    const { rerender } = render(
      <RadarScope slots={slots} date={DATE} selectedSlot={null} onSelectSlot={onSelectSlot} onProposeMove={noop} />,
    );
    fireEvent.click(screen.getAllByTestId("radar-blip")[0] as Element);
    expect(onSelectSlot).toHaveBeenCalledWith({ slotId: "slot_0", resourceId: "stage-1" });
    rerender(
      <RadarScope
        slots={slots}
        date={DATE}
        selectedSlot={{ slotId: "slot_0", resourceId: "stage-1" }}
        onSelectSlot={onSelectSlot}
        onProposeMove={noop}
      />,
    );
    fireEvent.click(screen.getAllByTestId("radar-blip")[0] as Element);
    expect(onSelectSlot).toHaveBeenLastCalledWith(null);
  });

  it("tabs through blips and selects with Enter", () => {
    const onSelectSlot = vi.fn();
    render(
      <RadarScope slots={tenSlots()} date={DATE} selectedSlot={null} onSelectSlot={onSelectSlot} onProposeMove={noop} />,
    );
    const blips = screen.getAllByTestId("radar-blip");
    for (const b of blips) expect(b).toHaveAttribute("tabindex", "0");
    const first = blips[0];
    if (!first) throw new Error("expected blips");
    fireEvent.keyDown(first, { key: "Enter" });
    expect(onSelectSlot).toHaveBeenCalledWith({ slotId: "slot_0", resourceId: "stage-1" });
  });

  it("sanitizes tooltip HTML — hostile production names render inert (E21)", () => {
    const hostile = makeSlot(0, { production: `<script>alert("xss")</script>Atlas` });
    const { container } = render(
      <RadarScope slots={[hostile]} date={DATE} selectedSlot={null} onSelectSlot={noop} onProposeMove={noop} />,
    );
    fireEvent.mouseEnter(screen.getByTestId("radar-blip"));
    const tip = screen.getByTestId("radar-tooltip");
    expect(tip.innerHTML).not.toContain("<script");
    expect(container.querySelector("script")).toBeNull();
    expect(tip.textContent ?? "").toContain("Atlas");
  });

  it("clusters by stage at 50+ blips", () => {
    const slots = Array.from({ length: 55 }, (_, i) => makeSlot(i));
    render(
      <RadarScope slots={slots} date={DATE} selectedSlot={null} onSelectSlot={noop} onProposeMove={noop} />,
    );
    expect(screen.queryAllByTestId("radar-blip")).toHaveLength(0);
    expect(screen.getByLabelText(/stage 3: \d+ operations, clustered by stage/i)).toBeInTheDocument();
  });

  it("drag-to-propose fires onProposeMove for a clear window, no API involved", () => {
    /* jsdom has no PointerEvent — without the shim, fireEvent drops
       clientX/Y and every drop computes NaN. Browsers are unaffected. */
    vi.stubGlobal("PointerEvent", MouseEvent as unknown as typeof PointerEvent);
    const onProposeMove = vi.fn();
    const slots = [
      makeSlot(0, { id: "slot_move", resource_id: "stage-3", start: `${DATE}T06:00:00Z`, end: `${DATE}T07:00:00Z`, status: "confirmed" }),
    ];
    render(
      <RadarScope slots={slots} date={DATE} selectedSlot={null} onSelectSlot={noop} onProposeMove={onProposeMove} />,
    );
    const blip = screen.getByTestId("radar-blip");
    const svg = screen.getByTestId("radar-svg");
    /* Drop near the Stage 2 pad (494,278): zero-size layout falls back to client px. */
    fireEvent.pointerDown(blip, { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 592, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 592, clientY: 300, pointerId: 1 });
    expect(onProposeMove).toHaveBeenCalledTimes(1);
    const move = onProposeMove.mock.calls[0]?.[0] as { slotId: string; toResourceId: string; toStart: string; toEnd: string };
    expect(move.slotId).toBe("slot_move");
    expect(move.toResourceId).toBe("stage-2");
    expect(move.toStart).toBe(`${DATE}T07:00:00Z`);
    expect(move.toEnd).toBe(`${DATE}T08:00:00Z`);
  });

  it("invalid drag shakes + toasts and never proposes (no API call)", () => {
    vi.stubGlobal("PointerEvent", MouseEvent as unknown as typeof PointerEvent);
    const onProposeMove = vi.fn();
    const slots = [
      makeSlot(0, { id: "slot_move", resource_id: "stage-3", start: `${DATE}T06:00:00Z`, end: `${DATE}T07:00:00Z`, status: "confirmed" }),
      /* Blocks the Stage 2 07:00–08:00 drop window from the previous test. */
      makeSlot(1, { id: "slot_block", resource_id: "stage-2", start: `${DATE}T06:30:00Z`, end: `${DATE}T08:00:00Z`, status: "confirmed" }),
    ];
    const { container } = render(
      <RadarScope slots={slots} date={DATE} selectedSlot={null} onSelectSlot={noop} onProposeMove={onProposeMove} />,
    );
    const blips = screen.getAllByTestId("radar-blip");
    const svg = screen.getByTestId("radar-svg");
    fireEvent.pointerDown(blips[0] as Element, { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 592, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 592, clientY: 300, pointerId: 1 });
    expect(onProposeMove).not.toHaveBeenCalled();
    expect(screen.getByTestId("radar-toast")).toHaveTextContent(/overlaps slot_block/);
    expect(container.querySelector(".animate-tower-shake")).not.toBeNull();
  });
});

describe("LiveDot", () => {
  it("renders live / reconnecting / polling states", () => {
    const { rerender } = render(<LiveDot status="live" lastEventAt={null} />);
    expect(screen.getByTestId("live-dot")).toHaveTextContent("Live");
    rerender(<LiveDot status="reconnecting" lastEventAt={null} />);
    expect(screen.getByTestId("live-dot")).toHaveTextContent("Live: reconnecting…");
    rerender(<LiveDot status="polling" lastEventAt={Date.parse("2026-09-06T12:00:00Z")} />);
    expect(screen.getByTestId("live-dot")).toHaveTextContent("Live: polling every 5s");
    expect(screen.getByTestId("live-dot")).toHaveTextContent("EVENT 12:00:00");
  });
});

describe("LotHealthMount", () => {
  it("leaves a typed mount point without building the strip", () => {
    render(<LotHealthMount date={DATE} />);
    const mount = screen.getByLabelText("Lot health");
    expect(mount).toHaveAttribute("data-mount", "lot-health");
    expect(mount).toHaveTextContent("T-09");
  });
});

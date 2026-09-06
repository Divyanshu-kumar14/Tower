/**
 * @vitest-environment jsdom
 *
 * SlotCard tests (T-08) — production/time/crew/trace rendering, conflict
 * striping, selection, and the XSS snapshot (E21: hostile production names
 * render inert — React escapes text, no <script> node ever mounts).
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SlotCard, type SlotCardData } from "../SlotCard";

afterEach(cleanup);

function card(over: Partial<SlotCardData> = {}): SlotCardData {
  return {
    id: "slot_1",
    production: "Project Atlas",
    resource_type: "stage",
    resource_id: "stage-3",
    start: "2026-09-06T08:00:00Z",
    end: "2026-09-06T10:00:00Z",
    status: "confirmed",
    request_id: "req_atlas",
    trace_id: "trace_atlas_001",
    ...over,
  };
}

describe("SlotCard", () => {
  it("renders production, window, crew/gear kin, and trace id", () => {
    render(
      <SlotCard
        slot={card()}
        crewLabels={["crew-maya"]}
        gearLabels={["alexa-65"]}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Project Atlas");
    expect(screen.getByRole("button")).toHaveTextContent("stage-3 · 08:00–10:00");
    expect(screen.getByRole("button")).toHaveTextContent("crew-maya · alexa-65");
    expect(screen.getByRole("button")).toHaveTextContent("trace trace_atlas_001");
  });

  it("selects on click and marks aria-pressed", () => {
    const onSelect = vi.fn();
    render(<SlotCard slot={card()} selected onSelect={onSelect} />);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("slot_1");
  });

  it("stripes conflicted holds (US-02)", () => {
    const { container } = render(<SlotCard slot={card()} conflicted />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("style") ?? "").toContain("repeating-linear-gradient");
    expect(button).toHaveAttribute("aria-label", expect.stringContaining("conflicting") as unknown as string);
    expect(container).toBeInTheDocument();
  });

  it("renders hostile production names inert — no script node (E21 snapshot)", () => {
    const hostile = card({ production: `<script>alert("xss")</script>Atlas` });
    const { container } = render(<SlotCard slot={hostile} />);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("button").textContent ?? "").toContain("Atlas");
  });
});

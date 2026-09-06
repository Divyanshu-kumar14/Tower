/**
 * @vitest-environment jsdom
 *
 * LotHealthStrip tests (T-09) — live KPIs, Grafana-down stale path
 * (`Observability delayed` + cached/empty values), mount-contract attrs,
 * and the stream-status readout from `useRadarStream`.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LotHealthStrip } from "../LotHealthStrip";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderStrip(
  over: Partial<React.ComponentProps<typeof LotHealthStrip>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <LotHealthStrip date="2026-09-06" streamStatus="live" lastEventAt={null} {...over} />
    </QueryClientProvider>,
  );
  return { ...utils, client };
}

describe("LotHealthStrip", () => {
  it("keeps the T-08 mount contract (label + data-mount)", () => {
    renderStrip({
      fetcher: async () => ({ utilizationPct: 62.5, activeConflicts: 1, avgResolveSecs: 94 }),
    });
    const mount = screen.getByLabelText("Lot health");
    expect(mount).toHaveAttribute("data-mount", "lot-health");
  });

  it("renders live KPIs without cards or hero-metric clichés", async () => {
    renderStrip({
      fetcher: async () => ({ utilizationPct: 62.5, activeConflicts: 1, avgResolveSecs: 94 }),
    });
    await waitFor(() => expect(screen.getByTestId("lot-health")).toHaveAttribute("data-health", "live"));
    expect(screen.getByTestId("lot-health")).toHaveTextContent("62.5%");
    expect(screen.getByTestId("lot-health")).toHaveTextContent("avg resolve");
    expect(screen.getByTestId("lot-health")).toHaveTextContent("1m 34s");
    expect(screen.queryByTestId("health-stale-badge")).not.toBeInTheDocument();
  });

  it("Grafana-down path: 404 → stale badge + empty values + retry", async () => {
    const fetcher = vi.fn(async () => {
      throw Object.assign(new Error("metrics unavailable (HTTP 404)"), { status: 404 });
    });
    renderStrip({ fetcher });
    await waitFor(() =>
      expect(screen.getByTestId("health-stale-badge")).toHaveTextContent("Observability delayed"),
    );
    /* Cached/empty values — em-dashes, never blank, never thrown. */
    expect(screen.getByTestId("lot-health")).toHaveTextContent("—");
    expect(screen.getByTestId("lot-health")).toHaveTextContent(/never updated|probing/);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();

    /* Retry re-fires the fetcher. */
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("surfaces the stream status beside the freshness readout", async () => {
    renderStrip({
      streamStatus: "reconnecting",
      lastEventAt: Date.parse("2026-09-06T12:00:00Z"),
      fetcher: async () => ({ utilizationPct: 10, activeConflicts: 0, avgResolveSecs: 5 }),
    });
    await waitFor(() => expect(screen.getByTestId("lot-health")).toHaveAttribute("data-health", "live"));
    expect(screen.getByTestId("lot-health")).toHaveTextContent("STREAM RECONNECTING");
    expect(screen.getByTestId("lot-health")).toHaveTextContent("EVENT 12:00:00");
  });
});

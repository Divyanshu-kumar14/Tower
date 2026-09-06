/**
 * @vitest-environment jsdom
 *
 * useLotMetrics tests (T-09) — injectable fetcher, exact T-11 payload
 * validation, 404 → stale, and the 30s-cache `updated Xs ago` readout
 * under fake timers.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  formatUpdatedAgo,
  LOT_METRICS_STALE_MS,
  parseLotMetricsBody,
  useLotMetrics,
} from "../../hooks/useLotMetrics";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function Probe({
  date,
  fetcher,
}: {
  date: string;
  fetcher?: (date: string) => Promise<{ utilizationPct: number; activeConflicts: number; avgResolveSecs: number }>;
}) {
  const state = useLotMetrics(date, fetcher ? { fetcher } : {});
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      <span data-testid="ago">{state.updatedAgo}</span>
      <span data-testid="metrics">
        {state.metrics ? `${state.metrics.utilizationPct}/${state.metrics.activeConflicts}/${state.metrics.avgResolveSecs}` : "none"}
      </span>
    </div>
  );
}

describe("parseLotMetricsBody (T-11 contract guard)", () => {
  it("accepts the exact documented shape", () => {
    expect(
      parseLotMetricsBody({
        date: "2026-09-06",
        utilizationPct: 62.5,
        activeConflicts: 1,
        avgResolveSecs: 94,
        updatedAt: "2026-09-06T12:00:00Z",
        stale: false,
      }),
    ).toEqual({ utilizationPct: 62.5, activeConflicts: 1, avgResolveSecs: 94 });
  });

  it("rejects out-of-range and mistyped fields loudly", () => {
    expect(() => parseLotMetricsBody(null)).toThrow();
    expect(() =>
      parseLotMetricsBody({ utilizationPct: 140, activeConflicts: 0, avgResolveSecs: 1 }),
    ).toThrow(/utilizationPct/);
    expect(() =>
      parseLotMetricsBody({ utilizationPct: 10, activeConflicts: -1, avgResolveSecs: 1 }),
    ).toThrow(/activeConflicts/);
    expect(() =>
      parseLotMetricsBody({ utilizationPct: 10, activeConflicts: 0, avgResolveSecs: -5 }),
    ).toThrow(/avgResolveSecs/);
  });

  it("holds the 30s stale window constant", () => {
    expect(LOT_METRICS_STALE_MS).toBe(30_000);
  });
});

describe("formatUpdatedAgo", () => {
  it("reads seconds then minutes", () => {
    expect(formatUpdatedAgo(1_000_003, 1_000_000)).toBe("updated 0s ago");
    expect(formatUpdatedAgo(1_000_000 + 23_000, 1_000_000)).toBe("updated 23s ago");
    expect(formatUpdatedAgo(1_000_000 + 125_000, 1_000_000)).toBe("updated 2m 5s ago");
    expect(formatUpdatedAgo(1_000_000 + 120_000, 1_000_000)).toBe("updated 2m ago");
    expect(formatUpdatedAgo(Date.now(), null)).toBe("never updated");
  });
});

describe("useLotMetrics", () => {
  it("returns live metrics from the injectable fetcher", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(<Probe date="2026-09-06" fetcher={async () => ({ utilizationPct: 62.5, activeConflicts: 1, avgResolveSecs: 94 })} />, {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("live"));
    expect(screen.getByTestId("metrics")).toHaveTextContent("62.5/1/94");
    expect(screen.getByTestId("ago")).toHaveTextContent(/updated \d+s ago/);
  });

  it("missing /api/metrics (404) → stale with empty values, never throws", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const err = Object.assign(new Error("metrics unavailable (HTTP 404)"), { status: 404 });
    render(<Probe date="2026-09-06" fetcher={async () => { throw err; }} />, {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("stale"));
    expect(screen.getByTestId("metrics")).toHaveTextContent("none");
    expect(screen.getByTestId("ago")).toHaveTextContent("never updated");
  });

  it("ticks `updated Xs ago` forward under fake timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(<Probe date="2026-09-06" fetcher={async () => ({ utilizationPct: 10, activeConflicts: 0, avgResolveSecs: 5 })} />, {
      wrapper: wrapper(client),
    });
    /* Flush the fetch + query commit without waitFor (its timers are mocked). */
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("status")).toHaveTextContent("live");
    expect(screen.getByTestId("ago")).toHaveTextContent("updated 0s ago");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(screen.getByTestId("ago")).toHaveTextContent("updated 35s ago");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId("ago")).toHaveTextContent("updated 1m 35s ago");
  });
});

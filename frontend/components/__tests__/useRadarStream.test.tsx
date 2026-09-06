/**
 * @vitest-environment jsdom
 *
 * useRadarStream tests (T-08, E18) — SSE invalidates `['slots', date]`,
 * backoff reconnects, and a 5s-down fallback polls every 5s.
 */
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRadarStream } from "../../hooks/useRadarStream";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<() => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  close(): void {
    this.closed = true;
  }
  emit(type: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
  triggerOpen(): void {
    this.onopen?.({});
  }
  triggerError(): void {
    this.onerror?.({});
  }
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useRadarStream", () => {
  it("connects to /api/stream and reports live on open", () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const client = new QueryClient();
    const { result } = renderHook(() => useRadarStream("2026-09-06"), {
      wrapper: wrapper(client),
    });
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toBe("/api/stream");
    expect(result.current.status).toBe("reconnecting");
    act(() => {
      MockEventSource.instances[0]?.triggerOpen();
    });
    expect(result.current.status).toBe("live");
  });

  it("invalidates ['slots', date] on slot:confirmed and records the event", () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRadarStream("2026-09-06"), {
      wrapper: wrapper(client),
    });
    act(() => {
      MockEventSource.instances[0]?.triggerOpen();
      MockEventSource.instances[0]?.emit("slot:confirmed");
    });
    expect(result.current.lastEventAt).not.toBeNull();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["slots", "2026-09-06"] });
    act(() => {
      MockEventSource.instances[0]?.emit("collision");
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("reconnects with backoff and polls every 5s after 5s down (E18)", () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRadarStream("2026-09-06"), {
      wrapper: wrapper(client),
    });
    act(() => {
      MockEventSource.instances[0]?.triggerOpen();
    });
    expect(result.current.status).toBe("live");

    act(() => {
      MockEventSource.instances[0]?.triggerError();
    });
    expect(result.current.status).toBe("reconnecting");
    /* Backoff reconnect (1s) spawns a fresh source. */
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(MockEventSource.instances.length).toBeGreaterThan(1);
    /* Still down at 5s → poll fallback. */
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.status).toBe("polling");
    const calls = invalidate.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(invalidate.mock.calls.length).toBeGreaterThan(calls);
  });

  it("polls without pretending to be live when EventSource is missing", () => {
    vi.stubGlobal("EventSource", undefined as unknown as typeof EventSource);
    const client = new QueryClient();
    const { result } = renderHook(() => useRadarStream("2026-09-06"), {
      wrapper: wrapper(client),
    });
    expect(result.current.status).toBe("polling");
    expect(result.current.lastEventAt).toBeNull();
  });
});

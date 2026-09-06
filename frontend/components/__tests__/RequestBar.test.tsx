/**
 * @vitest-environment jsdom
 *
 * RequestBar + useParse tests (T-07).
 * - RequestBar: guards (no onSubmit, no key, shake + message), valid submit
 *   shape (text + UUIDv4), chips / clarification / ghost-chip / skeleton /
 *   live-region rendering, URL scope, Escape, suggestions.
 * - useParse: client guards make NO fetch call; debounce drops rapid
 *   re-submits; 200/422/409 map to confirmed/conflict/clarify/unknown.
 */
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RequestBar } from "../RequestBar";
import { useParse, type UseParseReturn } from "../../hooks/useParse";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function submitForm(container: HTMLElement): void {
  const form = container.querySelector("form");
  if (!form) throw new Error("RequestBar form not found");
  fireEvent.submit(form);
}

function fillInput(value: string): void {
  fireEvent.change(screen.getByLabelText(/describe the shoot/i), {
    target: { value },
  });
}

/* ------------------------------------------------------------------ */
/* RequestBar                                                          */
/* ------------------------------------------------------------------ */

describe("RequestBar", () => {
  it("renders the transmit console with named action + help", () => {
    render(<RequestBar onSubmit={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Transmit request" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/describe the shoot/i)).toHaveAttribute(
      "placeholder",
      "Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm",
    );
    expect(screen.getByText(/no ops on the wire/i)).toBeInTheDocument();
  });

  it("rejects empty input: no submit, shake + problem/recovery message", async () => {
    const onSubmit = vi.fn();
    const { container } = render(<RequestBar onSubmit={onSubmit} />);
    submitForm(container);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/empty/i);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector(".animate-tower-shake")).not.toBeNull();
  });

  it("rejects >500 chars client-side with no submit", async () => {
    const onSubmit = vi.fn();
    const { container } = render(<RequestBar onSubmit={onSubmit} />);
    fillInput("x".repeat(501));
    submitForm(container);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/500/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("transmits valid text with a fresh UUIDv4 key", async () => {
    const onSubmit = vi.fn();
    const { container } = render(<RequestBar onSubmit={onSubmit} />);
    fillInput("Stage 3 tomorrow 6am-6pm, Alexa 65");
    submitForm(container);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toBe(
      "Stage 3 tomorrow 6am-6pm, Alexa 65",
    );
    expect(onSubmit.mock.calls[0]?.[1]).toMatch(UUID_V4);
  });

  it("Escape clears the line", () => {
    render(<RequestBar onSubmit={() => {}} />);
    const input = screen.getByLabelText(/describe the shoot/i);
    fillInput("Stage 3 tomorrow");
    expect(input).toHaveValue("Stage 3 tomorrow");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
  });

  it("reads valid ?date&stage scope from the URL", () => {
    window.history.replaceState({}, "", "/?date=2026-09-06&stage=3");
    render(<RequestBar onSubmit={() => {}} />);
    expect(screen.getByText(/SCOPE/)).toHaveTextContent(
      "SCOPE 2026-09-06 · STAGE 3",
    );
  });

  it("ignores an invalid ?date but keeps a valid stage", () => {
    window.history.replaceState({}, "", "/?date=tomorow&stage=3");
    render(<RequestBar onSubmit={() => {}} />);
    expect(screen.getByText(/SCOPE/)).toHaveTextContent("STAGE 3");
    expect(screen.getByText(/SCOPE/)).not.toHaveTextContent("tomorow");
  });

  it("renders confirmed chips + announces them in the live region", () => {
    render(
      <RequestBar
        onSubmit={() => {}}
        parse={{
          status: "confirmed",
          chips: [
            {
              resource_type: "stage",
              resource_id: "stage-3",
              start: "2026-09-06T06:00:00Z",
              end: "2026-09-06T18:00:00Z",
            },
            {
              resource_type: "crew",
              resource_id: "crew-maya",
              start: "2026-09-06T14:00:00Z",
              end: "2026-09-06T16:00:00Z",
            },
          ],
          clarification: null,
          unknownResource: null,
          error: null,
          notice: null,
          hasConflict: false,
          conflicts: [],
          traceId: "trace_abc123",
        }}
      />,
    );
    expect(screen.getByLabelText("Parsed request")).toHaveTextContent("stage-3");
    expect(screen.getByLabelText("Parsed request")).toHaveTextContent("crew-maya");
    expect(screen.getByRole("status")).toHaveTextContent(
      /confirmed: 2 slots, trace trace_abc123/i,
    );
    expect(screen.getByText("trace_abc123")).toBeInTheDocument();
  });

  it("renders the `?` clarification chip + Did-you-mean + announcement", () => {
    render(
      <RequestBar
        onSubmit={() => {}}
        parse={{
          status: "clarify",
          chips: [],
          clarification: { field: "date", message: "Did you mean 2026-09-06?" },
          unknownResource: null,
          error: null,
          notice: null,
          hasConflict: false,
          conflicts: [],
          traceId: null,
        }}
      />,
    );
    expect(screen.getByText("Did you mean …?")).toBeInTheDocument();
    expect(screen.getByText("Did you mean 2026-09-06?")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/needs clarification/i);
  });

  it("renders the ghost chip + suggestions; picking one fills the line", () => {
    const onPick = vi.fn();
    render(
      <RequestBar
        onSubmit={() => {}}
        onSuggestionSelect={onPick}
        parse={{
          status: "unknown",
          chips: [],
          clarification: null,
          unknownResource: {
            name: "Alexa 1000",
            suggestions: ["Alexa 65", "Alexa Mini"],
          },
          error: null,
          notice: null,
          hasConflict: false,
          conflicts: [],
          traceId: null,
        }}
      />,
    );
    expect(screen.getByText(/alexa 1000 — not on the lot/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Alexa 65" }));
    expect(onPick).toHaveBeenCalledWith("Alexa 65");
    expect(screen.getByRole("status")).toHaveTextContent(/unknown resource/i);
  });

  it("fills the line with a suggestion when no handler is wired", () => {
    render(
      <RequestBar
        onSubmit={() => {}}
        parse={{
          status: "unknown",
          chips: [],
          clarification: null,
          unknownResource: { name: "Alexa 1000", suggestions: ["Alexa 65"] },
          error: null,
          notice: null,
          hasConflict: false,
          conflicts: [],
          traceId: null,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Alexa 65" }));
    expect(screen.getByLabelText(/describe the shoot/i)).toHaveValue("Alexa 65");
  });

  it("shows parsing shimmer state while loading", () => {
    const { container } = render(<RequestBar onSubmit={() => {}} isLoading />);
    const button = screen.getByRole("button", { name: "Transmit request" });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Parsing…");
    /* Skeleton tracks render while parsing (spinner-free). */
    expect(
      container.querySelectorAll(".animate-tower-shimmer").length,
    ).toBeGreaterThan(0);
  });

  it("renders useParse errors with problem + recovery", () => {
    render(
      <RequestBar
        onSubmit={() => {}}
        parse={{
          status: "error",
          chips: [],
          clarification: null,
          unknownResource: null,
          error: "Tower unreachable — check connection and retry.",
          notice: null,
          hasConflict: false,
          conflicts: [],
          traceId: null,
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/unreachable/);
    expect(screen.getByRole("status")).toHaveTextContent(/unreachable/);
  });
});

/* ------------------------------------------------------------------ */
/* useParse                                                            */
/* ------------------------------------------------------------------ */

const AGENT_OK = {
  requestId: "req_123",
  parsed: {
    slots: [
      {
        resource_type: "stage",
        resource_id: "stage-3",
        start: "2026-09-06T06:00:00Z",
        end: "2026-09-06T18:00:00Z",
      },
      {
        resource_type: "gear",
        resource_id: "alexa-65",
        start: "2026-09-06T06:00:00Z",
        end: "2026-09-06T18:00:00Z",
      },
    ],
    confidence: 0.92,
  },
  collision: {
    hasConflict: false,
    conflicts: [],
    alternatives: [],
  },
  traceId: "trace_abc123",
};

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function renderHook() {
  const ref: { current: UseParseReturn | null } = { current: null };
  function Harness() {
    const api = useParse();
    ref.current = api;
    return null;
  }
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return ref;
}

describe("useParse", () => {
  it("guard: empty submit makes no API call, shakes, names recovery", async () => {
    const fetch = stubFetch(200, AGENT_OK);
    const ref = renderHook();
    await act(async () => {
      await ref.current?.submit("   ");
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(ref.current?.status).toBe("error");
    expect(ref.current?.error).toMatch(/empty/i);
    expect(ref.current?.shakeKey).toBe(1);
  });

  it("guard: >500 chars makes no API call", async () => {
    const fetch = stubFetch(200, AGENT_OK);
    const ref = renderHook();
    await act(async () => {
      await ref.current?.submit("x".repeat(501));
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(ref.current?.status).toBe("error");
    expect(ref.current?.error).toMatch(/500/);
  });

  it("200 without conflict → confirmed with chips + trace", async () => {
    stubFetch(200, AGENT_OK);
    const ref = renderHook();
    await act(async () => {
      await ref.current?.submit("Stage 3 tomorrow 6am-6pm, Alexa 65");
    });
    expect(ref.current?.status).toBe("confirmed");
    expect(ref.current?.chips).toHaveLength(2);
    expect(ref.current?.requestId).toBe("req_123");
    expect(ref.current?.traceId).toBe("trace_abc123");
    expect(ref.current?.confidence).toBe(0.92);
  });

  it("sends Idempotency-Key header mirroring the body key", async () => {
    const fetch = stubFetch(200, AGENT_OK);
    const ref = renderHook();
    await act(async () => {
      await ref.current?.submit("Stage 3 tomorrow 6am");
    });
    const calls = fetch.mock.calls as unknown as Array<
      [input: unknown, init?: RequestInit]
    >;
    const init = calls[0]?.[1];
    expect(init).toBeDefined();
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(init?.body as string) as { idempotencyKey: string };
    expect(headers["Idempotency-Key"]).toMatch(UUID_V4);
    expect(body.idempotencyKey).toBe(headers["Idempotency-Key"]);
  });

  it("200 with conflict → conflict state + conflicts listed", async () => {
    stubFetch(200, {
      ...AGENT_OK,
      collision: {
        hasConflict: true,
        conflicts: [
          {
            resource_id: "stage-3",
            overlap: "08:00-10:00",
            blockedBy: "req_atlas",
          },
        ],
        alternatives: [],
      },
    });
    const ref = renderHook();
    await act(async () => {
      await ref.current?.submit("Stage 3 tomorrow 6am-6pm");
    });
    expect(ref.current?.status).toBe("conflict");
    expect(ref.current?.hasConflict).toBe(true);
    expect(ref.current?.conflicts[0]?.blockedBy).toBe("req_atlas");
  });

  it("422 NEEDS_CLARIFICATION → clarify with Did-you-mean", async () => {
    stubFetch(422, {
      code: "NEEDS_CLARIFICATION",
      field: "date",
      message: "Did you mean 2026-09-06?",
    });
    const ref = renderHook();
    await act(async () => {
      await ref.current?.submit("Stage 3 tomorow 6am");
    });
    expect(ref.current?.status).toBe("clarify");
    expect(ref.current?.clarification?.message).toBe("Did you mean 2026-09-06?");
  });

  it("200 unknown_resource extension → unknown with suggestions", async () => {
    stubFetch(200, {
      requestId: "req_124",
      traceId: "trace_xyz",
      unknown_resource: {
        name: "Alexa 1000",
        suggestions: ["Alexa 65", "Alexa Mini"],
      },
    });
    const ref = renderHook();
    await act(async () => {
      await ref.current?.submit("Stage 3 with Alexa 1000");
    });
    expect(ref.current?.status).toBe("unknown");
    expect(ref.current?.unknownResource?.suggestions).toEqual([
      "Alexa 65",
      "Alexa Mini",
    ]);
  });

  it("409 IDEMPOTENT_REPLAY → confirmed notice, no error", async () => {
    stubFetch(409, {
      code: "IDEMPOTENT_REPLAY",
      requestId: "req_123",
      message: "Same idempotencyKey already processed",
    });
    const ref = renderHook();
    await act(async () => {
      await ref.current?.submit("Stage 3 tomorrow 6am");
    });
    expect(ref.current?.status).toBe("confirmed");
    expect(ref.current?.notice).toMatch(/replayed/i);
    expect(ref.current?.error).toBeNull();
  });

  it("network failure → error naming problem + recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const ref = renderHook();
    await act(async () => {
      await ref.current?.submit("Stage 3 tomorrow 6am");
    });
    expect(ref.current?.status).toBe("error");
    expect(ref.current?.error).toMatch(/unreachable.*retry/i);
  });

  it("debounce: rapid double-submit fires one request", async () => {
    const fetch = stubFetch(200, AGENT_OK);
    const ref = renderHook();
    await act(async () => {
      await Promise.all([
        ref.current?.submit("Stage 3 tomorrow 6am"),
        ref.current?.submit("Stage 3 tomorrow 6am"),
      ]);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reset returns to idle", async () => {
    stubFetch(200, AGENT_OK);
    const ref = renderHook();
    await act(async () => {
      await ref.current?.submit("Stage 3 tomorrow 6am");
    });
    expect(ref.current?.status).toBe("confirmed");
    act(() => {
      ref.current?.reset();
    });
    expect(ref.current?.status).toBe("idle");
    expect(ref.current?.chips).toEqual([]);
  });
});

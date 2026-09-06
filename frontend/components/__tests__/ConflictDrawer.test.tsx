/**
 * @vitest-environment jsdom
 *
 * ConflictDrawer tests (T-09) — rose header copy, API-order preservation
 * (Stage-2-first never re-sorted), idempotent reroute POST, emerald
 * confirmation + traceId on 200, stale state + refetch hook on 409
 * STALE_ALTERNATIVE, drag-proposal reuse of the same mutation path, and
 * Radix-less dialog semantics (role=dialog, Escape, focus trap).
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConflictDrawer } from "../ConflictDrawer";
import type { AlternativeInfo, ConflictInfo } from "../../hooks/useParse";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DATE = "2026-09-06";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CONFLICTS: ConflictInfo[] = [
  { resource_id: "stage-3", overlap: "08:00-10:00", blockedBy: "req_atlas" },
];

const ALTERNATIVES: AlternativeInfo[] = [
  {
    resource_id: "stage-2",
    start: `${DATE}T06:00:00Z`,
    end: `${DATE}T18:00:00Z`,
    score: 0.95,
    reason: "Same size, free",
  },
  {
    resource_id: "stage-3",
    start: `${DATE}T18:00:00Z`,
    end: `${DATE}T20:00:00Z`,
    score: 0.7,
    reason: "Same stage, later window",
  },
];

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
}

function renderDrawer(
  over: Partial<React.ComponentProps<typeof ConflictDrawer>> = {},
  client = makeClient(),
) {
  const onClose = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <ConflictDrawer
        date={DATE}
        requestId="req_demo"
        conflicts={CONFLICTS}
        alternatives={ALTERNATIVES}
        selectedSlot={null}
        traceId="trace_parse_1"
        open
        onClose={onClose}
        {...over}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onClose, client };
}

function jsonResponse(status: number, body: unknown, traceId?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(traceId ? { "x-trace-id": traceId } : {}),
    },
  });
}

describe("ConflictDrawer", () => {
  it("renders the rose conflict header naming the block", () => {
    renderDrawer();
    expect(screen.getByTestId("conflict-drawer")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "stage-3 conflict 08:00-10:00 — blocked by req_atlas",
    );
  });

  it("preserves API alternative order — Stage-2-first is never re-sorted", () => {
    renderDrawer();
    const rows = screen.getAllByTestId("alternative-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-resource", "stage-2");
    expect(rows[1]).toHaveAttribute("data-resource", "stage-3");
  });

  it("preserves a reversed API order verbatim (no client-side ranking)", () => {
    renderDrawer({ alternatives: [...ALTERNATIVES].reverse() });
    const rows = screen.getAllByTestId("alternative-row");
    expect(rows[0]).toHaveAttribute("data-resource", "stage-3");
    expect(rows[1]).toHaveAttribute("data-resource", "stage-2");
  });

  it("shows each alternative with mono window, reason, and score", () => {
    renderDrawer();
    const first = screen.getAllByTestId("alternative-row")[0] as HTMLElement;
    expect(first).toHaveTextContent("06:00–18:00");
    expect(first).toHaveTextContent("Same size, free");
    expect(first).toHaveTextContent("SCORE 0.95");
    expect(
      screen.getByRole("button", { name: /reroute and hold stage-2/i }),
    ).toBeInTheDocument();
  });

  it("posts an idempotent reroute and confirms emerald with the traceId", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return jsonResponse(
          200,
          { status: "confirmed", slots: [], traceId: "trace_reroute_1" },
          "trace_reroute_1",
        );
      }),
    );
    const client = makeClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const onRerouted = vi.fn();
    renderDrawer({ onRerouted }, client);

    fireEvent.click(screen.getByRole("button", { name: /reroute and hold stage-2/i }));

    await waitFor(() => {
      expect(screen.getByTestId("reroute-confirmation")).toHaveTextContent(
        "Rerouted & held — radar is green.",
      );
    });
    expect(screen.getByTestId("reroute-trace")).toHaveTextContent(
      "TRACE trace_reroute_1",
    );

    /* Idempotent contract: fresh UUID mirrored header + body. */
    expect(seen).toHaveLength(1);
    const call = seen[0] as { url: string; init: RequestInit };
    expect(call.url).toBe("/api/reroute");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(UUID_RE);
    const body = JSON.parse(call.init.body as string) as {
      requestId: string;
      alternative: { resource_id: string };
      idempotencyKey: string;
    };
    expect(body.requestId).toBe("req_demo");
    expect(body.alternative.resource_id).toBe("stage-2");
    expect(body.idempotencyKey).toBe(headers["Idempotency-Key"]);

    /* Radar goes green through the same cache the scope reads. */
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["slots", DATE] });
    expect(onRerouted).toHaveBeenCalledWith({ traceId: "trace_reroute_1" });
  });

  it("409 STALE_ALTERNATIVE shows the stale state and triggers a refetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(409, {
          code: "STALE_ALTERNATIVE",
          message: "alternative taken between check and hold",
        }),
      ),
    );
    const onRefreshAlternatives = vi.fn();
    renderDrawer({ onRefreshAlternatives });

    fireEvent.click(screen.getByRole("button", { name: /reroute and hold stage-2/i }));

    await waitFor(() => {
      expect(screen.getByTestId("stale-alternative")).toHaveTextContent(
        /stale — refreshed alternatives/i,
      );
    });
    expect(onRefreshAlternatives).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("reroute-confirmation")).not.toBeInTheDocument();
  });

  it("surfaces transport failures with problem + recovery, no confirmation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: /reroute and hold stage-2/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/check the connection and retry/i);
    });
  });

  it("renders the drag proposal as the lead row on the same mutation path", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return jsonResponse(200, { status: "confirmed", traceId: "trace_drag_1" });
      }),
    );
    renderDrawer({
      alternatives: [],
      proposedMove: {
        slotId: "slot_move",
        fromResourceId: "stage-3",
        toResourceId: "stage-2",
        toStart: `${DATE}T07:00:00Z`,
        toEnd: `${DATE}T08:00:00Z`,
        reason: "OK",
      },
    });
    const rows = screen.getAllByTestId("alternative-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Drag proposal");
    expect(rows[0]).toHaveTextContent("07:00–08:00");

    fireEvent.click(screen.getByRole("button", { name: /reroute and hold stage-2 07:00/i }));
    await waitFor(() => {
      expect(screen.getByTestId("reroute-confirmation")).toBeInTheDocument();
    });
    expect(seen).toEqual(["/api/reroute"]);
  });

  it("has dialog semantics, traps focus, and closes on Escape", () => {
    const { onClose } = renderDrawer();
    const dialog = screen.getByTestId("conflict-drawer");
    expect(dialog).toHaveAttribute("role", "dialog");
    /* Rendered nothing when closed. */
    cleanup();
    renderDrawer({ open: false });
    expect(screen.queryByTestId("conflict-drawer")).not.toBeInTheDocument();
    cleanup();

    const second = renderDrawer();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(second.onClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("announces the conflict zero times itself — no live region on the header", () => {
    renderDrawer();
    const dialog = screen.getByTestId("conflict-drawer");
    /* The single live region stays in RequestBar; the drawer must not echo. */
    expect(dialog.querySelector('[aria-live="polite"]')).toBeNull();
    expect(dialog.querySelector('[role="status"]')).toBeNull();
  });
});

"use client";

/**
 * ConflictDrawer (T-09) — the resolution half of the 60s demo.
 *
 * Bottom-sheet docked to the viewport floor (NOT a centered modal — craft
 * floor refuses the modal-for-a-non-interrupting-task default): ink slab,
 * 2px rose conflict rail on the top edge, 300ms spring entry via
 * framer-motion, sharp 2px geometry, cyan accent only, no purple, no glass.
 *
 * Opens on `parse.hasConflict` for the request (the page gates `open` on
 * the parse result; the selected radar hold is shown when present). Header
 * copy names the block: "Stage 3 conflict 08:00–10:00 — blocked by
 * req_atlas". Ranked alternatives render as ledger rows in the EXACT order
 * the API returned (Stage-2-first ordering preserved — never re-sorted
 * client-side), each with resource, mono window, reason, score, and an
 * emerald `Reroute & Hold` CTA.
 *
 * Mutation: `POST /api/reroute` (`app/api/reroute/route.ts` idempotent
 * contract) with a FRESH `crypto.randomUUID()` per click, mirrored as both
 * the `Idempotency-Key` header and the body `idempotencyKey` (the route
 * 422s when they differ). On 200 → invalidate `['slots', date]` (radar goes
 * green) + emerald confirmation with the traceId. On 409
 * `STALE_ALTERNATIVE` → inline "stale — refreshed alternatives" state +
 * slots refetch via `onRefreshAlternatives`. A gantt/radar drag
 * `ProposedMove` renders as the lead row and reuses the SAME mutation path.
 *
 * Accessibility: `role="dialog"` + labelled header, Escape closes, manual
 * focus trap (no Radix — Radix-less dialog, Tab cycles inside, focus
 * returns to the invoker on close). The conflict itself is announced ONCE
 * through RequestBar's `#tower-request-live` region — this drawer renders
 * NO live region for the conflict (no double-speak). Only the fresh
 * reroute confirmation uses `role="status"`.
 *
 * ── T-11 follow-up (documented, not scope-crept) ────────────────────────
 * Remote-collision SSE pulses (`collision` events from `GET /api/stream`)
 * currently only invalidate `['slots', date]` via `useRadarStream`. Turning
 * those payloads into drawer conflicts needs an SSE-payload store + request
 * correlation the BFF does not emit yet — T-11 wires that; T-09 stays on
 * the local-parse path (deterministic for the canned demo).
 */
import * as React from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, Copy, X } from "lucide-react";
import type { AlternativeInfo, ConflictInfo } from "../hooks/useParse";
import type { ProposedMove, SelectedSlot } from "./RadarScope";
import { slotKeys } from "../lib/query-client";
import { invalidateLotMetrics } from "../hooks/useLotMetrics";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { cn } from "./ui/utils";

export interface RerouteResult {
  traceId: string | null;
}

export interface ConflictDrawerProps {
  /** Viewed UTC date — owns the `['slots', date]` invalidation scope. */
  date: string;
  /** Request that produced the conflict (from `useParse`). */
  requestId: string | null;
  /** Conflicts from the parse response (header copy source). */
  conflicts: ConflictInfo[];
  /** Ranked alternatives — rendered in API order, never re-sorted. */
  alternatives: AlternativeInfo[];
  /** Selected radar hold, when the drawer was opened from a blip. */
  selectedSlot: SelectedSlot | null;
  /** Drag-to-reroute proposal — lead row, same mutation path. */
  proposedMove?: ProposedMove | null;
  /** Parse trace id (lineage until the reroute mints a new one). */
  traceId?: string | null;
  /** Page-gated: true while `parse.hasConflict` (and not dismissed). */
  open: boolean;
  onClose: () => void;
  onRerouted?: (result: RerouteResult) => void;
  /** Called on 409 STALE_ALTERNATIVE so the page refetches slots. */
  onRefreshAlternatives?: () => void;
}

type RowState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "confirmed"; traceId: string | null }
  | { kind: "stale"; message: string }
  | { kind: "error"; message: string };

function mintKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const h = () =>
    Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .slice(1);
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
}

function windowOf(start: string, end: string): string {
  const from = start.length >= 16 ? start.slice(11, 16) : start;
  const to = end.length >= 16 ? end.slice(11, 16) : end;
  return `${from}–${to}`;
}

function dayOf(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

interface RerouteTarget {
  resource_id: string;
  start: string;
  end: string;
}

async function postReroute(
  requestId: string,
  alternative: RerouteTarget,
): Promise<{ status: number; body: Record<string, unknown>; traceId: string | null }> {
  const key = mintKey();
  const res = await fetch("/api/reroute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ requestId, alternative, idempotencyKey: key }),
  });
  const traceId = res.headers.get("x-trace-id");
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (typeof body.traceId === "string" && body.traceId.length > 0) {
    return { status: res.status, body, traceId: body.traceId };
  }
  return { status: res.status, body, traceId };
}

/**
 * Shared reroute mutation path — the drawer rows AND the drag-proposal row
 * call this. Exported so page-level confirmations reuse it without forking.
 */
export function useRerouteMutation(date: string) {
  const queryClient = useQueryClient();
  const [states, setStates] = React.useState<Record<string, RowState>>({});

  const run = React.useCallback(
    async (rowKey: string, requestId: string, alternative: RerouteTarget) => {
      setStates((s) => ({ ...s, [rowKey]: { kind: "pending" } }));
      let outcome: Awaited<ReturnType<typeof postReroute>>;
      try {
        outcome = await postReroute(requestId, alternative);
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? `Reroute failed (${err.message}) — check the connection and retry.`
            : "Reroute failed — check the connection and retry.";
        setStates((s) => ({ ...s, [rowKey]: { kind: "error", message } }));
        return { ok: false as const, traceId: null as string | null };
      }
      if (outcome.status === 200) {
        const traceId = outcome.traceId;
        setStates((s) => ({ ...s, [rowKey]: { kind: "confirmed", traceId } }));
        /* Radar goes green through the same cache the scope reads. */
        await queryClient.invalidateQueries({ queryKey: slotKeys.byDate(date) });
        invalidateLotMetrics(queryClient, date);
        return { ok: true as const, traceId };
      }
      const code =
        typeof outcome.body.code === "string" ? outcome.body.code : "";
      if (outcome.status === 409 && code === "STALE_ALTERNATIVE") {
        setStates((s) => ({
          ...s,
          [rowKey]: {
            kind: "stale",
            message:
              "Stale — refreshed alternatives. That window was taken between check and hold; pick a fresh row.",
          },
        }));
        await queryClient.invalidateQueries({ queryKey: slotKeys.byDate(date) });
        return { ok: false as const, traceId: null as string | null, stale: true as const };
      }
      const message =
        typeof outcome.body.message === "string" && outcome.body.message.length > 0
          ? `${outcome.body.message} — adjust the window and retry.`
          : `Reroute failed (HTTP ${outcome.status}) — adjust the window and retry.`;
      setStates((s) => ({ ...s, [rowKey]: { kind: "error", message } }));
      return { ok: false as const, traceId: null as string | null };
    },
    [date, queryClient],
  );

  const reset = React.useCallback(() => setStates({}), []);

  return { states, run, reset };
}

function TraceLine({ traceId }: { traceId: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(traceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard unavailable (permissions) — the mono id stays selectable. */
    }
  };
  return (
    <span className="tower-data inline-flex items-center gap-1.5 text-[11px] text-slate-400">
      TRACE <span className="text-slate-200">{traceId}</span>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy trace ${traceId}`}
        className="tower-focus rounded-[2px] border border-slate-700 p-1 text-slate-300 transition-colors duration-150 ease-out hover:border-cyan-400 hover:text-cyan-300"
      >
        {copied ? <Check aria-hidden="true" className="size-3" /> : <Copy aria-hidden="true" className="size-3" />}
      </button>
      {copied ? <span className="text-emerald-200">Copied</span> : null}
    </span>
  );
}

export function ConflictDrawer({
  date,
  requestId,
  conflicts,
  alternatives,
  selectedSlot,
  proposedMove,
  traceId,
  open,
  onClose,
  onRerouted,
  onRefreshAlternatives,
}: ConflictDrawerProps) {
  const { states, run, reset } = useRerouteMutation(date);
  const sheetRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const invokerRef = React.useRef<Element | null>(null);

  /* Reset per-request mutation states when a new conflict arrives. */
  const requestKey = requestId ?? "none";
  const prevKey = React.useRef(requestKey);
  React.useEffect(() => {
    if (prevKey.current !== requestKey) {
      prevKey.current = requestKey;
      reset();
    }
  }, [requestKey, reset]);

  /* Focus: remember the invoker, move into the sheet, trap Tab, Esc closes. */
  React.useEffect(() => {
    if (!open) return;
    invokerRef.current = document.activeElement;
    const frame = requestAnimationFrame(() => {
      closeRef.current?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !sheetRef.current) return;
      const nodes = Array.from(
        sheetRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (nodes.length === 0) return;
      const first = nodes[0] as HTMLElement;
      const last = nodes[nodes.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey, true);
      const invoker = invokerRef.current;
      if (invoker instanceof HTMLElement) invoker.focus();
    };
  }, [open, onClose]);

  const primary = conflicts[0] ?? null;
  const headerCopy = primary
    ? `${primary.resource_id} conflict ${primary.overlap} — blocked by ${primary.blockedBy}`
    : "Schedule conflict — Tower found overlapping holds";

  const confirmedEntries = Object.entries(states).filter(
    ([, s]) => s.kind === "confirmed",
  );
  const firstConfirmation =
    confirmedEntries.length > 0
      ? (confirmedEntries[0]?.[1] as { kind: "confirmed"; traceId: string | null })
      : null;

  const fire = (rowKey: string, alternative: RerouteTarget) => {
    if (requestId === null) return;
    void run(rowKey, requestId, alternative).then((res) => {
      if (res.ok) onRerouted?.({ traceId: res.traceId });
      else if ("stale" in res && res.stale) onRefreshAlternatives?.();
    });
  };

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {open ? (
          <div className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4">
            <motion.div
              ref={sheetRef}
              role="dialog"
              aria-modal="false"
              aria-labelledby="tower-drawer-title"
              aria-describedby="tower-drawer-desc"
              data-testid="conflict-drawer"
              initial={{ y: "100%", opacity: 0.6 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "100%", opacity: 0.6 }}
              transition={{ type: "spring", stiffness: 380, damping: 38 }}
              className="w-full max-w-6xl border border-slate-700 bg-slate-950 shadow-[0_-16px_48px_rgb(0_0_0/0.6)]"
            >
              {/* Rose conflict rail — the top edge IS the alert. */}
              <div aria-hidden="true" className="h-[2px] w-full bg-rose-500" />
              <div className="flex flex-wrap items-start gap-3 border-b border-slate-800 px-4 py-3">
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-rose-400" />
                <div className="min-w-0 flex-1">
                  <h2
                    id="tower-drawer-title"
                    className="text-[15px] font-bold tracking-tight text-slate-100"
                  >
                    {headerCopy}
                  </h2>
                  <p id="tower-drawer-desc" className="tower-secondary mt-0.5 text-[13px]">
                    {selectedSlot !== null ? (
                      <>
                        Holding{" "}
                        <span className="tower-data text-slate-300">
                          {selectedSlot.resourceId} · {selectedSlot.slotId}
                        </span>{" "}
                        — pick the next-best move and Tower holds it atomically.
                      </>
                    ) : (
                      <>Pick the next-best move and Tower holds it atomically.</>
                    )}{" "}
                    {traceId ? (
                      <>
                        <TraceLine traceId={traceId} />
                      </>
                    ) : null}
                  </p>
                </div>
                <Button
                  ref={closeRef}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                  aria-label="Dismiss conflict drawer"
                >
                  <X aria-hidden="true" /> Dismiss
                </Button>
              </div>

              {/* Emerald confirmation — the ONLY live region in the drawer. */}
              {firstConfirmation ? (
                <p
                  role="status"
                  data-testid="reroute-confirmation"
                  className="flex flex-wrap items-center gap-2 border-b border-emerald-400/40 bg-emerald-400/10 px-4 py-2.5 text-[13px] font-semibold text-emerald-200"
                >
                  <Check aria-hidden="true" className="size-4 shrink-0" />
                  Rerouted &amp; held — radar is green.
                  {firstConfirmation.traceId ? (
                    <span data-testid="reroute-trace" className="tower-data text-[12px] font-normal">
                      TRACE {firstConfirmation.traceId}
                    </span>
                  ) : null}
                  <a
                    href="/requests"
                    className="tower-focus tower-data text-[12px] font-normal text-cyan-300 underline"
                  >
                    View in history →
                  </a>
                </p>
              ) : null}

              {/* Drag proposal lead row — same mutation path, no fork. */}
              {proposedMove ? (
                <AlternativeRow
                  index={-1}
                  eyebrow="Drag proposal"
                  resourceId={proposedMove.toResourceId}
                  start={proposedMove.toStart}
                  end={proposedMove.toEnd}
                  reason="Pre-validated drop from the scope"
                  score={null}
                  state={states["proposal"] ?? { kind: "idle" }}
                  busy={false}
                  requestReady={requestId !== null}
                  onFire={() =>
                    fire("proposal", {
                      resource_id: proposedMove.toResourceId,
                      start: proposedMove.toStart,
                      end: proposedMove.toEnd,
                    })
                  }
                />
              ) : null}

              {/* Ranked alternatives — API order preserved, never re-sorted. */}
              <ol aria-label="Ranked alternatives" className="divide-y divide-slate-800/80">
                {alternatives.map((alt, i) => {
                  const rowKey = `alt:${alt.resource_id}:${alt.start}:${i}`;
                  const state = states[rowKey] ?? { kind: "idle" };
                  const busy = Object.values(states).some((s) => s.kind === "pending");
                  return (
                    <AlternativeRow
                      key={rowKey}
                      index={i}
                      eyebrow={i === 0 ? "Best move" : `Option ${i + 1}`}
                      resourceId={alt.resource_id}
                      start={alt.start}
                      end={alt.end}
                      reason={alt.reason}
                      score={alt.score}
                      state={state}
                      busy={busy}
                      requestReady={requestId !== null}
                      onFire={() =>
                        fire(rowKey, {
                          resource_id: alt.resource_id,
                          start: alt.start,
                          end: alt.end,
                        })
                      }
                    />
                  );
                })}
              </ol>
              {alternatives.length === 0 && !proposedMove ? (
                <p className="tower-secondary px-4 py-3 text-[13px]">
                  No alternatives ranked for this window — restate the request
                  with a wider window and transmit again.
                </p>
              ) : null}

              <p className="tower-data border-t border-slate-800/80 px-4 py-2 text-[11px] text-slate-500">
                ESC DISMISSES · EACH HOLD USES A FRESH SINGLE-USE KEY · STALE ROWS REFRESH ON 409
              </p>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </MotionConfig>
  );
}

function AlternativeRow({
  index,
  eyebrow,
  resourceId,
  start,
  end,
  reason,
  score,
  state,
  busy,
  requestReady,
  onFire,
}: {
  index: number;
  eyebrow: string;
  resourceId: string;
  start: string;
  end: string;
  reason?: string | null;
  score: number | null;
  state: RowState;
  busy: boolean;
  requestReady: boolean;
  onFire: () => void;
}) {
  const pending = state.kind === "pending";
  return (
    <motion.li
      data-testid="alternative-row"
      data-resource={resourceId}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: "easeOut", delay: Math.min(Math.max(index + 1, 0) * 0.04, 0.2) }}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant={index <= 0 ? "confirmed" : "neutral"}>{eyebrow}</Badge>
          <span className="text-[14px] font-semibold text-slate-100">{resourceId}</span>
          <span className="tower-data text-[12px] text-slate-300">
            {windowOf(start, end)} <span className="text-slate-500">· {dayOf(start)}</span>
          </span>
          {typeof score === "number" ? (
            <span className="tower-data text-[11px] text-slate-400">
              SCORE {score.toFixed(2)}
            </span>
          ) : null}
        </p>
        {reason ? (
          <p className="tower-secondary mt-0.5 text-[13px]">{reason}</p>
        ) : null}
        {state.kind === "stale" ? (
          <p role="alert" data-testid="stale-alternative" className="mt-1 text-[13px] font-medium text-amber-200">
            {state.message}
          </p>
        ) : null}
        {state.kind === "error" ? (
          <p role="alert" className="mt-1 text-[13px] font-medium text-rose-300">
            {state.message}
          </p>
        ) : null}
        {state.kind === "confirmed" ? (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] font-semibold text-emerald-200">
            <Check aria-hidden="true" className="size-4" /> Held
            {state.traceId ? (
              <span className="tower-data text-[11px] font-normal text-slate-300">
                TRACE {state.traceId}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="confirm"
        size="sm"
        disabled={pending || busy || !requestReady}
        onClick={onFire}
        aria-label={`Reroute and hold ${resourceId} ${windowOf(start, end)}`}
        className={cn(pending && "opacity-60")}
      >
        {pending ? "Holding…" : (
          <>
            Reroute &amp; Hold <ArrowRight aria-hidden="true" />
          </>
        )}
      </Button>
    </motion.li>
  );
}

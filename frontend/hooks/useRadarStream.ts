"use client";

/**
 * useRadarStream (T-08) — SSE realtime for the radar scope (E18).
 *
 * EventSource to `GET /api/stream` (framing contract in
 * `app/api/stream/route.ts`: `event: <name>` + `data: <json>` frames,
 * `:heartbeat` comments). On `slot:confirmed` / `collision`, invalidates
 * the TanStack key `['slots', date]` (`slotKeys.byDate(date)`), so the
 * radar + gantt refetch through the same cache the pages read.
 *
 * Resilience (PRD §6.5 E18): exponential-backoff reconnect
 * (1s → 2s → 4s … capped at 30s); if still down 5s after the drop, fall
 * back to polling `['slots', date]` every 5s and report `polling`.
 * Exposes `{ status: 'live' | 'reconnecting' | 'polling', lastEventAt }`
 * — the single live-status source T-09's health strip reads.
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { slotKeys } from "../lib/query-client";

export type RadarStreamStatus = "live" | "reconnecting" | "polling";

export interface RadarStreamState {
  status: RadarStreamStatus;
  /** Epoch ms of the last applied `slot:confirmed` / `collision` event. */
  lastEventAt: number | null;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/** E18: down longer than this → 5s poll fallback. */
const POLL_FALLBACK_AFTER_MS = 5000;
const POLL_INTERVAL_MS = 5000;

export function useRadarStream(date: string): RadarStreamState {
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<RadarStreamStatus>("reconnecting");
  const [lastEventAt, setLastEventAt] = React.useState<number | null>(null);

  const attemptRef = React.useRef(0);
  const sourceRef = React.useRef<EventSource | null>(null);
  const reconnectTimerRef = React.useRef<number | null>(null);
  const downTimerRef = React.useRef<number | null>(null);
  const pollTimerRef = React.useRef<number | null>(null);
  const disposedRef = React.useRef(false);

  React.useEffect(() => {
    disposedRef.current = false;

    const clearReconnect = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
    const clearDownTimer = () => {
      if (downTimerRef.current !== null) {
        window.clearTimeout(downTimerRef.current);
        downTimerRef.current = null;
      }
    };
    const stopPoll = () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
    /** E18 poll fallback: refetch the day key every 5s while down. */
    const startPoll = () => {
      if (disposedRef.current || pollTimerRef.current !== null) return;
      setStatus("polling");
      pollTimerRef.current = window.setInterval(() => {
        void queryClient.invalidateQueries({ queryKey: slotKeys.byDate(date) });
      }, POLL_INTERVAL_MS);
    };
    const invalidate = () => {
      setLastEventAt(Date.now());
      void queryClient.invalidateQueries({ queryKey: slotKeys.byDate(date) });
    };

    /* jsdom / SSR without EventSource: poll, never pretend to be live. */
    if (typeof EventSource === "undefined") {
      startPoll();
      return () => {
        disposedRef.current = true;
        stopPoll();
      };
    }

    const connect = () => {
      if (disposedRef.current) return;
      /* A reconnect attempt must NOT disarm the 5s poll fallback — only a
         successful open proves the stream is alive again (E18). */
      clearReconnect();
      const es = new EventSource("/api/stream");
      sourceRef.current = es;
      es.addEventListener("slot:confirmed", invalidate);
      es.addEventListener("collision", invalidate);
      es.onopen = () => {
        if (disposedRef.current) return;
        attemptRef.current = 0;
        clearReconnect();
        clearDownTimer();
        stopPoll();
        setStatus("live");
      };
      es.onerror = () => {
        es.close();
        if (sourceRef.current === es) sourceRef.current = null;
        if (disposedRef.current) return;
        setStatus("reconnecting");
        /* Still down after 5s → poll fallback (E18). */
        if (downTimerRef.current === null) {
          downTimerRef.current = window.setTimeout(startPoll, POLL_FALLBACK_AFTER_MS);
        }
        const backoff = Math.min(
          RECONNECT_BASE_MS * 2 ** attemptRef.current,
          RECONNECT_MAX_MS,
        );
        attemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(connect, backoff);
      };
    };

    connect();
    return () => {
      disposedRef.current = true;
      clearReconnect();
      clearDownTimer();
      stopPoll();
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [date, queryClient]);

  return { status, lastEventAt };
}

"use client";

/**
 * useParse (T-07) — the input half of the 60s demo.
 *
 * POSTs NL text to the BFF client target `POST /api/requests` (route.ts):
 * fresh `crypto.randomUUID()` per submit, mirrored as BOTH the
 * `Idempotency-Key` header AND the body `idempotencyKey` (the route 422s
 * when they differ). Rapid submits within 300ms are dropped (debounce).
 *
 * Client-side guards (no API call, shake + message naming problem + recovery):
 * - empty / whitespace → error
 * - >500 chars → error (server cap is 2000, but the ops console keeps
 *   requests short; E02 clarification boundary is 500)
 *
 * Response mapping (contracts/api.yaml §7.4 + T-04 agent extensions):
 * - 200 + `unknown_resource` extension → `unknown` (ghost chip + suggestions)
 * - 200 + `needs_clarification` embedded → `clarify` (`?` chip + Did-you-mean)
 * - 200 + collision.hasConflict → `conflict` (rose) else `confirmed` (emerald)
 * - 422 NEEDS_CLARIFICATION → `clarify`
 * - 409 IDEMPOTENT_REPLAY → `confirmed` with `notice` (prior result replayed)
 * - anything else / network failure → `error` (red, problem + recovery)
 */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export type ParseStatus =
  | "idle"
  | "parsing"
  | "confirmed"
  | "conflict"
  | "clarify"
  | "unknown"
  | "error";

export interface ParsedChip {
  resource_type: "stage" | "gear" | "crew";
  resource_id: string;
  start: string;
  end: string;
}

export interface Clarification {
  field: string;
  message: string;
}

export interface UnknownResource {
  /** Raw unknown name the parser heard, e.g. "Alexa 1000". */
  name: string;
  suggestions: string[];
}

export interface ConflictInfo {
  resource_id: string;
  overlap: string;
  blockedBy: string;
}

export interface AlternativeInfo {
  resource_id: string;
  start: string;
  end: string;
  score: number;
  reason?: string;
}

export interface UseParseOptions {
  /** Debounce window for rapid submits. @default 300 */
  debounceMs?: number;
}

export interface UseParseReturn {
  status: ParseStatus;
  chips: ParsedChip[];
  requestId: string | null;
  traceId: string | null;
  confidence: number | null;
  hasConflict: boolean;
  conflicts: ConflictInfo[];
  alternatives: AlternativeInfo[];
  clarification: Clarification | null;
  unknownResource: UnknownResource | null;
  /** Non-field message (guards, transport errors). Names problem + recovery. */
  error: string | null;
  /** Soft notice (e.g. idempotent replay) — not an error. */
  notice: string | null;
  /** Increments each guard-reject so the bar can retrigger its shake. */
  shakeKey: number;
  /**
   * Submit NL text. Mints a fresh idempotency key unless `key` is provided
   * (lets RequestBar own key creation per its `onSubmit(text, key)` contract).
   */
  submit: (text: string, key?: string) => Promise<void>;
  reset: () => void;
}

export const PARSE_DEBOUNCE_MS = 300;
export const PARSE_CHAR_LIMIT = 500;

interface SuccessBody {
  requestId?: string;
  traceId?: string;
  parsed?: { slots?: ParsedChip[]; confidence?: number };
  collision?: {
    hasConflict?: boolean;
    conflicts?: ConflictInfo[];
    alternatives?: Array<{
      slot?: { resource_id?: string; start?: string; end?: string };
      score?: number;
      reason?: string;
    }>;
  };
  needs_clarification?: { field?: string; message?: string };
  unknown_resource?: { name?: string; suggestions?: string[] };
}

interface ErrorBody {
  code?: string;
  field?: string;
  message?: string;
  requestId?: string;
}

function mintKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  /* Test/legacy fallback: uuidv4-shaped random hex (route requires uuid). */
  const h = () =>
    Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .slice(1);
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
}

async function postRequest(
  text: string,
  idempotencyKey: string,
): Promise<{ status: number; body: SuccessBody & ErrorBody }> {
  const res = await fetch("/api/requests", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      text,
      idempotencyKey,
      now: new Date().toISOString(),
    }),
  });
  let body: SuccessBody & ErrorBody = {};
  try {
    body = (await res.json()) as SuccessBody & ErrorBody;
  } catch {
    body = {};
  }
  const traceId = res.headers.get("x-trace-id");
  if (traceId && !body.traceId) body.traceId = traceId;
  return { status: res.status, body };
}

export function useParse(options: UseParseOptions = {}): UseParseReturn {
  const debounceMs = options.debounceMs ?? PARSE_DEBOUNCE_MS;
  const queryClient = useQueryClient();
  const lastSubmitAt = React.useRef(0);
  const [status, setStatus] = React.useState<ParseStatus>("idle");
  const [chips, setChips] = React.useState<ParsedChip[]>([]);
  const [requestId, setRequestId] = React.useState<string | null>(null);
  const [traceId, setTraceId] = React.useState<string | null>(null);
  const [confidence, setConfidence] = React.useState<number | null>(null);
  const [hasConflict, setHasConflict] = React.useState(false);
  const [conflicts, setConflicts] = React.useState<ConflictInfo[]>([]);
  const [alternatives, setAlternatives] = React.useState<AlternativeInfo[]>([]);
  const [clarification, setClarification] =
    React.useState<Clarification | null>(null);
  const [unknownResource, setUnknownResource] =
    React.useState<UnknownResource | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [shakeKey, setShakeKey] = React.useState(0);

  const mutation = useMutation({
    mutationKey: ["parse-request"],
    mutationFn: ({ text, key }: { text: string; key: string }) =>
      postRequest(text, key),
    onMutate: () => {
      setStatus("parsing");
      setError(null);
      setNotice(null);
      setClarification(null);
      setUnknownResource(null);
    },
    onSuccess: ({ status: http, body }) => {
      if (http === 200) {
        if (body.traceId) setTraceId(body.traceId);
        /* Agent extension first: unknown resource → ghost chip. */
        if (body.unknown_resource?.name) {
          setUnknownResource({
            name: body.unknown_resource.name,
            suggestions: body.unknown_resource.suggestions ?? [],
          });
          setChips([]);
          setStatus("unknown");
          if (body.requestId) setRequestId(body.requestId);
          return;
        }
        /* Embedded clarification (agent asked back inside a 200). */
        if (body.needs_clarification?.message) {
          setClarification({
            field: body.needs_clarification.field ?? "text",
            message: body.needs_clarification.message,
          });
          setChips([]);
          setStatus("clarify");
          if (body.requestId) setRequestId(body.requestId);
          return;
        }
        const slots = body.parsed?.slots ?? [];
        setChips(slots);
        setConfidence(body.parsed?.confidence ?? null);
        if (body.requestId) setRequestId(body.requestId);
        const conflicted = body.collision?.hasConflict === true;
        setHasConflict(conflicted);
        setConflicts(body.collision?.conflicts ?? []);
        setAlternatives(
          (body.collision?.alternatives ?? []).map((a) => ({
            resource_id: a.slot?.resource_id ?? "unknown",
            start: a.slot?.start ?? "",
            end: a.slot?.end ?? "",
            score: a.score ?? 0,
            reason: a.reason,
          })),
        );
        setStatus(conflicted ? "conflict" : "confirmed");
        /* Radar cache will exist in T-08 — invalidate opportunistically. */
        void queryClient.invalidateQueries({ queryKey: ["slots"] });
        return;
      }
      if (http === 409 && body.code === "IDEMPOTENT_REPLAY") {
        if (body.requestId) setRequestId(body.requestId);
        if (body.traceId) setTraceId(body.traceId);
        setNotice(
          `Duplicate submit ignored — replayed earlier result${body.requestId ? ` (${body.requestId})` : ""}. Type a new request to file again.`,
        );
        setStatus("confirmed");
        return;
      }
      if (http === 422 && body.code === "NEEDS_CLARIFICATION") {
        setClarification({
          field: body.field ?? "text",
          message: body.message ?? "Did you mean 2026-09-06?",
        });
        setChips([]);
        setStatus("clarify");
        if (body.traceId) setTraceId(body.traceId);
        return;
      }
      const problem =
        body.message ??
        (http === 422 && body.code === "IDEMPOTENCY_KEY_REUSE"
          ? "This submit key was already used with different text — retry with a fresh key."
          : http === 429
            ? "Tower is holding (rate limited) — wait a few seconds and retry."
            : `Request failed (HTTP ${http}) — check the text and retry.`);
      setError(problem);
      setStatus("error");
      if (body.traceId) setTraceId(body.traceId);
    },
    onError: (err) => {
      setError(
        err instanceof Error && err.message
          ? `Tower unreachable (${err.message}) — check connection and retry.`
          : "Tower unreachable — check connection and retry.",
      );
      setStatus("error");
    },
  });

  const submit = React.useCallback(
    async (text: string, key?: string): Promise<void> => {
      const trimmed = text.trim();
      /* Guard: empty — no API call, shake + problem/recovery message. */
      if (trimmed.length === 0) {
        setError(
          "Request is empty — describe the stage, gear, and crew you need.",
        );
        setStatus("error");
        setShakeKey((k) => k + 1);
        return;
      }
      /* Guard: >500 chars — no API call (E02 clarification boundary). */
      if (text.length > PARSE_CHAR_LIMIT) {
        setError(
          `Request is ${text.length} chars — keep it under ${PARSE_CHAR_LIMIT}; restate briefly and transmit again.`,
        );
        setStatus("error");
        setShakeKey((k) => k + 1);
        return;
      }
      /* Debounce: drop rapid re-submits inside the window. */
      const now = Date.now();
      if (now - lastSubmitAt.current < debounceMs) return;
      lastSubmitAt.current = now;
      try {
        await mutation.mutateAsync({ text: trimmed, key: key ?? mintKey() });
      } catch {
        /* onError already recorded problem + recovery in state — never throw. */
      }
    },
    [debounceMs, mutation],
  );

  const reset = React.useCallback(() => {
    setStatus("idle");
    setChips([]);
    setRequestId(null);
    setTraceId(null);
    setConfidence(null);
    setHasConflict(false);
    setConflicts([]);
    setAlternatives([]);
    setClarification(null);
    setUnknownResource(null);
    setError(null);
    setNotice(null);
  }, []);

  return {
    status,
    chips,
    requestId,
    traceId,
    confidence,
    hasConflict,
    conflicts,
    alternatives,
    clarification,
    unknownResource,
    error,
    notice,
    shakeKey,
    submit,
    reset,
  };
}

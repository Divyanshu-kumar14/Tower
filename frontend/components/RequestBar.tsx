"use client";

/**
 * RequestBar (T-07) — the input half of the 60s demo.
 *
 * Ops-console strip, NOT a hero: scope line on top, transmit line in the
 * middle, chip river at the bottom, one 2px status rail whose color is the
 * single authored moment (slate idle / cyan parsing / emerald confirmed /
 * rose conflict+error / amber clarify).
 *
 * - RHF + zodResolver on the text schema (empty + >500 guards: shake,
 *   problem+recovery message, NO onSubmit call, NO key minted).
 * - Fresh `crypto.randomUUID()` per valid submit → `onSubmit(text, key)`.
 * - URL `?date&stage` read client-side, Zod-validated (slotsQuerySchema
 *   shape for date), shown as scope context.
 * - `parse` prop renders chips / `?` clarification / ghost unknown chip /
 *   skeletons / errors; `role="status"` live region announces every result.
 * - Keyboard: Enter transmits (native form), Escape clears the line.
 */
import * as React from "react";
import { motion } from "framer-motion";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  AlertTriangle,
  Building2,
  Camera,
  CircleHelp,
  Ghost,
  Radio,
  User,
} from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Tooltip } from "./ui/tooltip";
import { cn } from "./ui/utils";
import { slotsQuerySchema } from "../lib/validator";
import type {
  Clarification,
  ConflictInfo,
  ParsedChip,
  ParseStatus,
  UnknownResource,
} from "../hooks/useParse";

/* ------------------------------------------------------------------ */
/* Schemas + types                                                     */
/* ------------------------------------------------------------------ */

/** Client text schema: E01 empty + E02 500-char clarification boundary. */
export const requestTextSchema = z.object({
  text: z
    .string()
    .min(1, { message: "Request is empty — describe the stage, gear, and crew you need." })
    .max(500, {
      message:
        "Request is over 500 chars — restate briefly and transmit again.",
    })
    .refine((s) => s.trim().length > 0, {
      message: "Request is empty — describe the stage, gear, and crew you need.",
    }),
});

export type RequestTextValues = z.infer<typeof requestTextSchema>;

/** URL `?date&stage` — date reuses the slotsQuerySchema shape, stage is free. */
export const requestBarUrlSchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" })
      .optional(),
    stage: z.string().min(1).max(32).optional(),
  });

export interface RequestBarScope {
  date?: string;
  stage?: string;
}

export interface RequestBarParseState {
  status: ParseStatus;
  chips: ParsedChip[];
  clarification: Clarification | null;
  unknownResource: UnknownResource | null;
  error: string | null;
  notice: string | null;
  hasConflict: boolean;
  conflicts: ConflictInfo[];
  traceId: string | null;
}

export interface RequestBarProps {
  /** Called with valid text + a fresh UUIDv4 idempotency key. */
  onSubmit: (text: string, idempotencyKey: string) => void | Promise<void>;
  /** True while the parse round-trip is in flight (skeleton shimmer). */
  isLoading?: boolean;
  /** Parse result state to render (owned by `useParse` in T-08). */
  parse?: RequestBarParseState | null;
  /** Bumps from `useParse().shakeKey` to retrigger the guard shake. */
  shakeKey?: number;
  /** Called when an unknown-resource suggestion is picked. */
  onSuggestionSelect?: (suggestion: string) => void;
  className?: string;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

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

function readScope(): RequestBarScope | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const date = params.get("date") ?? undefined;
  const stage = params.get("stage") ?? undefined;
  if (date === undefined && stage === undefined) return null;
  /* Validate date through the frozen slots shape; stage is display-only. */
  if (date !== undefined) {
    const checked = slotsQuerySchema.safeParse({ date });
    if (!checked.success) return stage ? { stage } : null;
  }
  const parsed = requestBarUrlSchema.safeParse({ date, stage });
  if (!parsed.success) return null;
  return { ...(parsed.data.date ? { date: parsed.data.date } : {}), ...(parsed.data.stage ? { stage: parsed.data.stage } : {}) };
}

function chipLabel(chip: ParsedChip): string {
  const day = chip.start.slice(0, 10);
  const from = chip.start.slice(11, 16);
  const to = chip.end.slice(11, 16);
  return `${chip.resource_id} · ${day} ${from}–${to}`;
}

function statusRail(status: ParseStatus, isLoading?: boolean): string {
  if (isLoading || status === "parsing") return "bg-cyan-400";
  switch (status) {
    case "confirmed":
      return "bg-emerald-400";
    case "conflict":
    case "error":
      return "bg-rose-500";
    case "clarify":
    case "unknown":
      return "bg-amber-400";
    default:
      return "bg-slate-700";
  }
}

function chipIcon(type: ParsedChip["resource_type"]) {
  if (type === "stage") return <Building2 aria-hidden="true" />;
  if (type === "gear") return <Camera aria-hidden="true" />;
  return <User aria-hidden="true" />;
}

/** Screen-reader announcement for the current parse state. */
export function announceFor(parse: RequestBarParseState | null | undefined): string {
  if (!parse || parse.status === "idle") return "";
  if (parse.status === "parsing") return "Parsing request…";
  if (parse.status === "confirmed") {
    const n = parse.chips.length;
    return `Request confirmed: ${n} slot${n === 1 ? "" : "s"}${parse.traceId ? `, trace ${parse.traceId}` : ""}.`;
  }
  if (parse.status === "conflict") {
    const where = parse.conflicts
      .map((c) => `${c.resource_id} ${c.overlap}, blocked by ${c.blockedBy}`)
      .join("; ");
    return `Conflict: ${where || "requested slot overlaps an existing hold"}. Alternatives listed in the conflict drawer.`;
  }
  if (parse.status === "clarify") {
    return `Needs clarification: ${parse.clarification?.message ?? "tell Tower which date you mean"}.`;
  }
  if (parse.status === "unknown") {
    const u = parse.unknownResource;
    return `Unknown resource ${u?.name ?? ""}. Suggestions: ${(u?.suggestions ?? []).join(", ") || "none"}.`;
  }
  return parse.error ?? "Request failed.";
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function RequestBar({
  onSubmit,
  isLoading = false,
  parse = null,
  shakeKey = 0,
  onSuggestionSelect,
  className,
}: RequestBarProps) {
  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors },
  } = useForm<RequestTextValues>({
    resolver: zodResolver(requestTextSchema),
    defaultValues: { text: "" },
  });

  const [scope, setScope] = React.useState<RequestBarScope | null>(null);
  const [shakeCount, setShakeCount] = React.useState(0);
  const lastShakeKey = React.useRef(shakeKey);

  React.useEffect(() => {
    setScope(readScope());
  }, []);

  /* External guard-rejects (useParse) retrigger the shake. */
  React.useEffect(() => {
    if (shakeKey !== lastShakeKey.current) {
      lastShakeKey.current = shakeKey;
      if (shakeKey > 0) setShakeCount((c) => c + 1);
    }
  }, [shakeKey]);

  const fieldError = errors.text?.message;
  const status: ParseStatus = parse?.status ?? "idle";
  const busy = isLoading || status === "parsing";
  const announcement = announceFor(parse);

  const submitValid = (values: RequestTextValues) => {
    void onSubmit(values.text.trim(), mintKey());
  };
  const submitInvalid = () => {
    /* RHF guard failed: shake + inline message, no key, no submit. */
    setShakeCount((c) => c + 1);
  };

  const clearLine = () => {
    setValue("text", "", { shouldValidate: false });
    setFocus("text");
  };

  const pickSuggestion = (s: string) => {
    if (onSuggestionSelect) {
      onSuggestionSelect(s);
      return;
    }
    setValue("text", s, { shouldValidate: true });
    setFocus("text");
  };

  const textRegister = register("text");

  return (
    <section
      aria-label="Operations request console"
      className={cn(
        "border border-slate-800 bg-slate-950",
        className,
      )}
    >
      {/* Status rail — the single authored moment. */}
      <div
        aria-hidden="true"
        className={cn(
          "h-[2px] w-full transition-colors duration-150 ease-out",
          statusRail(status, isLoading),
        )}
      />

      <div key={shakeCount} className={cn(shakeCount > 0 && "animate-tower-shake")}>
        {/* Scope line: URL ?date&stage context, mono data. */}
        <div className="flex items-center gap-2 border-b border-slate-800/80 px-4 py-2">
          <Radio aria-hidden="true" className="size-3.5 text-cyan-400" />
          <span className="tower-data text-[11px] tracking-wide text-slate-400">
            TX · OPERATIONS REQUEST
          </span>
          {scope && (scope.date || scope.stage) ? (
            <Badge variant="neutral" className="ml-auto">
              SCOPE&nbsp;{scope.date ?? "—"}{scope.stage ? ` · STAGE ${scope.stage}` : ""}
            </Badge>
          ) : (
            <span className="tower-data ml-auto text-[11px] text-slate-600">
              LOT MAIN
            </span>
          )}
        </div>

        {/* Transmit line. */}
        <form
          onSubmit={handleSubmit(submitValid, submitInvalid)}
          noValidate
          className="flex items-end gap-3 px-4 pb-3 pt-3"
        >
          <div className="min-w-0 flex-1">
            <label
              htmlFor="tower-request-text"
              className="mb-1 block text-[13px] font-medium text-slate-300"
            >
              Describe the shoot
              <span className="tower-secondary font-normal">
                {" "}— stage, window, gear, crew
              </span>
            </label>
            <Input
              id="tower-request-text"
              autoComplete="off"
              spellCheck={false}
              placeholder="Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm"
              aria-invalid={fieldError ? true : undefined}
              aria-describedby="tower-request-help tower-request-live"
              disabled={busy}
              maxLength={2000}
              {...textRegister}
              onKeyDown={(e) => {
                if (e.key === "Escape") clearLine();
              }}
            />
            <p id="tower-request-help" className="tower-secondary mt-1 text-xs">
              Enter transmits · Esc clears · keys are single-use UUIDs
            </p>
          </div>
          <Tooltip content="File this request with the lot (fresh idempotency key)">
            <Button type="submit" disabled={busy} aria-label="Transmit request">
              {busy ? "Parsing…" : "Transmit request"}
            </Button>
          </Tooltip>
        </form>

        {/* Inline field error: names problem + recovery. */}
        {fieldError ? (
          <p role="alert" className="flex items-center gap-2 px-4 pb-3 text-[13px] text-rose-300">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-rose-400" />
            {fieldError}
          </p>
        ) : null}

        {/* Chip river. */}
        <div className="border-t border-slate-800/80 px-4 py-3">
          {busy ? (
            <div className="flex flex-wrap gap-2" aria-hidden="true">
              <Skeleton className="h-7 w-44" />
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-7 w-36" />
            </div>
          ) : null}

          {!busy && parse && parse.chips.length > 0 ? (
            <motion.ul
              aria-label="Parsed request"
              className="flex flex-wrap gap-2"
              initial="hidden"
              animate="show"
              variants={{
                hidden: {},
                show: { transition: { staggerChildren: 0.05 } },
              }}
            >
              {parse.chips.map((chip, i) => (
                <motion.li
                  key={`${chip.resource_id}-${chip.start}-${i}`}
                  variants={{
                    hidden: { opacity: 0, y: 6 },
                    show: {
                      opacity: 1,
                      y: 0,
                      transition: { duration: 0.15, ease: "easeOut" },
                    },
                  }}
                >
                  <Badge
                    variant={status === "conflict" ? "conflict" : "confirmed"}
                    title={`${chip.resource_type} ${chip.resource_id} ${chip.start} → ${chip.end}`}
                  >
                    {chipIcon(chip.resource_type)}
                    {chipLabel(chip)}
                  </Badge>
                </motion.li>
              ))}
            </motion.ul>
          ) : null}

          {/* Clarification: `?` chip + Did-you-mean. */}
          {!busy && status === "clarify" && parse?.clarification ? (
            <div className="border border-amber-400/40 bg-amber-400/10 px-3 py-2">
              <p className="flex flex-wrap items-center gap-2 text-[13px] text-amber-200">
                <Badge variant="holding">
                  <CircleHelp aria-hidden="true" />?
                </Badge>
                <span className="font-semibold">Did you mean …?</span>
                <span className="tower-data text-xs">{parse.clarification.message}</span>
              </p>
              <p className="tower-secondary mt-1 text-xs">
                Field: <span className="tower-data">{parse.clarification.field}</span>
                {" "}— restate the date and transmit again.
              </p>
            </div>
          ) : null}

          {/* Unknown resource: ghost chip + suggestions. */}
          {!busy && status === "unknown" && parse?.unknownResource ? (
            <div>
              <p className="flex flex-wrap items-center gap-2 text-[13px]">
                <Badge variant="ghost">
                  <Ghost aria-hidden="true" />
                  {parse.unknownResource.name} — not on the lot
                </Badge>
              </p>
              {parse.unknownResource.suggestions.length > 0 ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="tower-secondary text-xs">Did you mean:</span>
                  {parse.unknownResource.suggestions.map((s) => (
                    <Button
                      key={s}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => pickSuggestion(s)}
                    >
                      {s}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Transport / guard error from useParse: problem + recovery. */}
          {!busy && status === "error" && parse?.error ? (
            <p role="alert" className="flex items-center gap-2 text-[13px] text-rose-300">
              <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-rose-400" />
              {parse.error}
            </p>
          ) : null}

          {/* Soft notice (idempotent replay). */}
          {!busy && parse?.notice ? (
            <p className="tower-data text-xs text-cyan-300">{parse.notice}</p>
          ) : null}

          {/* Trace lineage for T-09 handoff. */}
          {!busy && parse?.traceId ? (
            <p className="tower-data mt-2 text-[11px] text-slate-500">
              TRACE&nbsp;
              <Tooltip content="Follow this trace in Tempo from the conflict drawer (T-09)">
                <span className="text-slate-400">{parse.traceId}</span>
              </Tooltip>
            </p>
          ) : null}

          {/* Empty state — never blank (PRD §6.5). */}
          {!busy && !parse ? (
            <p className="tower-secondary text-[13px]">
              No ops on the wire — file a request and Tower answers with confirmed slots or the next-best move.
            </p>
          ) : null}
        </div>
      </div>

      {/* ARIA live region: every parse outcome is announced. */}
      <p
        id="tower-request-live"
        role="status"
        aria-live="polite"
        className="sr-only"
      >
        {announcement}
      </p>
    </section>
  );
}

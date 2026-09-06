"use client";

import * as React from "react";
import { cn } from "./utils";

/**
 * TOWER Tooltip — lightweight shadcn-style primitive (no Radix dep).
 * Shows on hover AND keyboard focus (`focus-within`), `role="tooltip"`
 * wired via `aria-describedby`. Sharp 2px geometry, solid slate-800 fill
 * with cyan-400 caret tick — no blur, no glass.
 */

interface TooltipProps {
  /** Tooltip body. Keep under ~120 chars. */
  content: React.ReactNode;
  /** Trigger element (must accept className-less wrapper). */
  children: React.ReactNode;
  /** Side of the trigger. @default "top" */
  side?: "top" | "bottom";
  className?: string;
}

let tooltipId = 0;

function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const id = React.useId() ?? `tower-tip-${(tooltipId += 1)}`;
  return (
    <span
      className="group/tooltip relative inline-flex items-center"
      aria-describedby={id}
    >
      {children}
      <span
        role="tooltip"
        id={id}
        className={cn(
          "tower-data pointer-events-none absolute left-1/2 z-50 w-max max-w-[240px] -translate-x-1/2 rounded-[2px] border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-normal text-slate-200 opacity-0 shadow-[0_8px_24px_rgb(0_0_0/0.55)] transition-opacity duration-150 ease-out group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100",
          side === "top" ? "bottom-full mb-2" : "top-full mt-2",
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}

export { Tooltip };

import * as React from "react";
import { cn } from "./utils";

/**
 * TOWER Skeleton — parsing shimmer (shadcn-style, hand-placed).
 * Solid slate-800 track + one translucent sweep (150ms→1.4s shimmer loop);
 * never a spinner. `aria-hidden` by default — the live region announces
 * "Parsing request" instead. Honors prefers-reduced-motion via globals.css.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative overflow-hidden rounded-[2px] bg-slate-800",
        className,
      )}
      {...props}
    >
      <div className="animate-tower-shimmer absolute inset-0 -translate-x-full bg-slate-700/60" />
    </div>
  );
}

export { Skeleton };

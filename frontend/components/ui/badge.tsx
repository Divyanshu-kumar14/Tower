import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

/**
 * TOWER Badge — parsed-chip primitive (shadcn-style, hand-placed).
 * Pills are for small controls: chips are rounded-full, data set in
 * JetBrains Mono via `.tower-data`. Tinted 400/500 fills for state,
 * light 200/300 text keeps ≥4.5:1 on slate-950.
 */
const badgeVariants = cva(
  "tower-data inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors duration-150 ease-out [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /* Confirmed slot: emerald-400 wash, emerald-200 text. */
        confirmed:
          "border-emerald-400/40 bg-emerald-400/15 text-emerald-200",
        /* Holding / needs-clarification: amber-400 wash, amber-200 text. */
        holding: "border-amber-400/40 bg-amber-400/15 text-amber-200",
        /* Conflict: rose-500 wash, rose-200 text. */
        conflict: "border-rose-500/50 bg-rose-500/15 text-rose-200",
        /* ATC accent: cyan-400 wash, cyan-200 text. */
        accent: "border-cyan-400/40 bg-cyan-400/10 text-cyan-200",
        /* Unknown resource ghost chip: dashed slate, low-fill. */
        ghost:
          "border-dashed border-slate-600 bg-transparent text-slate-400",
        /* Neutral scope/meta chip. */
        neutral: "border-slate-700 bg-slate-800/60 text-slate-300",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };

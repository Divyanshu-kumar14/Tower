import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

/**
 * TOWER Button (shadcn-style, hand-placed — no CLI).
 * Sharp 2px geometry for the ATC console world; solid fills only,
 * cyan-400 primary accent, 150ms ease-out state changes, cyan focus ring.
 */
const buttonVariants = cva(
  "tower-focus inline-flex items-center justify-center gap-2 rounded-[2px] text-sm font-semibold transition-colors duration-150 ease-out disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /* Primary action: cyan accent, ink text (~9:1). */
        default: "bg-cyan-400 text-slate-950 hover:bg-cyan-300 active:bg-cyan-500",
        /* Confirm/hold: emerald solid. */
        confirm:
          "bg-emerald-400 text-slate-950 hover:bg-emerald-300 active:bg-emerald-500",
        /* Danger: rose solid, white text would fail contrast — ink text. */
        destructive:
          "bg-rose-500 text-slate-950 hover:bg-rose-400 active:bg-rose-600",
        outline:
          "border border-slate-700 bg-transparent text-slate-100 hover:border-cyan-400 hover:text-cyan-300",
        secondary:
          "bg-slate-800 text-slate-100 hover:bg-slate-700 active:bg-slate-600",
        ghost: "text-slate-300 hover:bg-slate-800 hover:text-slate-100",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        default: "h-10 px-4",
        lg: "h-12 px-6 text-base",
        icon: "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };

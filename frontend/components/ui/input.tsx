import * as React from "react";
import { cn } from "./utils";

/**
 * TOWER Input (shadcn-style, hand-placed — no CLI).
 * Console-line input: transparent on ink, 1px slate-700 underline,
 * cyan-400 focus line, slate-400 placeholder (≥4.5:1), mono OFF here
 * (Inter for UI — mono is data-only). `aria-invalid` turns the line rose.
 */
export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "tower-input tower-focus h-12 w-full border-b border-slate-700 bg-transparent text-[15px] text-slate-100 transition-colors duration-150 ease-out hover:border-slate-600 focus:border-cyan-400 aria-[invalid=true]:border-rose-500",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };

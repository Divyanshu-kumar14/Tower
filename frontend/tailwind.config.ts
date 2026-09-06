import type { Config } from "tailwindcss";

/**
 * TOWER design system (T-07) — dark ATC radar console.
 *
 * Binding tokens (PRD §6.4): slate-950 ink ground, slate-800 grid lines,
 * emerald-400 confirmed / amber-400 holding-clarify / rose-500 conflict,
 * cyan-400 ATC accent ONLY. No purple, no gradients, no glass.
 *
 * Motion tokens: 150ms ease-out for blip/chip state changes, 300ms spring
 * for drawer-class motion, skeleton shimmer for parsing (never a spinner).
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: [
          "var(--font-jetbrains-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      keyframes: {
        /* Parsing shimmer: translucent sweep across a skeleton track. */
        "tower-shimmer": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        /* Guard-reject shake: short lateral shake, no bounce. */
        "tower-shake": {
          "0%, 100%": { transform: "translateX(0)" },
          "25%": { transform: "translateX(-6px)" },
          "50%": { transform: "translateX(5px)" },
          "75%": { transform: "translateX(-3px)" },
        },
        /* Conflict blip pulse: opacity only (GPU-cheap), 150ms feel. */
        "tower-blip": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
      },
      animation: {
        "tower-shimmer": "tower-shimmer 1.4s ease-in-out infinite",
        "tower-shake": "tower-shake 300ms ease-out",
        "tower-blip": "tower-blip 1.6s ease-in-out infinite",
      },
      transitionDuration: {
        150: "150ms",
        300: "300ms",
      },
    },
  },
  plugins: [],
};

export default config;

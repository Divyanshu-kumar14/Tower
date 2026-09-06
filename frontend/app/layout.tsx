import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { TowerQueryProvider } from "../lib/query-client";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "TOWER — Studio Lot ATC",
  description:
    "You never lose a $50k shoot day — every request auto-deconflicted on a live radar.",
};

export const viewport: Viewport = {
  themeColor: "#020617",
};

/**
 * Pinned direction contract (brief-bound, ≤150 words). Rendered as an HTML
 * comment as the first child of <body> so the ops console always ships
 * with its orders attached.
 */
const DIRECTION_CONTRACT =
  "TOWER DIRECTION CONTRACT — THESIS: You never lose a $50k shoot day; every plain-English request deconflicts on a live radar. " +
  "OWN-WORLD: Dark ATC ops console — slate-950 ink, slate-800 grid, emerald confirmed, amber holding-clarify, rose conflict, cyan accent only. " +
  "STORY: Producer transmits → Tower parses → collision → reroute → green in 60 seconds. " +
  "FIRST VIEWPORT: Transmit console on top, radar scope beneath, no hero, no metric cards. " +
  "FORM: Sharp 2px edges, Inter UI, JetBrains Mono data only, 150ms blips, 300ms drawer spring, skeleton parsing. " +
  "FINISH: No purple, no gradients, no glass — every state announces itself.";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans`}>
        <div
          aria-hidden="true"
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `<!-- ${DIRECTION_CONTRACT} -->`,
          }}
        />
        <TowerQueryProvider>{children}</TowerQueryProvider>
      </body>
    </html>
  );
}

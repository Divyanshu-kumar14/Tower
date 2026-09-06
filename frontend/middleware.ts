/**
 * Preview/dev actor middleware (NOT a security boundary).
 *
 * Active ONLY when BOTH hold:
 *   1. `NODE_ENV !== "production"` (never runs on a production build), AND
 *   2. `TOWER_DEMO_PRODUCTION` is set (e.g. `TOWER_DEMO_PRODUCTION="Neon Reels"`).
 *
 * Then it stamps `x-tower-production` on API-bound requests that lack it,
 * so the radar can be clicked through locally before Google OAuth lands
 * (T-11 wires real login; production always requires verified auth).
 */
import { NextResponse } from "next/server";

const DEMO_PRODUCTION = process.env.TOWER_DEMO_PRODUCTION?.trim() ?? "";

export function middleware(req: Request): Response | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  if (DEMO_PRODUCTION.length === 0) return undefined;
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/")) return undefined;
  if (req.headers.get("x-tower-production")) return undefined;
  const headers = new Headers(req.headers);
  headers.set("x-tower-production", DEMO_PRODUCTION);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/api/:path*"] };

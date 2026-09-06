/**
 * SSE frame builder (T-05 framing contract, shared).
 *
 * Lives in `lib/` — NOT in a route module — so Next's typed-routes
 * generation (`.next/types`, pulled into `tsconfig.json` by `next dev`)
 * never type-checks a non-handler export. Route handlers and the T-11
 * event-bus writer import from here.
 *
 * Framing contract (frozen): `event: <name>` + `data: <json>` frames,
 * `:heartbeat` comment lines to keep intermediaries from buffering.
 */

/** Build one SSE frame: `event: <name>\ndata: <json>\n\n`. */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

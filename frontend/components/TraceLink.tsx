/**
 * TraceLink (T-09) — mono trace id + copy-to-clipboard.
 *
 * Lives in `components/` — NOT in a page module — because Next.js pages
 * may only export the default page component (plus metadata helpers);
 * any other export fails `next build` page-type validation.
 *
 * Tempo deep-link shape (T-11 wires `NEXT_PUBLIC_GRAFANA_URL`):
 *   {GRAFANA_URL}/explore?orgId=1&left={"datasource":{"type":"tempo"},"queries":[{"queryType":"traceql","query":"trace_id=\"<traceId>\""}]}
 * Until T-11 sets the env var, the link renders as copy-only with the shape
 * documented in the `title` tooltip — never a dead link.
 */
import * as React from "react";
import { Check, Copy } from "lucide-react";

export function TraceLink({ traceId }: { traceId: string }) {
  const [copied, setCopied] = React.useState(false);
  const grafanaUrl = process.env.NEXT_PUBLIC_GRAFANA_URL;
  const tempoHref = grafanaUrl
    ? `${grafanaUrl.replace(/\/$/, "")}/explore?orgId=1&left=${encodeURIComponent(
        JSON.stringify({
          datasource: { type: "tempo" },
          queries: [{ queryType: "traceql", query: `trace_id="${traceId}"` }],
        }),
      )}`
    : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(traceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard unavailable — the mono id stays selectable. */
    }
  };

  return (
    <span
      data-testid="trace-link"
      className="tower-data inline-flex max-w-full items-center gap-1.5 text-[11px]"
      title={
        tempoHref
          ? `Open trace ${traceId} in Tempo`
          : `Tempo deep-link wires in T-11 (NEXT_PUBLIC_GRAFANA_URL): /explore traceql trace_id="${traceId}"`
      }
    >
      {tempoHref ? (
        <a
          href={tempoHref}
          target="_blank"
          rel="noreferrer"
          className="tower-focus truncate text-cyan-300 underline"
        >
          {traceId}
        </a>
      ) : (
        <span className="truncate text-slate-300">{traceId}</span>
      )}
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy trace ${traceId}`}
        className="tower-focus shrink-0 rounded-[2px] border border-slate-700 p-1 text-slate-300 transition-colors duration-150 ease-out hover:border-cyan-400 hover:text-cyan-300"
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3 text-emerald-300" />
        ) : (
          <Copy aria-hidden="true" className="size-3" />
        )}
      </button>
      {copied ? <span className="shrink-0 text-emerald-200">Copied</span> : null}
    </span>
  );
}

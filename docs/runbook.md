# TOWER Lot-Ops Runbook — stale radar → logs → OTLP → secrets

One page. Every step is a copy-paste command. Fail loudly, never guess.

## 1. Stale radar? Confirm the signal (30s)

```bash
# Health gate: 503 LOT_OPS_DEGRADED + readsOnly:true = Postgres down, reads-only mode (E16)
curl -s -o /tmp/health.json -w "%{http_code}\n" https://<FRONTEND_URL>/api/health; cat /tmp/health.json
# Stream gate: no heartbeat >10s = SSE down, UI on 5s poll fallback (E18)
curl -sN --max-time 12 https://<FRONTEND_URL>/api/stream | head -n 5
# Ledger gate: outbox growing = BQ mirror down, holds still confirming (E14)
# (Cloud Run: check `Ledger sync pending` amber + outbox depth metric tower_outbox_depth)
```

| Signal | Meaning | Jump to |
|---|---|---|
| 503 `LOT_OPS_DEGRADED` | Postgres down, writes queued | §2 |
| No SSE heartbeat, amber `polling` dot | Stream down, poll fallback live | §2 (agent logs) |
| `Ledger sync pending` / `Observability delayed` badge | BQ / OTLP down, local buffer | §3 |

## 2. Cloud Run logs — find the trace (2 min)

```bash
# Tail the BFF + agent revisions, scoped to the failing trace_id from the UI
gcloud run services logs read tower-frontend --region <REGION> --limit 100 \
  --filter='textPayload:"trace_<ID>" OR textPayload:"Collision" OR textPayload:"PARTIAL_REROUTE_FAILED"'
gcloud run services logs read tower-agent --region <REGION> --limit 100 \
  --filter='textPayload:"STALE_ALTERNATIVE" OR textPayload:"FORCED_ORDER" OR textPayload:"IDEMPOTENCY_KEY_REUSE"'
# Common verdicts: 409 STALE_ALTERNATIVE → re-ranked alternatives already served (no action);
# PARTIAL_REROUTE_FAILED → old hold kept live, retry reroute; 422 NEEDS_CLARIFICATION → ask producer to restate.
```

## 3. OTLP endpoint — Grafana Cloud push (2 min)

```bash
# Verify the collector path the emitter pushes through (T-06 contract)
echo "endpoint=${GRAFANA_CLOUD_OTLP_ENDPOINT} instance=${GRAFANA_CLOUD_INSTANCE_ID}"
curl -s -o /dev/null -w "%{http_code}\n" -u "${GRAFANA_CLOUD_INSTANCE_ID}:${GRAFANA_CLOUD_API_KEY}" \
  "${GRAFANA_CLOUD_OTLP_ENDPOINT}/v1/metrics" -X POST -d '{}' -H 'Content-Type: application/json'
# 2xx/400 = reachable (400 = auth ok, empty body rejected — path is live); 401/403 = rotate the key (§4).
# Mimir check: tower_slots_total still incrementing; Tempo check: trace_id from §2 resolves to a hold span.
```

## 4. Secret Manager rotation — missing/invalid secret (E17, 3 min)

```bash
# Fail-loud checklist block prints MISSING_SECRET_<NAME>: never paste values into chat or code
gcloud secrets versions add GOOGLE_API_KEY --data-file=<(printf '%s' "$NEW_GEMINI_KEY")
gcloud secrets versions add GRAFANA_CLOUD_API_KEY --data-file=<(printf '%s' "$NEW_GRAFANA_KEY")
gcloud run services update tower-agent --region <REGION> \
  --update-secrets=GOOGLE_API_KEY=GOOGLE_API_KEY:latest
gcloud run services update tower-frontend --region <REGION> \
  --update-secrets=GRAFANA_CLOUD_API_KEY=GRAFANA_CLOUD_API_KEY:latest
# Verify: health 200 (or 503 ONLY for Postgres), stream heartbeat returns, badges clear
python3 .opencode/scripts/security_scan.py && python3 .opencode/scripts/lint_runner.py
```

Escalate to on-call when: two signals red at once, `LotUtil>95%` alert fires, or
`HighCollisionRate>5/hr` pages — paste the `trace_id` + the §2 log lines.

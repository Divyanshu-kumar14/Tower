# Tower
Studio Lot Air Traffic Control

## Hosted demo (T-11b, live on the beast)

**URL: http://132.226.187.232:3100** (frontend `:3100`; tailnet alias
`http://100.125.126.127:3100` until the one OCI console rule — VCN ingress
allow TCP 3100 — is added; see `infra/beast/README.md`).

60s canned path (`demo/script.md`): paste `Stage 3 tomorrow 6am-6pm,
Alexa 65, Maya 2-4pm` (`now=2026-09-05T12:00:00Z`) → red collision on
Stage 3 `08:00–10:00` blocked by Atlas → Reroute & Hold Stage 2 → radar
green + trace.

## Live proof (2026-09-06, curl-verified)

- Seed: 4 stage-type resources, `req_atlas` = 1 (`slot_atlas_stage3_0800`,
  confirmed, Stage 3 `08:00–10:00`).
- `GET /api/health` → 200 `status:"ok"`, `readsOnly:false`,
  `traceId:"trace_d0b0548c9dcd"`; agent `/health` → `postgres:"up"`,
  `breaker:"closed"`.
- `POST /api/requests` → `requestId:"req_44d1dfacbae5"`,
  `hasConflict:true`, first alternative `stage-2` score `0.975`,
  `traceId:"trace_2da0b0d3cbe7"`.
- `POST /api/reroute` → `status:"confirmed"`, trace
  `"trace_6b9cfb78be8d"` (shape `trace_` + 12 hex, echoed as `x-trace-id`).
- `GET /api/slots?date=2026-09-06` → 4 rows: Atlas confirmed + 3 holding
  (stage-2 reroute, alexa-65, maya). Radar `/` → 200.
- Beast `docker ps`: 4 `tower-*` containers healthy; the 8 Coolify/Traefik/
  Ollama/Uptime-Kuma containers untouched.
- Dashboard: Grafana Cloud OTLP wiring is runtime (`agent/observability/`
  exporter + `GRAFANA_CLOUD_*` env); `infra/grafana/provision.py` run and
  the BigQuery mirror remain manual (see `infra/beast/README.md`).

## Judging proofs

```bash
grep -R grafana --include='*.py' agent/ | head
grep -R google.cloud.aiplatform agent/ | head
python3 .opencode/scripts/checklist.py .
```

Auth posture: header-actor demo mode; F-AUTH-01 lockdown is accepted risk
until Google login lands post-hackathon (`docs/SECURITY_AUDIT.md`).
License: see `LICENSE` at the repo root.

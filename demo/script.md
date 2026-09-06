# TOWER 60s live demo — canned script vs the beast (T-11b)

Canonical URL: **http://132.226.187.232:3100**
Tailnet alias (same stack, same port): **http://100.125.126.127:3100**

> Network note (observed 2026-09-06): the beast serves `:3100` on all
> interfaces (`0.0.0.0:3100`, verified 200 from the box), but public
> inbound currently times out at the Oracle VCN security-list layer —
> long-standing ports (`:80`, `:3002`, `:8000`) time out identically from
> the operator network, so this is environmental, not the stack. One OCI
> console rule fixes it: VCN ingress allow **TCP 3100 from 0.0.0.0/0**.
> Until then run this script against the tailnet alias (every beat below
> was proven live on it; just swap the host).

Paste text (exact, beat 1): `Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm`

Send `now` = `2026-09-05T12:00:00Z` so "tomorrow" resolves to the seeded
conflict day `2026-09-06` (Atlas holds Stage 3 `08:00–10:00` confirmed).
Headers on every write: `x-tower-production: <your-tag>` (header-actor
demo mode — see `docs/SECURITY_AUDIT.md` F-AUTH-01) + a fresh UUID
`Idempotency-Key` that matches `idempotencyKey` in the body.

## Beat sheet

### 0:00 — outcome line + health (5s)

```bash
curl -s http://132.226.187.232:3100/api/health
# → 200 {"status":"ok","readsOnly":false,…,"traceId":"trace_<12hex>"}
```

Live proof 2026-09-06: `ok`, `readsOnly:false`,
`traceId:"trace_d0b0548c9dcd"` (shape `trace_` + 12 hex, echoed as
`x-trace-id` on every response). Agent (internal): `{"status":"ok",
"deps":{"postgres":"up","breaker":"closed"}}`.

### 0:10 — paste the canned text (15s, Gemini live parse)

```bash
curl -s -X POST http://132.226.187.232:3100/api/requests \
 -H 'content-type: application/json' \
 -H 'x-tower-production: atlas-demo' \
 -H 'Idempotency-Key: <fresh-uuid>' \
 -d '{"text":"Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm",
      "idempotencyKey":"<same-uuid>","now":"2026-09-05T12:00:00Z"}'
```

Expected: `requestId:"req_<…>"`, 3 parsed slots (stage-3 + alexa-65
`06:00–18:00`, maya `14:00–16:00`), `"hasConflict":true`,
`conflicts:[{"resource_id":"stage-3","overlap":"08:00-10:00",
"blockedBy":"req_atlas"}]`, first alternative `stage-2` score `0.975`
`"same specs (stage-2=stage-3)"`, plus `traceId`.

Live proof: `requestId:"req_44d1dfacbae5"`,
`traceId:"trace_2da0b0d3cbe7"` — red collision renders on Stage 3
`08:00` blocked by Atlas.

### 0:35 — Reroute & Hold on Stage 2 (15s)

```bash
curl -s -X POST http://132.226.187.232:3100/api/reroute \
 -H 'content-type: application/json' \
 -H 'x-tower-production: atlas-demo' \
 -H 'Idempotency-Key: <fresh-uuid-2>' \
 -d '{"requestId":"<requestId-from-beat-1>",
      "alternative":{"resource_id":"stage-2","resource_type":"stage",
        "start":"2026-09-06T06:00:00Z","end":"2026-09-06T18:00:00Z"},
      "idempotencyKey":"<same-uuid-2>"}'
```

Expected: `{"status":"confirmed",…,"traceId":"trace_<12hex>"}` — copy the
alternative verbatim from beat 1 (stale edits → `409 STALE_ALTERNATIVE`).

Live proof: `status:"confirmed"`, slot
`req_44d1dfacbae5--stage-2--reroute` `holding`,
`traceId:"trace_6b9cfb78be8d"`.

### 0:50 — radar green + trace (10s)

```bash
curl -s 'http://132.226.187.232:3100/api/slots?date=2026-09-06'
curl -s -o /dev/null -w '%{http_code}\n' http://132.226.187.232:3100/
```

Expected: slots list the Atlas `confirmed` row plus the new `holding`
rows (stage-2 reroute, alexa-65, maya); `/` returns 200 (radar UI).

Live proof: 4 rows — `slot_atlas_stage3_0800` confirmed +
3 holding under the demo `requestId`; radar page 200.

## Gemini-429 fallback

The agent holds an identical-text parse cache behind `GeminiBreaker`
(5× 429/5xx → open 30s): re-sending the beat-1 body byte-identical
(including `now`) serves the cached parse instead of calling Gemini, so a
429 mid-demo degrades to the same conflict report, never to an error card.
Fresh texts during an open breaker queue visibly ("Tower is holding —
retry in Ns"). Breaker was `closed` throughout the live proof above.

## Auth posture (verbatim orchestrator decision)

Header-actor mode stays for the hackathon demo surface; F-AUTH-01
(`verified:true` lockdown) is accepted risk until Google login lands
post-hackathon — reference `docs/SECURITY_AUDIT.md`.

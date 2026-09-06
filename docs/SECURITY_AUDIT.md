# TOWER Security Audit — T-10b (Request Pipeline)

- **Branch:** `Divyanshu-kumar14/test/phase-4-edge-chaos`
- **Date (UTC):** 2026-09-06
- **Scope:** TOWER request pipeline — auth (E20), idempotency (E19), XSS (E21),
  PII (E22), secrets, rate limiting (E24), SSE auth, middleware gates, CORS,
  error messages, credential handling.
- **Mode:** READ-ONLY review. No production files modified; this doc is the
  only file created by the audit.

## Verdict

No **Critical** (actively exploitable RCE / auth-bypass-against-real-data)
findings in the current pre-deploy state. One **High** (self-asserted actor
identity on write paths — a documented pre-T-11 gap that MUST close before
deploy), five **Medium** hardening items, three **Low** hygiene items, and
the remainder **Accept** (documented tradeoffs, verified airtight or safe).

`python3 .opencode/scripts/security_scan.py` → **PASS (zero findings), exit 0**,
confirmed independently. Independent secrets grep found **no real key
material** in tracked files (only docstring/test-pattern mentions of
`glc_…`/`AIza…` shapes and negative assertions).

## Findings

| ID | Sev | File:Line | Exploit sketch | Fix-or-accept |
|----|-----|-----------|----------------|---------------|
| F-AUTH-01 | **High** | `frontend/lib/auth.ts:47-81`, `frontend/app/api/requests/route.ts:69-77`, `frontend/app/api/reroute/route.ts:63-71` | Any client sets `x-tower-production: <anyone>` and writes as that production. `extractActor(req)` is called with **no verifier**, so `verified:false` actors pass the write gate. Cross-production impersonation needs only curl. | **Fix before deploy (conditional accept pre-deploy):** T-11 must wire the Google-JWKS verifier and require `verified:true` on all write paths in production (fail closed when no verifier configured). Pre-deploy accept: no real tenants/data yet; tracked as deploy gate. |
| F-AUTH-02 | Medium | `frontend/lib/auth.ts:113-144` | `createHmacTestVerifier` checks signature only — **no `exp`/`aud` enforcement**. Nothing at runtime prevents it from being wired in prod (only a doc comment). A leaked/stolen test token never expires. | **Fix (cheap):** add `exp` (and `aud` where applicable) checks to the test verifier AND a runtime guard that throws when `NODE_ENV==="production"`. Report-only per task; no prod edit made. |
| F-PII-01 | Medium | `frontend/app/api/requests/route.ts:241-247`, `frontend/lib/auth.ts:171-173` | `auditLog` writes raw user `text` (free-form NL, may contain names/phones/emails) to stdout → ships to Loki/BQ in T-06. The E22 `redactPII` scrub exists only in the agent emitter — the BFF audit path bypasses it. Log readers / BQ mirroring get cleartext PII. (UUIDs / idempotency keys / trace_ids are correlation handles, not PII per se — but joined with this cleartext `text` field they enable re-identification.) | **Fix before T-06 log shipping:** run audit `after.text` through `redactPII`-equivalent + truncate (e.g. 200 chars, mirroring `emit_parse`'s `text[:200]` preview). Keys (`actor, request_id, trace_id, before, after`) stay frozen. |
| F-PII-02 | Medium | `agent/observability/emitter.py:64-86,172-192,545-546` | `redactPII` covers **emails + US phone shapes only** — misses SSN, credit-card, API-key/token shapes, intl phones, and names/addresses (inherent). Gaps: `_record_log.extra` attrs (`crew`, `blocked_by`, `reason`, `overlap`) are stored **unredacted**; span attributes (`_safe_span` call sites, incl. `message[:500]` in `_do_emit_error`) are **unredacted**; buffered retry payloads keep raw `text[:500]`. | **Fix:** extend patterns (SSN/CC/token shapes) OR document E22 scope as email/phone-only; apply `redactPII` to `extra` values, span string attrs, and buffered payloads. |
| F-RATE-01 | Medium | `frontend/lib/rate-limit.ts:79-88,29-61` | `getClientIp` trusts `X-Forwarded-For`/`X-Real-Ip` unconditionally → attacker rotates the header per request and **never hits the 10 rps/IP bucket** (trivial 429 bypass, compounds F-AUTH-01 into unbounded spoofed writes). `buckets` Map grows per distinct IP with no prune → header-rotation also = **unbounded memory growth** (shared-bucket DoS). | **Fix:** trust XFF only from known proxy hops (or use platform connection IP), and bound/prune the bucket map (LRU + TTL sweep). |
| F-SSE-01 | Medium | `frontend/app/api/stream/route.ts:30-34,45`, same `traceIdOf` in `requests/route.ts:45-49`, `reroute/route.ts:39-43`, `slots/route.ts:25-29` | `traceIdOf` length-caps (128) but never charset-validates. Attacker `X-Trace-Id` containing `\n` is reflected into the SSE body (`:heartbeat trace=${traceId}`) → **SSE frame injection** (forged `event:`/`data:` frames into a client cache fed by `useRadarStream`); the same value is reflected into the `x-trace-id` response header (invalid chars → 500 or header-split risk depending on runtime). | **Fix:** accept only `^[A-Za-z0-9_-]{1,128}$`, else regenerate server-side. One-line, four call sites. |
| F-IDEM-01 | Medium | `frontend/app/api/requests/route.ts:186-240`, `frontend/app/api/reroute/route.ts:167-206` | BFF idempotency is **check → await agent → save** with no mutual exclusion: two concurrent same-key/same-body POSTs both pass `check()` then both invoke the agent (double side effect; second `save` just overwrites). Live Postgres `ON CONFLICT DO NOTHING` mitigates double-hold at the DB, but the BFF can still double-invoke. | **Fix:** per-key singleflight/mutex or synchronous placeholder-save at `check` time; keep 24h TTL semantics. Acceptable pre-deploy (single-user demo traffic). |
| F-ERR-01 | Low | `frontend/app/api/requests/route.ts:230-237`, `reroute/route.ts:196-203`, `slots/route.ts:57-66` | Agent `err.detail` is passed through **verbatim with its original status** — a future agent 500 carrying a traceback/path would leak internals to clients. (Current 401/422/500 bodies from the BFF itself are generic — verified safe.) | **Fix:** allowlist known codes for passthrough; map unknown/5xx to generic `AGENT_UPSTREAM` + `trace_id`. |
| F-SEC-HEADERS | Low→Medium | `frontend/next.config.mjs:1-4` | Empty Next config → **no security headers** (`Content-Security-Policy`, `X-Frame-Options`, `HSTS`, `X-Content-Type-Options`, `Referrer-Policy`). Low today (no auth cookies/sessions to steal), Medium once T-11 login lands. | **Fix in T-11:** add `headers()` with the standard set. |
| F-CRED-01 | Low | `infra/grafana/provision.py:163-164,261-264` | Credential handling is env-only, dry-run masks with `"***"`, no secret is ever printed — verified clean. Nit: `backend_password` falls back to `GRAFANA_CLOUD_API_KEY` although the docstring says that OTLP token is NOT valid for the stack API — token-confusion footgun. | **Fix (cheap):** require `GRAFANA_STACK_API_TOKEN` outright (fail closed) instead of falling back. Report-only; no edit made. |
| F-XSS-01 | Accept | `frontend/components/RadarScope.tsx:321-329,673`, `frontend/components/SlotCard.tsx:89-102`, `frontend/components/TraceLink.tsx:38-59`, `frontend/app/layout.tsx:40-46` | Sole `dangerouslySetInnerHTML` on a production-controlled path (radar tooltip) goes through `DOMPurify.sanitize` — correct pattern, and the snapshot test asserts no `<script>` survives. SlotCard/TraceLink render via React escaping; `layout.tsx` sink is a constant string only. Grep confirms no other `innerHTML` sinks. | **Accept.** Optional hardening: pin an explicit `ALLOWED_TAGS` config on the tooltip sanitize call. |
| F-SSE-AUTH | Accept | `frontend/app/api/stream/route.ts:36-40` | `GET /api/stream` is rate-limited but has **no `extractActor` gate**. Currently heartbeat-only (deliberately zero domain events), so nothing sensitive leaks. | **Accept with condition:** gate or scope the stream when T-11 wires the Redis-pubsub event bus with real slot data. |
| F-MW-01 | Accept | `frontend/middleware.ts:16-25` | Dev actor-stamp requires **both** `NODE_ENV!=="production"` and `TOWER_DEMO_PRODUCTION` set; matcher is `/api/*` only; skips when the header already exists. Cannot activate in a production build. | **Accept.** No change. |
| F-CORS-01 | Accept | all `frontend/app/api/**/route.ts` | No `access-control-allow-origin` anywhere (grep-verified) → default same-origin, no CORS misconfiguration on authed routes. | **Accept.** No change. |
| F-STORE-01 | Accept | `frontend/lib/idempotency.ts:81-132`, `agent/tower/store.py:352-384` | In-memory 24h idempotency stores on both sides with matching E19 semantics (same key+same hash → replay; same key+different body → 422) and TTL-as-missing; hash covers `{text/now/idempotencyKey/actor}` resp. agent-side dict — actor-scoped, canonicalized (sorted keys both sides). Multiprocess/restart loss is a known pre-deploy tradeoff; Postgres DDL/SQL strings are staged for T-11. | **Accept pre-deploy.** No change. |
| F-SUPPLY-01 | Accept | `frontend/package-lock.json` (present), `infra/grafana/provision.py` (stdlib-only), `.env.example` (names-only) | Lock file committed; provisioner has zero deps; `.env.example` holds zero values; secrets grep clean (hits are doc/test pattern mentions + negative assertions, not key material). | **Accept.** Recommend `npm audit` in CI (hygiene, not a finding). |

## Secrets sweep (independent)

- `python3 .opencode/scripts/security_scan.py` → `TOWER security scan: PASS (zero findings)`, exit 0.
- Independent `rg` for `glc_`, `glsa_`, `AIza`, `AQ.`, `BEGIN … PRIVATE`, `NEXT_PUBLIC_*SECRET/KEY/TOKEN`, `api_key := "..."` (excluding `.env`, `node_modules`, `.next`): hits are **only** docstring/test-pattern mentions (`infra/grafana/provision.py:14` doc note, `tests/python/test_edge_matrix.py:460-472` regex list, `agent/test_agent_tools.py:713`, `agent/observability/test_emitter.py:247` negative assertions). **No real credentials in tracked files.**
- `.env` is git-ignored (`.gitignore:22`), untracked, and committed code references secrets **only via env reads** (`os.environ.get` / `process.env`) — no `.env` file loading, no dotenv import.

## Error-message / CORS posture (verified)

- 401/422/500 bodies from the BFF are generic `{code, message}` envelopes, no stacks/paths (see `*_route.ts` catch-alls + `unauthorizedResponse`). Exception: agent-error passthrough (F-ERR-01, Low).
- No CORS headers on any API route (F-CORS-01). `next.config.mjs` sets no headers at all (F-SEC-HEADERS).

## Files read (explicit)

`frontend/lib/auth.ts`, `frontend/app/api/requests/route.ts`,
`frontend/app/api/reroute/route.ts`, `frontend/app/api/slots/route.ts`,
`frontend/app/api/health/route.ts`, `frontend/app/api/stream/route.ts`,
`frontend/lib/idempotency.ts`, `frontend/lib/rate-limit.ts`,
`frontend/lib/agent.ts`, `frontend/lib/validator.ts`, `frontend/lib/sse.ts`,
`frontend/middleware.ts`, `frontend/next.config.mjs`,
`frontend/app/layout.tsx`, `frontend/components/RadarScope.tsx`,
`frontend/components/SlotCard.tsx`, `frontend/components/TraceLink.tsx`,
`agent/tower/store.py`, `agent/observability/emitter.py`,
`infra/grafana/provision.py`, `.env.example`, `.gitignore` (via check-ignore).

## Modification statement

Audit performed read-only. The **only** file created/modified is
`docs/SECURITY_AUDIT.md` (this document). No production, test, config, or
script files were touched. `git status --short` confirms no tracked-file
modifications.

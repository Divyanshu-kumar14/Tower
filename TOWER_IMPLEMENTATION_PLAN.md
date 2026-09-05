# TOWER — Phase-Wise Implementation Plan

**Source:** `TOWER_PRD.md` v1.0 (Grafana Track | Agentic Cinema Hackathon)
**Derived:** 2026-09-05 via sequential-thinking analysis (8 thoughts, verified)
**Target:** `/home/rtx/Desktop/hackathonProjects/Tower`
**Outcome:** *You never lose a $50k shoot day — every NL request auto-deconflicted and visualized on a live radar.*
**Status:** Ready for agent execution — start at Phase 1, do not skip deterministic graph before agent tools.

---

## 0. Analysis Summary (What the PRD Demands)

### 0.1 Goals → Plan Traceability

| PRD Goal | Meaning | Proving Phase |
|---|---|---|
| G1: NL → collision check → auto-reroute <3s | Gemini parse + deterministic graph + atomic hold, sync HTTP P95 | Phase 2 (agent+BFF) + Phase 4 perf test |
| G2: Every state change → metric+log+trace w/ correlation ID | OTel push to Mimir/Loki/Tempo, same `trace_id` | Phase 2C (OTel wiring) |
| G3: 60s demo — 2 prods collide Stage 3 8am → red → auto-resolve Stage 2 → radar live | Pre-seeded `req_atlas` conflict + ConflictDrawer + SSE | Phase 3 + Phase 5 demo canning |
| G4: Prod-ready UX radar+timeline+drawer, responsive, iPad | Next.js 14 + Tailwind + shadcn + Framer Motion | Phase 3 |

### 0.2 Non-Goals (Explicitly Out of Scope)

NG1 no predictive ML · NG2 responsive web only (no native) · NG3 single lot only · NG4 mocked inventory (no camera hardware).

### 0.2b Personas & User Stories Traceability (PRD §3–§4 — Binding)

| Persona | Job to be Done | Proving Phase |
|---|---|---|
| Lot Ops Manager (primary) — tribal scheduling, 2am calls | Instant collision + best alternative, never say no without option | Phase 3C drawer + Phase 2C health strip |
| Producer — needs Stage 3 tomorrow, no lot state | Plain-English request → confirmed slot or next-best | Phase 3A RequestBar + Phase 2B `/requests` |
| 1st AD / Coordinator — chases crew/gear confirms | Crew holds + gear move atomically with stage | Phase 2A `reroute` atomic + Phase 4 E11 |

| User Story | Meaning | Proving Phase |
|---|---|---|
| US-01: `Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm` → CONFIRMED or CONFLICT + alternatives | Parse → DAG check | Phase 2A + 2B + 3A |
| US-02: Stage 3 taken 8am → red radar + Stage 2 viable + `Reroute & Hold Crew` | Collision UX | Phase 3B + 3C |
| US-03: Reroute moves crew+gear atomically, rollback + reason on failure | Transactional move | Phase 2A + Phase 4 E11 |
| US-04: Radar green/amber/red + Mimir util % + Loki who/what + Tempo lineage | LGTM radar | Phase 3B + Phase 2C |
| US-05: Grafana/BQ down → local-ledger confirm + queued flush + stale badge | Graceful degrade | Phase 4 E14/E15 + Phase 2C buffer |

### 0.3 Architecture (PRD §5 — Binding)

```text
[Producer UI: Radar + Request Bar] ←SSE→ [Next.js API Routes / BFF]
                                              │
                                              ├──► [TOWER Agent — ADK Python] ──► [Slot Graph + Collision Engine]
                                              │         │ Function Calling (forced safety)
                                              │         ├──► [Inventory Service] (Stages/Gear/Crew - Postgres)
                                              │         ├──► [Ledger — BigQuery] (source of truth for slots)
                                              │         └──► [Observability Emitter] → Mimir / Loki / Tempo
                                              │
                                              └──► [Grafana Cloud] ← dashboards + alerts + OnCall
```

**ADRs (must respect):**

- ADR-01 Modular monolith (Next.js BFF + single Python agent). No microservice sprawl.
- ADR-02 Postgres hot (interval queries, btree, `FOR UPDATE`) + BigQuery ledger/audit mirror via async CDC. Never block hold on BQ.
- ADR-03 Sync HTTP core (P95 <3s) + async Cloud Tasks only for observability flush + crew notifications. Circuit breaker + retry.
- ADR-04 Push via OTLP OTel Collector to Grafana Cloud. No Prometheus pull infra.

### 0.4 Dependency DAG (Critical Path)

```text
T-01 (contracts) → T-02 (schema+seed) → T-03 (graph ★ BLOCKS ALL) → T-04 (agent) → T-05 (BFF) → T-06 (OTel)
                                                                    ↘ T-07 (RequestBar) → T-08 (Radar+Gantt) → T-09 (Drawer+Health) → T-10 (chaos) → T-11 (deploy+demo)
Critical path: T-03 → T-04 → T-08 (radar needs SSE from T-05)
```

> Rule: **Do not start T-04 before T-03 is green. Do not start T-08 realtime before T-05 SSE is green.**

### 0.5 File Ownership (Enforced — Scope Creep Breaker)

| Owner | Allowed | Blocked From |
|---|---|---|
| `backend-specialist` | `frontend/app/api/**`, `agent/tower/**`, `services/**`, `agent/main.py`, Dockerfiles | UI styling, `*.test.*` prod edits outside API |
| `database-architect` | `services/**/schema.sql`, `infra/seed.sql`, `docker-compose.yml`, BigQuery DDL | UI views, API integration tests |
| `frontend-specialist` | `frontend/components/**`, `frontend/hooks/**`, `frontend/lib/**`, routes | API routes, DB migrations, backend logic |
| `test-engineer` | `**/*.test.*`, `__tests__/**`, `tests/e2e/**`, `infra/k6/**` | Production feature logic |
| `security-auditor` | Auth audit, secrets scan, OWASP review | Writing features |
| `devops-engineer` | `infra/**`, `cloudbuild.yaml`, Dockerfiles, Secret Manager, Grafana provision | Business logic, UI |
| `debugger` | Root-cause + targeted fix on failure | Scaffolding new features |

---

## Phase 1 — Foundation & Contracts (Blocks All)

**Objective:** Freeze cross-team contracts + land deterministic heart first.
**PRD refs:** §5, §7.2, §9, §15 T-01/T-02/T-03.

### 1A. T-01 Repo & Contracts [→ backend-specialist]

- **Target files:** `contracts/api.yaml`, `contracts/slot.ts`, `contracts/slot.py`, `frontend/lib/validator.ts` (stub), `agent/graph/__init__.py` (stub)
- **Tasks:**
  1. Write OpenAPI for `POST /api/requests`, `POST /api/reroute`, `GET /api/slots?date=`, `GET /api/stream` (SSE `slot:confirmed`, `collision`) — exact shapes from PRD §7.4 including `409 IDEMPOTENT_REPLAY`, `422 NEEDS_CLARIFICATION`, `409 STALE_ALTERNATIVE`, `422 INVALID_INTERVAL / IDEMPOTENCY_KEY_REUSE`.
  2. Generate `slot.ts` via `openapi-typescript`; hand-mirror `slot.py` (Pydantic v2) — `Slot{id, production, resource_type, resource_id, start, end, status, request_id, trace_id}` UTC datetimes.
  3. Zod schemas in BFF validator + Pydantic models in agent — same field names, fail loudly.
- **Verification:** `npm run typecheck` (tsc --noEmit 0 errors) `&& mypy agent/` (0 errors)
- **Exit:** Both typechecks green; contract files committed; no implementation drift.

### 1B. T-02 Inventory & Ledger Schema + Seed [→ database-architect]

- **Target files:** `services/inventory/schema.sql`, `services/inventory/api.ts` (`GET /inventory`), `services/ledger/schema.sql`, `services/ledger/rag.py`, `infra/seed.sql`, `docker-compose.yml`, `infra/bigquery/ledger.json` (BQ schema)
- **Tasks:**
  1. Postgres `resources(id PK, type CHECK stage|gear|crew, spec JSONB, status)` + `availability(resource_id FK, start_ts, end_ts TIMESTAMPTZ, reason)` (maintenance/blackout) + `slots(id PK, request_id, resource_id FK, resource_type, start_ts, end_ts TIMESTAMPTZ, status CHECK holding|confirmed|released, trace_id, idempotency_key UNIQUE, created_at)` + `CHECK(end_ts>start_ts)` + `CHECK(end-start >= 15min)` + indexes `(resource_id,start_ts,end_ts)`, `(request_id)`.
  2. BQ dataset `tower_ledger.slots` partitioned `DATE(created_at)`, clustered `resource_id`: `request_id, slot JSON, status, trace_id, created_at, idempotency_key`.
  3. `docker-compose.yml` Postgres 16 + Redis (60s inventory cache). `GET /inventory?date=` reads Postgres + Redis 60s TTL, BQ mirror for RAG grounding (`What gear is like Alexa 65?`). `services/ledger/rag.py` implements `RAG Q&A with BigQuery & PDFs` pattern to answer `Why was Stage 3 blocked on Sep 5?` via grounded query (US-04 audit + Appendix D).
  4. `infra/seed.sql`: Stages 1 (2000sqft), 2 (3000 = Stage 3 specs — credible alternative), 3 (3000), ADR Suite; Gear Alexa 65/Mini, Sony Venice, GFM Primavera; Crew Maya/Jon/Priya + turnaround rules; **pre-seeded `req_atlas` Stage 3 2026-09-06 08:00–10:00** for demo.
- **Verification:** `docker compose up -d && psql < services/inventory/schema.sql && psql < services/ledger/schema.sql && psql < infra/seed.sql && SELECT count(*) FROM resources` → stages=4; `SELECT * FROM slots WHERE request_id='req_atlas'` → 1 row.
- **Exit:** Seed counts correct; demo conflict present; hot-path indexes exist.

### 1C. T-03 Slot Graph Engine — Deterministic Heart ★ [→ backend-specialist]

- **Target files:** `agent/graph/slot_graph.py`, `agent/graph/test_slot_graph.py`
- **Contract (frozen):** `Slot`, `check_collisions(slots)->CollisionReport`, `rank_alternatives(conflict)->Top3`, `canPlace(slot)->bool+reason`
- **Tasks:**
  1. Interval tree per `resource_id` sorted by start (`bisect`, O(log n) insert). Overlap rule `existing.start < S.end and S.start < existing.end`.
  2. Separation minima: stage 30min turnaround, gear 15min swap, crew 11h rest (union). `canPlace` enforces buffer.
  3. Self-collision merge (E04): same-request overlaps merge, log `self_overlap_merged`. Overnight split (E07): `22:00–06:00` → two slots. Zero-duration reject (E06).
  4. Alternatives scoring: (1) spec match, (2) min time delta, (3) crew availability → top 3 with `score, reason`. `hold_slot` re-check inside transaction for stale-alternative detection (E12).
  5. Tests for E04, E06, E07, E08 (race logic), E09 (separation), E10 (crew rest), E11 (cascade), E12 (stale).
- **Verification:** `pytest agent/graph -v` — 100% on interval tree, **no LLM imports** (`grep -r "gemini\|llm" agent/graph/` empty).
- **Exit:** All graph tests green; T-04 unblocked. **Do not proceed to agent tools until this is green.**

**Phase 1 gate:** typecheck + mypy + seed counts + graph tests all green.

---

## Phase 2 — Agent, BFF & Observability

**Objective:** NL in → collision-free hold out, with every transition observable.
**PRD refs:** §7.1, §7.3, §7.4, §8, T-04/T-05/T-06.

### 2A. T-04 ADK Agent Tools + Forced Calling [→ backend-specialist]

- **Target files:** `agent/tower/agent.py`, `agent/tower/tools.py`, `agent/tower/safety.py`, `agent/observability/otel.py` (stubs), `agent/test_agent_tools.py`, `agent/requirements.txt`
- **Tasks:**
  1. `pip install "google-cloud-aiplatform[agent_engines,adk]>=1.101.0" openai opentelemetry-* pydantic`.
  2. Tools: `parse_request(nl, now_iso)->{slots, confidence, clarifications}` (Gemini 1.5 Flash forced-JSON + TZ-aware; >500 chars truncate + `needs_clarification`; unknown resource → `unknown_resource` + suggestions); `check_collisions` (pure graph, no LLM); `safety_check` (union hours, gear maintenance — **forced**); `hold_slot(slot, idempotency_key)` (`BEGIN; SELECT FOR UPDATE; INSERT ON CONFLICT DO NOTHING` + BQ async mirror, 409 on dup); `reroute(request_id, alternative)` (release old + hold new + move crew atomically, rollback + `PARTIAL_REROUTE_FAILED` on gear failure).
  3. Agent `tower-atc` system prompt: `NEVER confirm without check_collisions. ALWAYS safety_check before hold_slot (forced).` Enforce via ADK `forced_tool` config.
  4. Idempotency: same key+same body → replay stored result; same key+diff body → `422 IDEMPOTENCY_KEY_REUSE` (E19).
  5. Circuit breaker for Gemini 429/5xx: 5 failures → open 30s, queue + fallback cached parse (E13).
- **Verification:** `pytest agent/tower -v` (mocked Gemini) + `grep -r "forced" agent/` non-empty + `rg "hold_slot|check_collisions|parse_request" agent/ services/` call-sites reviewed.
- **Exit:** Forced-call proof present; atomic-hold tests green.

### 2B. T-05 BFF API Routes + SSE [→ backend-specialist]

- **Target files:** `frontend/app/api/requests/route.ts`, `frontend/app/api/reroute/route.ts`, `frontend/app/api/slots/route.ts`, `frontend/app/api/stream/route.ts`, `frontend/lib/validator.ts`, `frontend/app/api/__tests__/requests.test.ts`
- **Tasks:**
  1. `POST /requests`: Zod `min(1)` (E01 422), 500-char cap (E02), `Idempotency-Key` UUIDv4 required, 24h store, forward `now` + `x-tower-production` JWT actor → agent `/invoke`, propagate `X-Trace-Id`, return PRD §7.4 shape.
  2. `POST /reroute`: validate alternative, 409 `STALE_ALTERNATIVE` passthrough.
  3. `GET /slots?date=`: ETag + TanStack key `['slots', date]`.
  4. `GET /stream`: SSE via `TransformStream`, events `slot:confirmed`, `collision`; heartbeat; client reconnect contract (backoff + 5s poll fallback noted for frontend).
  5. Auth: Google OAuth JWT verify, 401 on missing/spoofed production (E20); producers see own + public conflicts only. Every slot write tags `actor` and logs `actor, request_id, trace_id, before, after` to Loki + BQ (PRD §11 audit).
  6. Resilience (implements E16/E24, tested in Phase 4): `GET /api/health` checks Postgres + BQ + OTLP — on Postgres down return 503 `LOT_OPS_DEGRADED` reads-only + queue writes (E16). Rate limit 10 rps/IP + per-lot bulkhead queue — 429 + `Retry-After` on herd (E24).
- **Verification:** `npm test api/requests` — covers E01–E07, E19; `curl -N /api/stream` receives heartbeat; `curl /api/health` 200/503 path + k6 herd 429 path.
- **Exit:** API tests green; SSE live; idempotency 409/422 + health/rate-limit paths proven.

### 2C. T-06 Grafana OTel Wiring [→ backend-specialist + devops-engineer]

- **Target files:** `agent/observability/emitter.py`, `agent/observability/otel.py`, `infra/grafana/dashboard.json`, `infra/grafana/provision.py`, `.env.example` (endpoint keys, no secrets)
- **Tasks:**
  1. OTel tracer `tower.atc` + meter instruments: `tower_slots_total{status}`, `tower_collisions_total{resource}`, `tower_resolve_duration_seconds`, `tower_parse_duration_seconds`, `tower_reroutes_total{from,to}`, `tower_errors_total{code}`. Labels only `lot, stage, production` — never `trace_id` as label (E25).
  2. Emit table PRD §8.2 exactly (parse/collision/hold/reroute/error → Mimir+Loki+Tempo with shared `trace_id`). `redactPII()` before Loki (E22). Local buffer + Cloud Tasks retry on OTLP 429/down, stale badge signal, never block hold (E15).
  3. Dashboard `TOWER Radar`: Row1 stats (util %, active conflicts, avg resolve), Row2 Loki `{service="tower"} |= "Collision"` + Tempo `service=tower`, Row3 reroutes table with `trace_id→Tempo` links. Alerts `HighCollisionRate>5/hr`, `StaleLedger BQ lag>5min`, `LotUtil>95%` → OnCall/Slack webhook.
  4. `provision.py` provisions data sources (Mimir/Loki/Tempo) + dashboard via Grafana Cloud API. Secrets `GRAFANA_CLOUD_API_KEY/OTLP_ENDPOINT/INSTANCE_ID`, `GOOGLE_API_KEY` → Secret Manager only.
- **Verification:** Local OTel → Grafana shows `tower_slots_total`; `curl` Tempo returns trace; `grep -r "grafana" agent/` shows runtime import+call (judging check); `grep -R "google.cloud.aiplatform" agent/` shows runtime import.
- **Exit:** Metric+log+trace correlated by `trace_id` end-to-end.

**Phase 2 gate:** agent tests + API tests + OTel live proof all green.

---

## Phase 3 — Frontend Radar (Production-Ready UX)

**Objective:** Radar scope + timeline + conflict drawer that runs the 60s demo on an iPad.
**PRD refs:** §6, T-07/T-08/T-09. Design tokens §6.4 binding (no purple gradients).

### 3A. T-07 RequestBar + Parsing Chips [→ frontend-specialist]

- **Target files:** `frontend/components/RequestBar.tsx`, `frontend/hooks/useParse.ts`, `frontend/components/__tests__/RequestBar.test.tsx`
- **Tasks:** NL input + `onSubmit(text, idempotencyKey UUIDv4)` + `isLoading`; debounce rapid submit; states idle/parsing-shimmer/conflict-amber/confirmed-green/error-red; parsed chips `[Stage 3 | 2026-09-06 06:00-18:00] [Alexa 65] [Maya 14:00-16:00]`; `?` chip + `Did you mean …?` for `needs_clarification`; ghost chip + suggestions for `unknown_resource`; empty>500-char guards; `react-hook-form+zodResolver`; URL `?date&stage` Zod-validated.
- **Verification:** Storybook + `npx playwright test requestbar` — type `Stage 3 tomorrow 6am` → chips + `?` clarification path.
- **Exit:** Chips + idempotency + clarification UX proven.

### 3B. T-08 RadarScope + TimelineGantt [→ frontend-specialist]

- **Target files:** `frontend/components/RadarScope.tsx`, `frontend/components/TimelineGantt.tsx`, `frontend/components/SlotCard.tsx`, `frontend/hooks/useRadarStream.ts`, `frontend/app/page.tsx`, `frontend/app/timeline/page.tsx`
- **Tasks:**
  1. RadarScope: SVG + Framer Motion concentric lot map, pads=stages, blips green/amber/red-pulse; hover tooltip (prod/time/crew), click → timeline scroll, drag slot → `slotGraph.canPlace()` pre-validate then agent call; SSE `useRadarStream()` (EventSource → TanStack `['slots',date]` cache) with backoff reconnect + `Live: reconnecting…` amber dot + 5s poll fallback (E18); virtualize/cluster at 50+ blips; empty-lot empty state (never blank); keyboard tab-through + ARIA live region for conflicts (US-02 announcement); JetBrains Mono timecodes/trace IDs, Inter for UI. Motion tokens binding (PRD §6.4): 150ms ease for blip state, 300ms drawer spring, no generic bounce; contrast 4.5:1, no purple gradients.
  2. TimelineGantt + SlotCard: rows Stage 1/2/3/ADR Suite, 00–24h 30min buckets, absolute divs rendering `SlotCard` (production, time, crew, trace link), collision overlap red-striped, drag-to-reroute, overnight-split render, zero-duration reject + shake+toast without API call; virtualize 100+ slots (E23 viewport+1 buffer).
  3. XSS: React escape + DOMPurify tooltips (E21 snapshot test).
- **Verification:** `npx playwright test radar` — seed 10 slots → 10 blips; gantt virtualizes; drag calls `/reroute`; SSE `slot:confirmed` animates green with trace ID.
- **Exit:** Radar+gantt realtime green on desktop + iPad viewport.

### 3C. T-09 ConflictDrawer + LotHealthStrip [→ frontend-specialist]

- **Target files:** `frontend/components/ConflictDrawer.tsx`, `frontend/components/LotHealthStrip.tsx`, `frontend/app/requests/page.tsx` (`RequestTable`, `TraceLink`)
- **Tasks:** Drawer bottom-sheet on collision (`Stage 3 conflict 08:00–10:00 blocked by Project Atlas…`), ranked alternatives (Stage 2 same-specs free first), `Reroute & Hold` → `POST /api/reroute` idempotent; HealthStrip KPIs (Util %, Active Conflicts, Avg Resolve) from Mimir w/ 30s cache + `updated Xs ago` on 429 + stale badge when Grafana down; `/requests` history + Tempo `TraceLink`.
- **Verification:** `npx playwright test conflict` — pre-seeded Sep 6 collision → drawer lists Stage 2 → click confirms → radar green + health updates + trace link resolves.
- **Exit:** The 60s demo path clicks through.

**Phase 3 gate:** `ux_audit.py` + `accessibility_checker.py` clean; Playwright radar/conflict green.

---

## Phase 4 — Hardening (Chaos, Perf, Security)

**Objective:** Prove no double-book, graceful degrade, zero secrets.
**PRD refs:** §10, §11, T-10.

### 4A. T-10 Edge Cases & Chaos [→ test-engineer + debugger + security-auditor]

- **Target files:** `tests/e2e/collision-race.spec.ts`, `tests/e2e/degrade.spec.ts`, `infra/k6/spike.js`, `docs/runbook.md`
- **Task matrix (each edge → test):**
  - Input E01–E07: API + unit (empty 422, 2000-char fuzz, TZ 23:59 clarification, self-merge, unknown-resource suggestions, invalid interval, overnight split).
  - Graph E08–E12: k6 50 VU concurrent holds → zero double-books (E08 `FOR UPDATE`+unique idx, one 200/one 409+fresh alternatives); separation (E09), crew rest block+suggest Priya (E10), atomic cascade rollback (E11), stale-alternative 409 refresh (E12).
  - External E13–E18: Gemini breaker, BQ-down → Postgres confirms + `Ledger sync pending` amber + 3x Cloud Tasks retry, Grafana-down → local buffer + `Observability delayed` stale (never block hold), Postgres-down 503 `LOT_OPS_DEGRADED` reads-only, missing Secret → fail-loud + checklist block, SSE 5min disconnect → backoff + poll.
  - Security E19–E22: idempotency-reuse 422, auth 401 + actor-tagged ledger, XSS snapshot, PII scrub.
  - Scale E23–E25: 500-slot gantt virtualization, 100-req herd 10rps/IP 429+Retry-After, label cardinality guard.
- **Verification:** `k6 run infra/k6/spike.js` zero double-books · `npx playwright test` degrade specs · `python .opencode/scripts/security_scan.py` clean · `python .opencode/scripts/lint_runner.py` clean.
- **Exit:** E01–E25 each has a named test; scans clean.

**Phase 4 gate:** k6 + security_scan + lint_runner green; runbook written (`stale radar → Cloud Run logs → OTLP endpoint → Secret Manager`).

---

## Phase 5 — Deploy & Demo Canning

**Objective:** Live URLs + canned 60s demo + judging proofs.
**PRD refs:** §12, §14, T-11, §17.

### 5A. T-11 Deploy & Demo [→ devops-engineer + backend-specialist + frontend-specialist]

- **Target files:** `agent/main.py` (FastAPI `/invoke`), `agent/Dockerfile`, `frontend/Dockerfile` (standalone), `cloudbuild.yaml` / `infra/terraform/*`, `infra/grafana/provision.py` (run), `README.md`, `demo/script.md`, `LICENSE` (already at top)
- **Tasks:**
  1. Cloud Run frontend (`NEXT_PUBLIC_API_URL`, Secrets) + agent (Agent Engine `agent_engine.deploy()` preferred for judging, Cloud Run fallback — both `POST /invoke`).
  2. Infra: BQ dataset, Supabase Postgres, Grafana dashboard provisioned; CI `lint → tsc --noEmit + mypy → test → security_scan → deploy`.
  3. README: hosted URL + public-repo proof + screenshots (Mimir/Loki/Tempo live) + license header.
  4. `demo/script.md` 60s canned: `0:00 outcome line → 0:10 paste "Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm" → 0:20 red collision Stage 3 08:00 blocked by Atlas → 0:35 click Reroute&Hold Stage 2 → 0:50 radar green + trace_id → Loki→Tempo → 0:60 utilization updates`. Cache canned parse for Gemini-429 fallback.
- **Verification:** `python .opencode/scripts/checklist.py .` **must pass** (task not done until it does). Manual: hosted URL live; `grep` proofs; trailer recorded.
- **Exit:** Checklist green + demo recorded + repo public.

---

## Phase 6 — Acceptance (checklist.py Gate)

Run in order, all must pass (PRD §17):

- [ ] `tsc --noEmit` 0 errors · `mypy agent/` 0 errors · `lint_runner.py` clean
- [ ] `POST /api/requests` canned text → `hasConflict:true` + Stage 2 alternative **and** `tower_collisions_total` increments (curl Mimir)
- [ ] `Reroute & Hold` → `trace_id` in Loki `{service="tower"} | json | trace_id="…"` **and** Tempo `hold` span
- [ ] Grafana `TOWER Radar` dashboard live (util + logs + traces)
- [ ] Repo public, license top, `grep -R grafana --include="*.py" agent/` + `grep -R google.cloud.aiplatform agent/` both show runtime imports
- [ ] Hosted URL live, 60s demo recorded, `security_scan.py` clean, secrets in Secret Manager only
- [ ] E01–E25 covered, k6 no double-book

---

## Appendix A — Build Order Checklist (Tick Off)

- [ ] 1A contracts → 1B schema+seed → 1C graph ★ → 2A agent → 2B BFF → 2C OTel → 3A RequestBar → 3B radar+gantt → 3C drawer+health → 4A chaos → 5A deploy+demo → Phase 6 acceptance

## Appendix B — Commands Quick Ref

```bash
# contracts
npm run typecheck && mypy agent/
# seed
docker compose up -d && psql $DATABASE_URL -f services/inventory/schema.sql -f services/ledger/schema.sql -f infra/seed.sql
# graph (no LLM)
pytest agent/graph -v
# agent + api
pytest agent/tower -v && npm test api/requests
# e2e + perf
npx playwright test && k6 run infra/k6/spike.js
# gates
python .opencode/scripts/lint_runner.py && python .opencode/scripts/security_scan.py && python .opencode/scripts/checklist.py .
# judging proofs
grep -r "grafana" agent/ ; grep -R "google.cloud.aiplatform" agent/ ; rg "hold_slot|check_collisions|parse_request" frontend/ agent/ services/
```

## Appendix C — Risks & Mitigations (PRD §16)

Gemini 429→canned cache+breaker · Grafana 10k-series→low cardinality+5s batch+pre-aggregate · deadlock→retry+jitter+`SKIP LOCKED` · metaphor→`Runway 3 = Stage 3` tooltips + outcome-first copy · BQ latency→Postgres hot, BQ async only.

## Appendix D — Open Questions (PRD §18, Resolved Where Possible)

1. OTLP push on free tier — yes via `otlp-gateway-prod-*.grafana.net/otlp` + `instanceId:apiKey` basic auth (verify key at deploy).
2. BQ mirror — keep (judging expects BigQuery runtime proof + RAG grounding `Why was Stage 3 blocked Sep 5?`).
3. Stage 2 == Stage 3 specs — assumed yes in seed; update `seed.sql` if lot survey differs.

---

*One task per PR. Keep blast radius bounded. Fail loudly, never swallow errors. No task is done until its verification command is green and call-sites are updated.*

# 🗼 TOWER — Studio Lot Air Traffic Control

> **You never lose a $50k shoot day to a double-booked stage, missing camera, or crew conflict.**
> Type a request in plain English. TOWER checks every dependency, flags collisions, and lands you on a clear slot — live on a radar scope.

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Next.js 14](https://img.shields.io/badge/Frontend-Next.js_14-black?logo=next.js)](frontend/)
[![Python 3.11](https://img.shields.io/badge/Agent-Python_3.11-blue?logo=python)](agent/)
[![Postgres 16](https://img.shields.io/badge/Store-Postgres_16-skyblue?logo=postgresql)](services/)
[![Grafana Cloud](https://img.shields.io/badge/Observability-Grafana_LGTM-orange?logo=grafana)](infra/grafana/)
[![Gemini](https://img.shields.io/badge/Parser-Gemini_Flash-8e75ff?logo=google)](agent/tower/)

---

## ✨ What is this?

Studios still schedule stages, cameras, and crew over spreadsheets, chats, and memory. Problems only surface on the shoot day — Stage 3 double-booked at 6 AM, the Alexa 65 stuck in maintenance, your lead actor needed in two places at once. Each failure costs **$25k–$50k a day**.

**TOWER fixes that.** Think of it as *air traffic control for your studio lot*:

1. 🎙️ **You ask in plain English** — *"Stage 3 tomorrow 6am–6pm, Alexa 65, Maya 2–4pm"*
2. 🧠 **Gemini understands you** — turns words into structured booking slots (stage + gear + crew, with real times)
3. 📐 **A deterministic engine checks for crashes** — no AI guessing here, just math (interval overlaps + safety buffers)
4. 🔴🟢 **The radar shows the truth** — green = confirmed, amber = holding, red = collision with a one-click fix
5. 🔭 **Everything is observable** — every decision emits a metric, a log, and a trace to Grafana Cloud with one shared `trace_id`

Built for the **Agentic Cinema Hackathon — Grafana Track**, where *execution itself is observability*: the radar isn't a skin over Grafana, it **is** Grafana data (Mimir + Loki + Tempo) rendered live.

---

## 🎬 Live demo (60 seconds)

**Hosted stack:** `http://132.226.187.232:3100` · Tailnet alias: `http://100.125.126.127:3100`

> If the public IP times out, use the tailnet alias — the box serves `:3100` fine, the Oracle VCN security list just needs one ingress rule (`TCP 3100 from 0.0.0.0/0`). Details in [`infra/beast/README.md`](infra/beast/README.md). Full click-by-click script in [`demo/script.md`](demo/script.md).

| Time | You do | You see |
|------|--------|---------|
| **0:00** | Open `/api/health` | `200 {"status":"ok"}` + a `trace_…` id — the lot is awake |
| **0:10** | Paste `Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm` (with `now=2026-09-05T12:00:00Z`) | 🔴 **Collision:** Stage 3 `08:00–10:00` blocked by *Project Atlas* → ranked fix: **Stage 2 (score 0.975, same specs)** |
| **0:35** | Click **Reroute & Hold Stage 2** | ✅ `status:"confirmed"` + new `trace_id` |
| **0:50** | Look at the radar | 🟢 Radar green, timeline holds 4 rows (Atlas confirmed + your 3 holds), trace links Loki → Tempo |

**Curl-verified proof (2026-09-06):** `req_44d1dfacbae5` → `hasConflict:true` → reroute → `trace_6b9cfb78be8d` → `GET /api/slots?date=2026-09-06` returns 4 rows, `/` returns 200, all 4 `tower-*` containers healthy, control-plane containers untouched.

---

## 🏗️ How it works

### The big picture

```mermaid
flowchart LR
    subgraph UI["🎛️ Producer UI — Next.js 14"]
        RB["⌨️ RequestBar<br/>plain English"]
        RS["📡 RadarScope<br/>green / amber / red"]
        TL["📊 Timeline Gantt"]
        CD["⚠️ ConflictDrawer<br/>Reroute & Hold"]
    end

    subgraph BFF["🧩 BFF — Next.js API Routes"]
        REQ["POST /api/requests"]
        RER["POST /api/reroute"]
        SLT["GET /api/slots"]
        SSE["GET /api/stream<br/>SSE live events"]
    end

    subgraph AGT["🤖 TOWER Agent — Python 3.11"]
        PARSE["parse_request<br/>Gemini Flash"]
        GRAPH["check_collisions<br/>Slot Graph — pure math"]
        SAFE["safety_check<br/>forced: union + maintenance"]
        HOLD["hold_slot / reroute<br/>atomic Postgres txn"]
    end

    subgraph DATA["💾 Data"]
        PG[("Postgres 16<br/>hot store + locks")]
        BQ[("BigQuery<br/>ledger mirror + RAG")]
        RD[("Redis 7<br/>60s inventory cache")]
    end

    subgraph OBS["🔭 Grafana Cloud LGTM"]
        MM["Mimir<br/>metrics"]
        LK["Loki<br/>logs"]
        TP["Tempo<br/>traces"]
    end

    RB --> REQ
    CD --> RER
    RS -.-> SSE
    TL --> SLT
    REQ --> PARSE --> GRAPH --> SAFE --> HOLD
    RER --> HOLD
    HOLD --> PG
    HOLD -.-> BQ
    PARSE -.-> RD
    PARSE --> MM & LK & TP
    GRAPH --> MM & LK & TP
    HOLD --> MM & LK & TP
```

### One request's journey

```mermaid
sequenceDiagram
    autonumber
    participant P as Producer 👩‍💼
    participant B as BFF 🧩
    participant G as Gemini 🧠
    participant S as Slot Graph 📐
    participant D as Postgres 💾
    participant O as Grafana 🔭

    P->>B: POST /api/requests<br/>"Stage 3 tomorrow 6am-6pm…" + Idempotency-Key
    B->>G: parse_request(nl, now_iso)
    G-->>B: 3 slots + confidence 0.92
    B->>S: check_collisions(slots)
    S-->>B: 🔴 conflict stage-3 08:00–10:00<br/>blockedBy req_atlas + Stage-2 alternative
    B->>O: metric + log + trace (same trace_id)
    B-->>P: hasConflict:true + alternatives + traceId
    P->>B: POST /api/reroute (Stage-2 alternative)
    B->>D: BEGIN → SELECT FOR UPDATE → re-check → INSERT
    D-->>B: confirmed (or 409 STALE_ALTERNATIVE)
    B->>O: reroute trace linking old + new
    B-->>P: status:confirmed + traceId
    B->>P: SSE slot:confirmed → 📡 radar turns green
```

> **The golden rule:** the LLM *understands*, the graph *decides*. `hold_slot` can never run without `check_collisions` + `safety_check` first (enforced as forced function calls). No vibes — just verified slots.

---

## 🚀 Quick start (under 5 minutes)

### What you need

| Tool | Version | Why |
|------|---------|-----|
| Docker + Compose | recent | Postgres + Redis in one command |
| Node | 20 | Frontend (Next.js 14) |
| Python | 3.11 | Agent + Slot Graph |
| `GOOGLE_API_KEY` | AI Studio key | Gemini parsing (fails loudly if missing — never silently) |

### 1️⃣ Clone & configure

```bash
git clone https://github.com/Divyanshu-kumar14/Tower.git
cd Tower
cp .env.example .env   # fill in values locally — .env is git-ignored, never commit it
```

### 2️⃣ Start the local lot (database + cache)

```bash
docker compose up -d
psql $DATABASE_URL -f services/inventory/schema.sql
psql $DATABASE_URL -f services/ledger/schema.sql
psql $DATABASE_URL -f infra/seed.sql

# sanity check — you should see 4 stages and the famous Atlas conflict:
psql $DATABASE_URL -c "SELECT count(*) FROM resources;"            # → stages = 4
psql $DATABASE_URL -c "SELECT * FROM slots WHERE request_id='req_atlas';"  # → 1 row
```

### 3️⃣ Run the agent (backend brain)

```bash
cd agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pytest graph -v        # deterministic heart — must be green, uses zero LLM calls
uvicorn main:app --port 8000
```

### 4️⃣ Run the radar (frontend)

```bash
cd frontend
npm ci
npm run typecheck      # tsc --noEmit, 0 errors
npm run dev            # open http://localhost:3000
```

Type **`Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm`** and watch the red collision bloom, then reroute to Stage 2. 🎉

---

## ⚙️ Key configuration & parameters

### Environment variables (names only — values live in `.env` / Secret Manager)

| Variable | What it is | Where it's used | Required? |
|----------|------------|-----------------|-----------|
| `GRAFANA_CLOUD_OTLP_ENDPOINT` | OTLP gateway, e.g. `https://otlp-gateway-prod-us-central-0.grafana.net/otlp` | `agent/observability/` push | ✅ prod / optional local (falls back to in-memory buffer) |
| `GRAFANA_CLOUD_INSTANCE_ID` | Stack instance id (OTLP basic-auth username) | OTel exporter | ✅ with endpoint |
| `GRAFANA_CLOUD_API_KEY` | Access-policy token (OTLP password **only**, not the stack API) | OTel exporter | ✅ with endpoint |
| `GRAFANA_CLOUD_URL` | Stack URL for dashboard provisioning | `infra/grafana/provision.py` | for `provision.py` runs |
| `GRAFANA_STACK_API_TOKEN` | In-stack Admin service-account token (falls back to API key if unset) | `provision.py` | for dashboard setup |
| `GOOGLE_API_KEY` | Google AI Studio key for Gemini parse | `agent/tower/` at call time | ✅ (missing = loud startup failure) |
| `DATABASE_URL` | Postgres connection, e.g. `postgresql://tower:tower@localhost:5432/tower` | Agent + BFF health | ✅ |
| `AGENT_BASE_URL` / `AGENT_TIMEOUT_MS` | BFF → agent wiring (e.g. `http://agent:8000`, `8000`) | `frontend/app/api/` | ✅ on compose |

> 🔒 **Secret discipline:** `.env.example` contains *names only, zero values*. Real keys live in git-ignored `.env` locally and Secret Manager in prod. `security_scan.py` fails the build on leaks.

### Separation minima (the ATC safety buffers)

These are enforced by `canPlace()` — not suggestions, but hard rules:

| Resource | Buffer | Meaning in plain English |
|----------|--------|--------------------------|
| 🎬 Stage | **30 min** turnaround | Time to clean + reset between bookings |
| 🎥 Gear | **15 min** swap | Time to move/check a camera package |
| 🧑‍🔧 Crew | **11 h** rest (union) | Minimum rest between shifts — e.g. Maya can't wrap at 06:00 and call at 08:00 |

### API parameters that matter

| Parameter | Where | Rule |
|-----------|-------|------|
| `text` | `POST /api/requests` | 1–500 chars. Empty → `422`, over 500 → truncated + `needs_clarification` |
| `now` | `POST /api/requests` | ISO-8601 UTC anchor so *"tomorrow"* resolves deterministically (e.g. `2026-09-05T12:00:00Z` → Sep 6) |
| `Idempotency-Key` header **+** `idempotencyKey` body | all writes | UUID v4, must match. Same key + same body → replay stored result (`409 IDEMPOTENT_REPLAY` with original `requestId`); same key + different body → `422 IDEMPOTENCY_KEY_REUSE` |
| `x-tower-production` | all writes | Actor tag for the audit trail (demo header-actor mode — see Security) |
| `X-Trace-Id` / `traceId` | all responses | Shape `trace_` + 12 hex, echoed as response header, shown in UI (click → Tempo) |
| `?date=YYYY-MM-DD` | `GET /api/slots` | Day view, ETag-cached, TanStack key `['slots', date]` |

---

## 📖 Usage examples

### Check health

```bash
curl -s http://localhost:3000/api/health
# {"status":"ok","readsOnly":false,"traceId":"trace_d0b0548c9dcd"}
```

### Ask in plain English → get conflicts + fixes

```bash
UUID=$(uuidgen)
curl -s -X POST http://localhost:3000/api/requests \
  -H 'content-type: application/json' \
  -H 'x-tower-production: my-production' \
  -H "Idempotency-Key: $UUID" \
  -d "{\"text\":\"Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm\",\"idempotencyKey\":\"$UUID\",\"now\":\"2026-09-05T12:00:00Z\"}"
```

```json
{
  "requestId": "req_44d1dfacbae5",
  "parsed": { "slots": [ {"resource_type":"stage","resource_id":"stage-3","start":"2026-09-06T06:00:00Z","end":"2026-09-06T18:00:00Z"}, {"resource_type":"gear","resource_id":"alexa-65","start":"2026-09-06T06:00:00Z","end":"2026-09-06T18:00:00Z"}, {"resource_type":"crew","resource_id":"crew-maya","start":"2026-09-06T14:00:00Z","end":"2026-09-06T16:00:00Z"} ], "confidence": 0.92 },
  "collision": { "hasConflict": true, "conflicts": [{ "resource_id": "stage-3", "overlap": "08:00-10:00", "blockedBy": "req_atlas" }], "alternatives": [{ "slot": { "resource_id": "stage-2" }, "score": 0.975, "reason": "Same size, free" }] },
  "traceId": "trace_2da0b0d3cbe7"
}
```

### Reroute & hold (copy the alternative verbatim)

```bash
UUID2=$(uuidgen)
curl -s -X POST http://localhost:3000/api/reroute \
  -H 'content-type: application/json' \
  -H 'x-tower-production: my-production' \
  -H "Idempotency-Key: $UUID2" \
  -d "{\"requestId\":\"req_44d1dfacbae5\",\"alternative\":{\"resource_id\":\"stage-2\",\"resource_type\":\"stage\",\"start\":\"2026-09-06T06:00:00Z\",\"end\":\"2026-09-06T18:00:00Z\"},\"idempotencyKey\":\"$UUID2\"}"
# {"status":"confirmed","traceId":"trace_6b9cfb78be8d"}
```

### Read the day + watch live events

```bash
curl -s 'http://localhost:3000/api/slots?date=2026-09-06' | jq '.slots | length'  # → 4
curl -N http://localhost:3000/api/stream
# event: slot:confirmed
# data: {"slotId":"…","traceId":"…","resource_id":"stage-2"}
```

### API reference (full shapes in [`contracts/api.yaml`](contracts/api.yaml))

| Method & path | Does | Success | Key errors |
|---------------|------|---------|------------|
| `POST /api/requests` | Parse NL → check collisions → rank fixes | `200` + `requestId` + `parsed` + `collision` + `traceId` | `409 IDEMPOTENT_REPLAY` · `422 NEEDS_CLARIFICATION` · `422 INVALID_INTERVAL` |
| `POST /api/reroute` | Atomically move to an alternative | `200 {status:"confirmed", slots, traceId}` | `409 STALE_ALTERNATIVE` (re-fetch alternatives) · `409 PARTIAL_REROUTE_FAILED` |
| `GET /api/slots?date=` | Day view for radar + gantt | `200 {date, slots, etag}` | `422` bad date |
| `GET /api/stream` | SSE: `slot:confirmed`, `collision`, heartbeats | event stream | client auto-reconnects with backoff + 5s poll fallback |
| `GET /api/health` | BFF + agent + Postgres liveness | `200 ok` | `503 LOT_OPS_DEGRADED` (reads-only when DB down) |

---

## ⚠️ Edge cases & gotchas (the honest section)

TOWER tracks **25 edge cases (E01–E25)** in [`TOWER_PRD.md`](TOWER_PRD.md) §10 — each with a named test. The ones that will actually bite you:

**Input & language**

- 📝 *"tomorow"* (typo) or *"tomorrow at 23:59"* — Gemini returns `needs_clarification`, the UI shows a `?` chip with *"Did you mean 2026-09-06?"*. Always send `now` so relative dates resolve.
- 👻 *"Alexa 1000"* (doesn't exist) — you get `unknown_resource` + suggestions (`Alexa 65`, `Alexa Mini`), never a silent substitution.
- 🌙 Overnight `22:00–06:00` splits into **two** slots (`22:00–24:00` + `00:00–06:00` next day). Zero-duration or end-before-start is rejected (`422 INVALID_INTERVAL`).
- 🔀 Overlapping ranges *inside one request* auto-merge (logged as `self_overlap_merged`).

**Racing & staleness**

- 🏁 Two people grabbing the same stage at once: Postgres `SELECT … FOR UPDATE` + unique index means **one wins (200), one gets 409 + fresh alternatives**. Never a double-book (proven with k6 at 50 VUs).
- ⏳ Alternatives go stale fast. Copy the `alternative` object **verbatim** from the `/requests` response into `/reroute` — hand-edited times get `409 STALE_ALTERNATIVE`. Just re-fetch and retry.
- 🔑 **Idempotency keys are single-use per body.** Reuse a key with a different payload → `422 IDEMPOTENCY_KEY_REUSE`. Generate a fresh UUID per submit (the UI does this for you). Rapid double-clicks are safe — same key + same body replays the stored result.

**When dependencies fail (graceful, never silent)**

- 🤖 Gemini 429/5xx → circuit breaker (5 failures → open 30s). Identical-text retries serve the cached parse; new texts get *"Tower is holding — retry in Ns"*.
- 📊 Grafana down → holds still confirm via Postgres; observability queues to a local buffer and the UI shows an *"Observability delayed"* stale badge. **Holds are never blocked on telemetry.**
- 🗄️ BigQuery down → Postgres still confirms, mirror flush retries 3×, UI shows *"Ledger sync pending"*.
- 🐘 Postgres down → `503 LOT_OPS_DEGRADED`, reads-only mode, writes queue.
- 📡 SSE drops → exponential-backoff reconnect + *"Live: reconnecting…"* amber dot + 5s `/slots` poll fallback.

**Scale & safety**

- 📈 500+ slots on one day? The gantt virtualizes (viewport + 1 screen buffer), the radar clusters by stage.
- 🚦 100 requests at 9 AM? Rate limit is 10 rps/IP → `429 + Retry-After`, per-lot bulkhead queue.
- 🏷️ Never put `trace_id` in a metric *label* (cardinality explosion) — it's a log field + Tempo link. Only `lot`, `stage`, `production` are labels.
- 🔐 Demo auth is **header-actor** (`x-tower-production`) — convenient, not secure. Google-login lockdown (`F-AUTH-01`) is accepted hackathon risk; see [`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md). PII is scrubbed via `redactPII()` before Loki.

---

## 🗂️ Project structure

```
Tower/
├── frontend/                 # Next.js 14 App Router — radar UI + BFF API routes
│   ├── app/                  # /, /timeline, /requests + /api/{requests,reroute,slots,stream,health}
│   ├── components/           # RadarScope, TimelineGantt, RequestBar, ConflictDrawer, LotHealthStrip
│   ├── hooks/                # useRadarStream (SSE), useParse
│   └── lib/validator.ts      # Zod schemas (mirror of contracts)
├── agent/                    # Python 3.11 — the brain
│   ├── tower/                # parse_request, safety_check, hold_slot, reroute (forced calling)
│   ├── graph/slot_graph.py   # ★ deterministic heart: interval tree, separation, scoring — NO LLM
│   ├── observability/        # OTel → Mimir / Loki / Tempo (same trace_id everywhere)
│   └── main.py               # FastAPI wrapper (POST /invoke, /health)
├── services/
│   ├── inventory/            # resources + availability schema, GET /inventory (Redis 60s cache)
│   └── ledger/               # slots mirror + BigQuery RAG ("why was Stage 3 blocked?")
├── contracts/                # api.yaml (OpenAPI) + slot.ts + slot.py — single source of truth
├── infra/
│   ├── beast/                # live deployment: compose, Dockerfiles, ops README
│   ├── grafana/              # dashboard.json + provision.py (Mimir/Loki/Tempo + alerts)
│   ├── k6/spike.js           # 50 VU no-double-book proof
│   └── seed.sql              # 4 stages, gear, crew + pre-seeded req_atlas conflict
├── demo/script.md            # the canned 60s demo, beat by beat
├── docs/                     # runbook.md, SECURITY_AUDIT.md
├── tests/e2e/                # collision-race + degrade specs
├── TOWER_PRD.md              # full product spec (25 edge cases, ADRs, contracts)
├── TOWER_IMPLEMENTATION_PLAN.md  # phase-by-phase build order (T-01 → T-11)
└── LICENSE                   # MIT
```

**Key decisions (ADRs):** modular monolith over microservices (small team, fast deploy) · Postgres for the hot path + BigQuery as async ledger mirror (never block a hold on BQ) · sync HTTP core (P95 <3s) with async flush for telemetry · OTLP push to Grafana Cloud (no Prometheus infra to run).

---

## ✅ Testing & verification (no vibes)

```bash
# contracts
npm run typecheck --prefix frontend && mypy agent/

# deterministic heart (no LLM imports allowed in graph/)
pytest agent/graph -v

# agent tools (mocked Gemini) + BFF contracts
pytest agent/ -v && npm test --prefix frontend

# end-to-end + load (zero double-books at 50 VU)
npx playwright test && k6 run infra/k6/spike.js

# gates — a task is NOT done until these pass
python .opencode/scripts/lint_runner.py
python .opencode/scripts/security_scan.py
python .opencode/scripts/checklist.py .
```

**Judging proofs:**

```bash
grep -R grafana --include='*.py' agent/ | head              # runtime OTel wiring, not README mention
grep -R google.cloud.aiplatform agent/ | head               # agent runtime proof
rg "hold_slot|check_collisions|parse_request" frontend/ agent/ services/  # call-site audit
```

---

## 🚢 Deployment (the beast)

Live topology — 4 services on isolated `tower-net`, only `:3100` published (agent/pg/redis stay container-internal so Traefik/Coolify never collide):

```mermaid
flowchart TB
    NET(["🌐 internet :3100"]) --> FE["🖥️ frontend<br/>Next.js standalone<br/>node:20-alpine"]
    FE -- "AGENT_BASE_URL=http://agent:8000" --> AG["🤖 agent<br/>FastAPI · python:3.11-slim"]
    AG --> PG[("🐘 postgres:16-alpine<br/>DATABASE_URL")]
    AG -.-> RD[("⚡ redis:7-alpine<br/>reserved event bus")]
```

Deploy pointers (full sequence in [`infra/beast/README.md`](infra/beast/README.md)):

1. Ship code without artefacts (`tar` excluding `node_modules/.venv/.git`), `scp` the env file (`0600`, key names verifiable, values never printed).
2. Build **sequentially** (RAM watch): `postgres` → `agent` → `frontend`; `up -d` with `service_healthy` gates.
3. Seed **in order**: `inventory/schema.sql` → `ledger/schema.sql` → `seed.sql` (assert `stages=4`, `req_atlas=1`).
4. Verify: agent `/health` from inside the net, frontend `/api/health` + the 60s curl demo from your laptop.
5. Rollback is `down` → retag `:prev` → `up -d` (images kept); **never** `down -v` (that deletes the ledger volume).

Still manual post-hackathon: DNS (bare IP), Google login, BigQuery mirror, Grafana dashboard provision run.

---

## 🗺️ Roadmap

- [x] Contracts + schemas + seed (T-01/T-02)
- [x] Deterministic Slot Graph (T-03) — the heart
- [x] Agent tools + forced safety + BFF + OTel (T-04/T-05/T-06)
- [x] Radar + timeline + conflict drawer (T-07/T-08/T-09)
- [x] Edge matrix + chaos + runbook (T-10)
- [x] Beast deploy + canned demo (T-11)
- [ ] Google login (`verified:true` lockdown, F-AUTH-01)
- [ ] `provision.py` dashboard run + BigQuery mirror automation
- [ ] Ghost-hold janitor (expire abandoned `holding` rows — `revalidate()` already blocks them at hold time)

---

## 🤝 Contributing & 📄 License

One task per PR, bounded blast radius, fail loudly. Read [`TOWER_PRD.md`](TOWER_PRD.md) §15 and [`TOWER_IMPLEMENTATION_PLAN.md`](TOWER_IMPLEMENTATION_PLAN.md) before touching the graph or agent — **don't start agent tools until the graph is green, don't start realtime radar until SSE is green.**

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Divyanshu.

---

<p align="center">Built like an airport, for the lot. 🛫🎬<br/><sub>Every landing confirmed. Every conflict resolved. Every decision traced.</sub></p>

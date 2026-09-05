# TOWER — Studio Lot Air Traffic Control
## PRD & Implementation Plan — Grafana Track | Agentic Cinema Hackathon

**Version:** 1.0  
**Track:** Grafana Labs ($15k) — Gemini Enterprise + Grafana Cloud LGTM  
**Status:** Ready for Agent Implementation  
**Outcome Statement:** *You never lose a $50k shoot day to double-booked stages, missing gear, or crew conflicts — your studio lot runs like an airport, with every production request auto-deconflicted and visualized on a live radar.*

---

## 1. Vision & Problem

### 1.1 Problem
Studio lots (stages, gear, crew, render queues) are scheduled via spreadsheets, Slack, and tribal knowledge. Conflicts surface day-of: Stage 3 double-booked at 6am, Alexa 65 in maintenance, lead actor in ADR while needed on set. Cost of failure: $25k–$50k/day, reshoots, union penalties. Existing calendars check *one* resource, not the **dependency graph** (actor → stage → gear → crew).

### 1.2 Vision
TOWER is a **deterministic multi-agent ATC for the studio lot**: natural language in, collision-free schedule out, with lineage-visible execution. Gemini parses intent, the Slot Graph detects collisions via separation minima, the agent **executes** rebooking through tool calls, and **Grafana Cloud is the radar scope** — not an afterthought dashboard, but the operational source of truth where every decision is emitted as metrics/logs/traces.

### 1.3 Why This Wins
- **Structural theme fit:** ATC mechanic maps *physically* to studio logistics — cannot be swapped to healthcare/finance without rewriting. Not a skin.
- **Grafana-native:** Judges *see* Mimir/Loki/Tempo working live. Generic schedulers + Grafana skin lose to radar where execution *is* observability.
- **Deterministic + Agentic:** Not a chat wrapper — Forced Function Calling guarantees safety checks, graph search guarantees no collisions, traces prove determinism.

---

## 2. Goals / Non-Goals

### Goals
- G1: Natural language production request → collision check → auto-reroute in <3s
- G2: Every state change emits **metric + log + trace** to Grafana Cloud with correlation IDs
- G3: 60-second demo: 2 productions collide on Stage 3 at 8am → red alert → auto-resolve to Stage 2 → radar updates live
- G4: Production-ready UX: radar scope + timeline + conflict drawer, responsive, works on lot iPad

### Non-Goals (for this PRD)
- NG1: No predictive ML delay model (stretch)
- NG2: No mobile native app — responsive web only
- NG3: No multi-lot federation — single lot only
- NG4: No real hardware integration (cameras) — mocked inventory

---

## 3. Users & Personas

| Persona | Pain | Job to be Done |
| :--- | :--- | :--- |
| **Lot Ops Manager (primary)** | Tribal scheduling, phone calls at 2am | "When I get a request, I want to know *instantly* if it collides and what the best alternative is, so I never say no without an option." |
| **Producer** | Needs Stage 3 tomorrow, doesn't know lot state | "I want to request in plain English and get a confirmed slot or next-best, not a thread." |
| **1st AD / Coordinator** | Chases crew/gear confirmations | "I want crew holds and gear reservations to move atomically with the stage." |

---

## 4. User Stories (Agent-Readable)

```gherkin
US-01: Producer requests "Stage 3 tomorrow 6am-6pm, Alexa 65, with Maya for ADR 2-4pm"
  → System parses to structured slots, checks DAG, returns CONFIRMED or CONFLICT with alternatives.

US-02: When conflict detected (Stage 3 taken 8am), system shows red collision on radar, lists Stage 2 as viable (same specs), and offers one-click "Reroute & Hold Crew".

US-03: When reroute executed, crew holds and gear reservations move atomically; if crew unavailable, transaction rolls back and shows reason.

US-04: Lot Ops views radar: green (confirmed), amber (holding), red (conflict), sees live Mimir metric: lot utilization %, Loki logs of who requested what, Tempo trace of reroute lineage.

US-05: On failure (Grafana down, BigQuery down), system degrades: still confirms via local ledger, queues observability flush, shows stale indicator.
```

---

## 5. System Architecture

### 5.1 High-Level

```
[Producer UI: Radar + Request Bar]  ←SSE→  [Next.js API Routes / BFF]
                                                │
                                                ├──► [TOWER Agent — ADK Python] ──► [Slot Graph + Collision Engine]
                                                │         │ Function Calling (forced safety)
                                                │         ├──► [Inventory Service] (Stages/Gear/Crew - Postgres)
                                                │         ├──► [Ledger — BigQuery] (source of truth for slots)
                                                │         └──► [Observability Emitter]
                                                │                    ├──► Mimir (metrics)
                                                │                    ├──► Loki (logs)
                                                │                    └──► Tempo (traces)
                                                │
                                                └──► [Grafana Cloud] ← dashboards + alerts + OnCall
```

### 5.2 Component Map

| Component | Responsibility | Tech | Lives In |
| :--- | :--- | :--- | :--- |
| **Radar UI** | Radar scope, timeline, conflict drawer, request input | Next.js 14 App Router, Tailwind, shadcn/ui, Framer Motion | `frontend/` |
| **BFF API** | Auth, validation, SSE, proxy to agent, idempotency | Next.js Route Handlers, Zod | `frontend/app/api/` |
| **TOWER Agent** | NL → slots, graph search, Forced Function Calling, tool orchestration | Python 3.11, `google-cloud-aiplatform[adk,agent_engines]>=1.101.0`, Gemini 1.5 Flash | `agent/` |
| **Slot Graph** | DAG + separation minima, atomic holds | Python, NetworkX or custom interval tree | `agent/graph/` |
| **Inventory** | Stages/Gear/Crew catalog + availability | Postgres (Supabase) or BigQuery + Redis cache | `services/inventory/` |
| **Ledger** | Slot reservations, idempotency keys, audit log | BigQuery (primary) + Postgres mirror | `services/ledger/` |
| **Observability Emitter** | OTel → Grafana Cloud | OpenTelemetry Python, Grafana Cloud OTLP endpoint | `agent/observability/` |
| **Deployment** | Hosting | Cloud Run (agent + frontend), Secret Manager | `infra/` |

### 5.3 Architecture Decision Records (ADRs)

**ADR-01: Monolith Modular vs Microservices**
- *Decision:* Modular monolith (Next.js BFF + single Python agent service)
- *Trade-off:* Simpler deploy/debug for 4-day window vs future scale. Can extract Inventory/Ledger later.
- *Rationale:* Small team (solo+agents), early stage — simplicity wins. One failing tenant ≠ all, but bulkhead via separate Cloud Run revisions.

**ADR-02: BigQuery + Postgres vs Postgres-only**
- *Decision:* Postgres for hot inventory/interval queries (fast btree), BigQuery for ledger/audit + RAG grounding
- *Trade-off:* BigQuery is source of truth for media workflows, but slot collisions need sub-50ms range scans — Postgres interval indexes win. Sync via CDC.
- *Alternative considered:* BigQuery only → rejected (latency spikes on hot path)

**ADR-03: Synchronous HTTP vs Async Queue for Reroute**
- *Decision:* Synchronous HTTP for core request (P95 <3s), async via Cloud Tasks only for observability flush + crew notifications
- *Trade-off:* Simpler UX, immediate confirmation vs resilience under spike. Circuit breaker + retry protects.

**ADR-04: Grafana Cloud OTLP vs Prometheus pull**
- *Decision:* Push via OTLP OTel Collector to Grafana Cloud (Mimir/Loki/Tempo)
- *Trade-off:* No infra to run, fits hackathon, matches judging expectation of *runtime use* of partner.

---

## 6. Frontend Specification

### 6.1 Pages & Routes

| Route | Purpose | Key Components |
| :--- | :--- | :--- |
| `/` | Radar scope + request bar + lot health | `RadarScope`, `RequestBar`, `LotHealthStrip`, `ConflictDrawer` |
| `/timeline` | Gantt of stages vs time (day view) | `TimelineGantt`, `SlotCard` |
| `/requests` | History + audit | `RequestTable`, `TraceLink` |

### 6.2 Core Components (Agent Build Order)

**1. RequestBar** — natural language input + chips
- Props: `onSubmit(text, idempotencyKey)`, `isLoading`
- Edge: empty input, >500 chars, rapid submit (debounce + idempotency)
- States: idle / parsing (shimmer) / conflict (amber) / confirmed (green) / error (red)
- Example: Input "Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm" → shows parsed chips: `[Stage 3 | 2026-09-06 06:00-18:00] [Alexa 65] [Maya 14:00-16:00]`

**2. RadarScope** — ATC-inspired canvas
- Visual: concentric lot map, stages as pads, slots as blips (green confirmed, amber holding, red conflict with pulsing)
- Tech: SVG + Framer Motion, or Canvas for 60fps. Prefer SVG for simplicity + accessibility.
- Interaction: hover blip → tooltip (production, time, crew); click → Timeline scroll; drag slot → propose move (calls agent)
- Real-time: SSE from BFF; on `slot:confirmed` event, blip animates green with trace ID.
- Edge: 50+ blips → virtualize, cluster by stage.

**3. TimelineGantt** — day view
- Rows: Stages (Stage 1, 2, 3, ADR Suite)
- Columns: time 00:00–24:00, 30min buckets
- Slot rendering: absolute positioned divs, collision overlap = red striped. Supports drag to reroute.
- Edge: overnight slots crossing midnight, zero-duration slot rejected.

**4. ConflictDrawer** — bottom sheet
- Shows when collision: "Stage 3 conflict 08:00–10:00 — blocked by *Project Atlas* (Stage 3, Alexa Mini)". Lists alternatives ranked: Stage 2 (same specs, free), Stage 3 18:00–20:00. Each with "Reroute & Hold" CTA.
- Emits `POST /api/reroute` with `idempotencyKey`.

**5. LotHealthStrip** — top KPI
- Metrics from Mimir: Lot Utilization %, Active Conflicts, Avg Resolve Time. Polled via Grafana API or mirrored metrics.
- Shows stale badge if Grafana down.

### 6.3 State Management

- **Server state:** `TanStack Query` for inventory/ledger; `queryKey: ['slots', date]`
- **Realtime:** `EventSource` (SSE) → `useRadarStream()` hook pushes to Query cache.
- **Form:** `react-hook-form` + `zodResolver`
- **URL state:** `?date=2026-09-06&stage=3` for shareable links, validated with Zod.

### 6.4 Design Tokens (Anti-Cliché, Impeccable)

- **Palette:** Ink (slate-950 bg), radar grid (slate-800), blip green (emerald-400), amber (amber-400), red (rose-500), accent (cyan-400 for ATC). No purple gradients.
- **Typography:** JetBrains Mono for timecodes/trace IDs, Inter for UI. Mono only for data.
- **Motion:** 150ms ease for blip state, 300ms drawer spring. No generic bounce.
- **Accessibility:** Contrast 4.5:1, keyboard nav for radar (tab through blips), ARIA live region for conflict announcements.

### 6.5 Frontend Edge Cases

| Case | Handling |
| :--- | :--- |
| Empty lot (no slots) | Radar shows grid + "No ops — request a stage" empty state, not blank |
| 100+ concurrent slots | Virtualize gantt, cluster radar by stage, paginate requests |
| Rapid double-submit | Idempotency key (UUID v4) per submit, BFF 409 on dup |
| SSE disconnect | Exponential backoff reconnect, show "Live: reconnecting..." amber dot, fallback poll 5s |
| Grafana API 429 | Cache KPI 30s, show cached + "updated 23s ago" |
| Invalid date parse ("tomorow") | Gemini returns `needs_clarification`, UI shows chips with `?` and "Did you mean tomorrow 2026-09-06?" |
| Drag slot to invalid time | Validate via `slotGraph.canPlace()`, shake animation + toast, no API call |

---

## 7. Backend Specification

### 7.1 TOWER Agent (ADK Python)

**Location:** `agent/tower/`  
**Install:** `pip install "google-cloud-aiplatform[agent_engines,adk]>=1.101.0" openai` (for local dev)

**Agent definition (ADK):**

```python
# agent/tower/agent.py
from google.adk import Agent, tool

@tool
def parse_request(nl: str, now_iso: str) -> dict:
    """Gemini Flash parses NL to structured slots. Returns {slots, confidence, clarifications}."""
    # Uses Gemini Function Calling, forced JSON, Zod-like validation
    ...

@tool
def check_collisions(slots: list[Slot]) -> CollisionReport:
    """Deterministic interval-tree check. No LLM. Returns conflicts + alternatives ranked."""
    ...

@tool
def hold_slot(slot: Slot, idempotency_key: str) -> HoldResult:
    """Atomic hold with Forced Function Calling safety pre-check. Emits trace."""
    ...

@tool
def reroute(request_id: str, alternative: Slot) -> RerouteResult:
    """Transactional move: release old, hold new, move crew holds atomically."""
    ...

agent = Agent(
    name="tower-atc",
    model="gemini-1.5-flash",
    tools=[parse_request, check_collisions, hold_slot, reroute],
    system_prompt="You are TOWER, ATC for studio lots. You NEVER confirm without check_collisions. You ALWAYS call safety_check before hold_slot (forced)."
)
```

**Forced Function Calling:** `hold_slot` cannot be called without prior `check_collisions` + `safety_check` (crew union hours, gear maintenance window). Enforced via ADK `forced_tool` config.

**Deployment:** ADK Agent Engine `agent_engine.deploy()` to Vertex AI serverless, or fallback to Cloud Run `agent/main.py` (FastAPI wrapper exposes `/agent/invoke`).

### 7.2 Slot Graph & Collision Engine (Deterministic Core)

**File:** `agent/graph/slot_graph.py`

**Data Structure:**
```python
@dataclass
class Slot:
    id: str
    production: str
    resource_type: Literal["stage","gear","crew"]
    resource_id: str        # "stage-3", "alexa-65", "crew-maya"
    start: datetime  # UTC
    end: datetime
    status: Literal["holding","confirmed","released"]
    request_id: str
    trace_id: str
```

**Collision Algorithm (No LLM):**
- Interval tree per resource_id (sorted by start). Insert = O(log n) via `bisect`.
- For new slots `S`, for each resource, query overlapping intervals: `existing.start < S.end and S.start < existing.end`
- If overlap → Conflict. For gear/crew, also check dependency: if Stage 3 unavailable, crew hold fails.
- **Alternatives ranking:** Score by (1) same resource spec match, (2) minimal time delta, (3) crew availability. Return top 3.

**Separation Minima (ATC-inspired):**
- Stage turnaround: 30min between bookings (cleaning)
- Gear swap: 15min
- Crew rest: 11h (union)

**Atomicity:**
- `hold_slot` uses Postgres `BEGIN; SELECT ... FOR UPDATE; INSERT ... ON CONFLICT DO NOTHING` + BigQuery async mirror via `ledger.append`.
- Idempotency: `idempotency_key` unique index, 409 on duplicate.

### 7.3 Services

**Inventory Service** (`services/inventory/`)
- Table `resources(id, type, spec, status)` — spec JSON: `{camera: "Alexa 65", lens: "Primes", stage: {sqft: 3000, height: 18}}`
- Table `availability(resource_id, start, end, reason)` — maintenance, blackout
- Endpoint `GET /inventory?date=2026-09-06` → cached in Redis 60s, also BigQuery for RAG grounding: "What gear is like Alexa 65?"

**Ledger Service** (`services/ledger/`)
- BigQuery table `ledgerSlots(request_id, slot JSON, status, trace_id, created_at)` — source of truth, partitioned by date.
- Postgres mirror `slots` for hot path, with `FOR UPDATE` locks.
- RAG: `RAG Q&A with BigQuery & PDFs` pattern to answer "Why was Stage 3 blocked on Sep 5?" via grounded query.

### 7.4 API Contracts (BFF → Agent)

**POST /api/requests**
```json
// Request
{
  "text": "Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm",
  "idempotencyKey": "uuidv4",
  "now": "2026-09-06T00:00:00Z"
}
// Response 200
{
  "requestId": "req_123",
  "parsed": {
    "slots": [
      {"resource_type":"stage","resource_id":"stage-3","start":"2026-09-06T06:00:00Z","end":"2026-09-06T18:00:00Z"},
      {"resource_type":"gear","resource_id":"alexa-65","start":"2026-09-06T06:00:00Z","end":"2026-09-06T18:00:00Z"},
      {"resource_type":"crew","resource_id":"crew-maya","start":"2026-09-06T14:00:00Z","end":"2026-09-06T16:00:00Z"}
    ],
    "confidence": 0.92
  },
  "collision": {
    "hasConflict": true,
    "conflicts": [{"resource_id":"stage-3","overlap":"08:00-10:00","blockedBy":"req_atlas"}],
    "alternatives": [
      {"slot":{"resource_id":"stage-2","start":"2026-09-06T06:00:00Z","end":"18:00:00Z"},"score":0.95,"reason":"Same size, free"},
      {"slot":{"resource_id":"stage-3","start":"2026-09-06T18:00:00Z","end":"2026-09-06T20:00:00Z"},"score":0.7}
    ]
  },
  "traceId": "trace_abc123"
}
// Errors
409 {code:"IDEMPOTENT_REPLAY", requestId:"req_123"} // same idempotencyKey
422 {code:"NEEDS_CLARIFICATION", field:"date", message:"Did you mean 2026-09-06?"}
```

**POST /api/reroute**
```json
{"requestId":"req_123","alternative":{"resource_id":"stage-2","start":"2026-09-06T06:00:00Z","end":"18:00:00Z"},"idempotencyKey":"uuidv4"}
// 200 {status:"confirmed", slots:[...], traceId:"..."} or 409 {code:"STALE_ALTERNATIVE"}
```

**GET /api/slots?date=2026-09-06**
```json
{"date":"2026-09-06","slots":[...],"etag":"W/abc"}
```

**SSE: GET /api/stream**
```
event: slot:confirmed
data: {"slotId":"...","traceId":"...","resource_id":"stage-2"}

event: collision
data: {"requestId":"...","conflicts":[...]}
```

---

## 8. Grafana Cloud Integration (LGTM — Partner Runtime Proof)

**Goal:** Every state change emits **metric + log + trace** with same `trace_id` for correlation. Dashboard proves runtime use (judge checks imports).

### 8.1 OTel Setup

```python
# agent/observability/otel.py
from opentelemetry import trace, metrics
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

# Env: GRAFANA_CLOUD_OTLP_ENDPOINT=https://otlp-gateway-prod-...grafana.net/otlp
# Env: GRAFANA_CLOUD_INSTANCE_ID, GRAFANA_CLOUD_API_KEY → Secret Manager

tracer = trace.get_tracer("tower.atc")
meter = metrics.get_meter("tower.atc")

# Metric instruments
slot_counter = meter.create_counter("tower_slots_total", unit="1", description="Slots by status")
collision_counter = meter.create_counter("tower_collisions_total", unit="1")
resolve_histogram = meter.create_histogram("tower_resolve_duration_seconds")
```

### 8.2 What to Emit

| Event | Metric (Mimir) | Log (Loki) | Trace (Tempo) |
| :--- | :--- | :--- | :--- |
| `parse_request` | `tower_parse_duration_seconds` histogram | `{service="tower", level="info"} Parsed 3 slots confidence=0.92 text="Stage 3..."` | Span `parse` with `llm.tokens` attrs |
| `check_collisions` | `tower_collisions_total{resource="stage-3"}` ++ | `{service="tower", level="warn"} Collision stage-3 overlap 08:00 blockedBy=req_atlas` | Span `collision_check` with `alternative.count=2` |
| `hold_slot` | `tower_slots_total{status="confirmed"}` ++ | `{service="tower", level="info"} Hold stage-2 06:00-18:00 trace=abc crew=maya` | Span `hold` → child `safety_check` → `db.hold` |
| `reroute` | `tower_reroutes_total{from="stage-3",to="stage-2"}` | `{service="tower"} Reroute req_123 stage-3→stage-2 reason=collision` | Trace `reroute` linking original + alternative |
| Error | `tower_errors_total{code="409"}` | `{service="tower", level="error"} Hold failed STALE_ALTERNATIVE trace=...` | Span status ERROR with exception |

**Labels:** `lot="main"`, `stage="2"`, `production="atlas"` — allow Grafana variables.

### 8.3 Grafana Resources to Create (via API)

1. **Dashboard "TOWER Radar"** (JSON in `infra/grafana/dashboard.json`):
   - Row 1: Stat `Lot Utilization %` (Mimir query `avg(tower_slots_total)`), Stat `Active Conflicts`, `Avg Resolve Duration`.
   - Row 2: Logs panel (Loki query `{service="tower"} |= "Collision"`), Traces panel (Tempo `service=tower`).
   - Row 3: Table `Recent Reroutes` (Loki with `trace_id` link to Tempo).
2. **Alert:** `LotUtilization >95%` → Grafana OnCall webhook to Lot Ops Slack.
3. **Data Sources:** Prometheus (Mimir), Loki, Tempo — all provisioned via Grafana Cloud API key. Screenshot for README proof.

**Verification:** `grep -r "grafana" agent/` must show `import` + runtime call, not just README mention (judging checks).

---

## 9. Data Model

```sql
-- Postgres (hot)
CREATE TABLE resources (
  id TEXT PRIMARY KEY, -- stage-3
  type TEXT NOT NULL CHECK (type IN ('stage','gear','crew')),
  spec JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'available'
);

CREATE TABLE slots (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  resource_type TEXT NOT NULL,
  start_ts TIMESTAMPTZ NOT NULL,
  end_ts TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('holding','confirmed','released')),
  trace_id TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT no_zero_duration CHECK (end_ts > start_ts),
  CONSTRAINT separation_check CHECK (end_ts - start_ts >= interval '15 minutes')
);
CREATE INDEX ON slots (resource_id, start_ts, end_ts);
CREATE INDEX ON slots (request_id);

-- BigQuery (ledger mirror)
-- Dataset: tower_ledger, Table: slots (partitioned by DATE(created_at)), cluster by resource_id
-- Schema: request_id STRING, slot JSON, status STRING, trace_id STRING, created_at TIMESTAMP, idempotency_key STRING
```

**Seed Data (`infra/seed.sql`):**
- Stages: Stage 1 (2000 sqft), Stage 2 (3000, same as 3), Stage 3 (3000), ADR Suite
- Gear: Alexa 65, Alexa Mini, Sony Venice, GFM Primavera
- Crew: Maya (sound), Jon (gaffer), Priya (camera), turnaround rules
- Pre-seeded conflict: `req_atlas` holds Stage 3 08:00–10:00 Sep 6 for demo.

---

## 10. Edge Cases & Failure Modes (Comprehensive)

### 10.1 Input & Parsing

| # | Edge Case | Detection | Handling | Test |
|---|-----------|-----------|----------|------|
| E01 | Empty / whitespace text | Zod `min(1)` | 422 + empty state CTA, no agent call | `POST "" → 422` |
| E02 | 2000-char prompt injection | Gemini safety + length cap 500 | Truncate + `needs_clarification` | fuzz |
| E03 | Ambiguous date "tomorrow" at 23:59 UTC | Pass `now_iso` to Gemini, require TZ | Gemini asks clarification, UI shows `?` chip + "Did you mean 2026-09-07?" | TZ test |
| E04 | Overlap within same request (stage 3 6am-10am + 9am-6pm) | Slot Graph self-collision | Merge to 6am-6pm, show merged chip, log `self_overlap_merged` | unit |
| E05 | Unknown resource "Alexa 1000" | Inventory lookup miss | Return `unknown_resource` with suggestions ["Alexa 65", "Alexa Mini"], UI ghost chip | integration |
| E06 | Zero-duration / end < start | Slot `CHECK` | 422 `INVALID_INTERVAL` | unit |
| E07 | Overnight 22:00–06:00 | `start < end` fails | Split to two slots: `22:00-24:00` + `00:00-06:00` next day | unit |

### 10.2 Collision & Graph

| E08 | Two holds race on same stage (concurrent) | `SELECT FOR UPDATE` + unique idx | One wins 200, other 409 + fresh alternatives, client retries with new key | k6 50 VU |
| E09 | Separation minima violation (5min gap) | Graph `canPlace()` checks 30min buffer | Reject with `SEPARATION_VIOLATION` + next viable time | unit |
| E10 | Crew union rest 11h violation (Maya 22:00–06:00 → 08:00) | Crew availability check | Block + explain "Maya needs 11h rest until 17:00", suggest Priya | unit |
| E11 | Dependency cascade: Stage moves but gear still on old stage | Transactional reroute | Move stage+gear atomically, if gear fails, rollback all + `PARTIAL_REROUTE_FAILED` | integration |
| E12 | Alternative goes stale (taken between check and hold) | `hold_slot` re-checks | 409 `STALE_ALTERNATIVE`, UI refreshes alternatives, no ghost hold | E2E |

### 10.3 External Dependencies

| E13 | Gemini API 429 / 5xx | Circuit breaker (5 failures → open 30s) | Queue request, show "Tower is holding — retry in 5s", fallback to cached parse if recent same text | chaos test |
| E14 | BigQuery down | Ledger append fails | Postgres still confirms, queue BQ flush via Cloud Tasks retry 3x, show "Ledger sync pending" amber | integration |
| E15 | Grafana Cloud OTLP 429 / down | OTel retry + batch | Enqueue to local buffer (memory + Cloud Tasks), dashboard shows "Observability delayed" stale badge, no blocking of hold | integration |
| E16 | Postgres down | Health check fails | Return 503 `LOT_OPS_DEGRADED`, UI shows "Lot ops degraded — reads only", queue writes | e2e |
| E17 | Secret Manager key missing | Startup check | Fail loud on deploy, log `MISSING_SECRET_GRAFANA_API_KEY`, checklist.py blocks | deploy test |
| E18 | SSE disconnected 5min | Client heartbeat | Auto-reconnect exponential backoff, fallback poll `/api/slots` every 5s | e2e |

### 10.4 Security & Correctness

| E19 | Idempotency replay (same key, different body) | Compare body hash | 422 `IDEMPOTENCY_KEY_REUSE` | unit |
| E20 | No auth / spoofed production | BFF validates `x-tower-production` header + JWT | 401, all ledger writes tag `actor` | security scan |
| E21 | XSS in production name | React escapes, DOMPurify on tooltip | Snapshot test | |
| E22 | PII in logs (crew phone) | Scrub before Loki emit | `redactPII()` in emitter, `security_scan.py` checks | |

### 10.5 Scale & Performance

| E23 | 500 slots on one day | Gantt virtualization | Render only viewport + 1 screen buffer, paginate Loki | perf test |
| E24 | Thundering herd 100 requests at 9am | Rate limit 10 rps per IP + queue | 429 + `Retry-After`, bulkhead per lot | k6 |
| E25 | Trace cardinality explosion | Limit labels | Only `resource_id`, `lot` as labels, not `trace_id` as label (use log field) | |

---

## 11. Security, IAM, Correctness

- **Auth:** Next.js Auth (Google OAuth) → JWT → BFF validates, forwards `actor` to agent. Row-level: producers only see own requests + public conflicts (no PII).
- **Secrets:** `GRAFANA_CLOUD_API_KEY`, `GOOGLE_API_KEY` in Secret Manager, never in repo. `security_scan.py` must pass.
- **Idempotency:** Required header `Idempotency-Key` UUIDv4, server stores 24h.
- **Validation:** Zod on BFF, Pydantic on agent — fail loudly, never swallow.
- **Audit:** Every slot change logs `actor, request_id, trace_id, before, after` to Loki + BigQuery.

---

## 12. Observability & Operability

- **Dashboard:** `infra/grafana/dashboard.json` provisioned via `grafana-api` on deploy.
- **Alerts:** `HighCollisionRate` (collisions >5/hr), `StaleLedger` (BQ lag >5min).
- **Runbook:** `docs/runbook.md` — "If radar shows stale, check Cloud Run logs → Grafana OTLP endpoint → Secret Manager."
- **Tracing:** Every request has `trace_id` propagated via `X-Trace-Id` header, shown in UI (click to Tempo).

---

## 13. Testing Strategy (No Vibes)

| Layer | Command | What |
|-------|---------|------|
| Unit | `pytest agent/graph/test_slot_graph.py` | Interval tree, separation, scoring |
| Integration | `pytest agent/test_agent_tools.py` | ADK tools + Postgres + BQ emulator |
| API | `npm run test -- api/requests.test.ts` | BFF contracts, idempotency, 422s |
| E2E | `npx playwright test` | `producer → collision → reroute → radar green` + SSE |
| Perf | `k6 run infra/k6/spike.js` | 50 VU concurrent holds → no double-booking |
| Security | `python .opencode/scripts/security_scan.py` | No secrets, no XSS |
| Checklist | `python .opencode/scripts/checklist.py .` | Must pass before done |

**Call-site search before close:** `rg "hold_slot|check_collisions|parse_request"` across `frontend/`, `agent/`, `services/` — every rename updates all callers.

---

## 14. Deployment

- **Frontend:** Cloud Run `frontend/Dockerfile` (Next.js standalone), env `NEXT_PUBLIC_API_URL`, `GRAFANA_CLOUD_*` from Secret Manager.
- **Agent:** Cloud Run `agent/Dockerfile` (FastAPI wrapper) or Vertex AI Agent Engine — both expose `POST /invoke`. Prefer Agent Engine for judging "runtime use of Agent Builder".
- **Infra:** `infra/terraform/` or `cloudbuild.yaml` — creates BigQuery dataset, Postgres (Supabase), Grafana dashboard.
- **CI:** GitHub Action `lint → typecheck (tsc --noEmit, mypy) → test → security_scan → deploy` — `lint_runner.py` must be clean.

---

## 15. Implementation Plan (Agent-Executable Tasks)

*No build-time/agent-count info — just ordered tasks with inputs/outputs/verification. Each task is a bounded PR.*

### Phase 1 — Foundation & Contracts (Do First, Blocks All)

**T-01: Repo & Contracts**
- *Input:* This PRD
- *Output:* `contracts/api.yaml` (OpenAPI for /requests, /reroute, /slots, /stream), `contracts/slot.ts` + `contracts/slot.py` shared types via `openapi-typescript`
- *Verification:* `npm run typecheck && mypy agent/`

**T-02: Inventory & Ledger Schema + Seed**
- *Files:* `services/inventory/schema.sql`, `services/ledger/schema.sql`, `infra/seed.sql`, `docker-compose.yml` (Postgres)
- *Verification:* `psql < schema.sql && psql < seed.sql && SELECT count(*) → 4 stages`

**T-03: Slot Graph Engine (Deterministic Heart)**
- *Files:* `agent/graph/slot_graph.py`, `agent/graph/test_slot_graph.py` (tests for E04, E08–E12)
- *Contract:* `Slot`, `check_collisions()`, `rank_alternatives()`, `canPlace()`
- *Verification:* `pytest agent/graph -v` — 100% on interval tree, no LLM.

### Phase 2 — Agent & BFF

**T-04: ADK Agent Tools + Forced Calling**
- *Files:* `agent/tower/agent.py`, `agent/tower/tools.py`, `agent/observability/otel.py`
- *Behavior:* `parse_request` (Gemini) → `check_collisions` (graph) → `safety_check` (forced) → `hold_slot` (atomic + emit)
- *Verification:* `pytest agent/tower -v` with mocked Gemini, plus `grep -r "forced" agent/` proof.

**T-05: BFF API Routes + SSE**
- *Files:* `frontend/app/api/requests/route.ts`, `reroute/route.ts`, `slots/route.ts`, `stream/route.ts`, `frontend/lib/validator.ts` (Zod)
- *Handling:* idempotency, 422 clarification, SSE broadcast via `TransformStream`
- *Verification:* `npm test api/requests` — covers E01–E07, E19.

**T-06: Grafana OTel Wiring**
- *Files:* `agent/observability/emitter.py`, `infra/grafana/dashboard.json`, `infra/grafana/provision.py`
- *Verification:* Local OTel → `http://localhost:3000` shows `tower_slots_total` metric; `curl` Tempo query returns trace.

### Phase 3 — Frontend Radar

**T-07: RequestBar + Parsing Chips**
- *Files:* `frontend/components/RequestBar.tsx`, `frontend/hooks/useParse.ts`
- *Verification:* Storybook + `playwright` typing "Stage 3 tomorrow 6am" shows chips + `?` clarification.

**T-08: RadarScope (SVG) + TimelineGantt**
- *Files:* `frontend/components/RadarScope.tsx`, `frontend/components/TimelineGantt.tsx`, `frontend/hooks/useRadarStream.ts`
- *Verification:* `playwright` — seed 10 slots, radar renders 10 blips, gantt virtualizes; drag slot calls `/reroute`.

**T-09: ConflictDrawer + LotHealthStrip**
- *Files:* `frontend/components/ConflictDrawer.tsx`, `frontend/components/LotHealthStrip.tsx`
- *Verification:* Pre-seeded collision Sep 6 → drawer shows Stage 2 alternative, click confirms → radar green, health strip updates.

### Phase 4 — Hardening

**T-10: Edge Cases & Chaos**
- *Files:* `tests/e2e/collision-race.spec.ts` (k6 + Playwright for E08), `tests/e2e/degrade.spec.ts` (kill BQ/Grafana)
- *Verification:* `k6 run infra/k6/spike.js` — zero double-books under 50 VU; `security_scan.py` clean.

**T-11: Deploy & Demo Canning**
- *Files:* `agent/main.py` (FastAPI wrapper), `frontend/Dockerfile`, `agent/Dockerfile`, `cloudbuild.yaml`, `README.md` (hosted URL + public GitHub proof), `demo/script.md` (60s canned: 08:00 conflict script)
- *Verification:* `checklist.py .` passes — hosted URL live, 3-min trailer script ready, GitHub shows `import google.cloud.aiplatform` + `grafana` runtime calls, license at repo top.

### Dependency Order

```
T-01 → T-02 → T-03 → T-04 → T-05 → T-06
                         ↘ T-07 → T-08 → T-09 → T-10 → T-11
Critical path: T-03 (graph) blocks T-04 (agent) blocks T-08 (radar needs SSE)
```

---

## 16. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Gemini 429 at demo | Medium | High | Canned parse response cached, circuit breaker, fallback to local parser for seed text |
| Grafana Cloud free tier limits (10k series) | Low | Medium | Limit label cardinality, batch flush 5s, pre-aggregate lot utilization |
| Postgres FOR UPDATE deadlock under spike | Low | High | Retry 3x with jitter, idempotency, `SELECT ... SKIP LOCKED` for ranking |
| Judge doesn't get ATC metaphor | Medium | Medium | First sentence always outcome-first; radar tooltip says "Runway 3 = Stage 3" |
| BigQuery latency on hot path | Medium | Medium | Postgres for hot, BQ async mirror — never block hold on BQ |

---

## 17. Verification & Acceptance (For Checklist.py)

- [ ] `tsc --noEmit` 0 errors, `mypy agent/` 0 errors, `lint_runner.py` clean
- [ ] `POST /api/requests` with canned "Stage 3 tomorrow 6am-6pm, Alexa 65, Maya 2-4pm" → returns `hasConflict:true` with Stage 2 alternative *and* Grafana metric `tower_collisions_total` increments (curl Mimir)
- [ ] Click "Reroute & Hold" → `trace_id` appears in Loki `{service="tower"} | json | trace_id="..."` and Tempo trace shows `hold` span
- [ ] Grafana dashboard "TOWER Radar" reachable at Grafana Cloud URL, shows live utilization + logs + traces
- [ ] Repo public, license at top, `grep -R "grafana" --include="*.py" agent/` and `grep -R "google.cloud.aiplatform" agent/` both show runtime imports (not just README)
- [ ] Hosted URL live, demo 60s recorded, security_scan clean, secrets in Secret Manager
- [ ] Edge cases E01–E25 covered by tests, `k6` shows no double-book

---

## 18. Open Questions for Next 12h

1. Confirm Grafana Cloud OTLP endpoint + API key provisioning — does free tier allow custom OTLP push without allowlist? (Fetch verified: yes via `otlp-gateway-prod-*.grafana.net/otlp` + `instanceId:apiKey` basic auth)
2. Confirm BigQuery vs Postgres mirror — does judging require BigQuery runtime proof? If yes, keep mirror, else Postgres-only simpler.
3. Seed geometry: confirm Stage 2 = same specs as Stage 3 for credible alternative scoring? (PRD assumes yes — update `seed.sql` if not)

---

*This PRD is agent-executable: each T- task states input, output files, and verification command. Start at T-01, do not skip deterministic graph (T-03) before agent tools. Keep blast radius bounded — one task per PR.*

-- TOWER T-02 — ledger schema (hot Postgres).
-- BigQuery `tower_ledger.slots` (infra/bigquery/ledger.json) is the async
-- audit mirror; never block a hold on BQ (ADR-02).
--
-- Column names mirror contracts/slot.py Slot field names frozen across
-- OpenAPI / TS / Zod / Pydantic:
--   id, production, resource_type, resource_id, start (-> start_ts),
--   end (-> end_ts), status, request_id, trace_id.
-- end > start enforced here (maps to 422 INVALID_INTERVAL); minimum slot
-- length is 15 minutes.

CREATE TABLE IF NOT EXISTS slots (
  id              TEXT PRIMARY KEY,
  production      TEXT NOT NULL,
  resource_type   TEXT NOT NULL CHECK (resource_type IN ('stage', 'gear', 'crew')),
  resource_id     TEXT NOT NULL REFERENCES resources (id),
  start_ts        TIMESTAMPTZ NOT NULL,
  end_ts          TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('holding', 'confirmed', 'released')),
  request_id      TEXT NOT NULL,
  trace_id        TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_ts > start_ts),
  CHECK (end_ts - start_ts >= INTERVAL '15 minutes')
);

-- Hot-path: collision check scans one resource's window ...
CREATE INDEX IF NOT EXISTS idx_slots_resource_window
  ON slots (resource_id, start_ts, end_ts);

-- Hot-path: request history / reroute lookup by request.
CREATE INDEX IF NOT EXISTS idx_slots_request
  ON slots (request_id);

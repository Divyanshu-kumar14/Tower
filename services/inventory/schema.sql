-- TOWER T-02 — inventory schema (hot Postgres).
--
-- Owns: resources + availability (maintenance / blackout windows).
-- Slots live in services/ledger/schema.sql. Apply order for a fresh DB:
--   services/inventory/schema.sql -> services/ledger/schema.sql -> infra/seed.sql
-- Resource `type` mirrors contracts/slot.py ResourceType (stage | gear | crew).

CREATE TABLE IF NOT EXISTS resources (
  id     TEXT PRIMARY KEY,
  type   TEXT NOT NULL CHECK (type IN ('stage', 'gear', 'crew')),
  spec   JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS availability (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  start_ts    TIMESTAMPTZ NOT NULL,
  end_ts      TIMESTAMPTZ NOT NULL,
  reason      TEXT NOT NULL,
  CHECK (end_ts > start_ts)
);

CREATE INDEX IF NOT EXISTS idx_availability_resource_window
  ON availability (resource_id, start_ts, end_ts);

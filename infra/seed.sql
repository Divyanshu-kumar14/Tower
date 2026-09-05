-- TOWER T-02 seed — lot catalog + demo conflict.
-- Apply after services/inventory/schema.sql + services/ledger/schema.sql.
-- All timestamps TIMESTAMPTZ UTC. Safe to re-run (ON CONFLICT DO NOTHING).
--
-- Demo conflict (60s path): `req_atlas` holds Stage 3 2026-09-06 08:00-10:00
-- UTC (status confirmed) so a colliding request renders red with Stage 2
-- (same 3000sqft specs) as the ranked alternative.

BEGIN;

-- Stages: 1 (2000sqft), 2 (3000 = Stage 3 specs, credible alternative),
-- 3 (3000), ADR Suite.
INSERT INTO resources (id, type, spec, status) VALUES
  ('stage-1', 'stage',
   '{"name": "Stage 1", "sqft": 2000, "note": "Smaller stage; not a Stage 3 substitute"}',
   'active'),
  ('stage-2', 'stage',
   '{"name": "Stage 2", "sqft": 3000, "matches_stage_3_specs": true, "note": "Same specs as Stage 3; ranked first alternative on Stage 3 conflict"}',
   'active'),
  ('stage-3', 'stage',
   '{"name": "Stage 3", "sqft": 3000}',
   'active'),
  ('adr-suite', 'stage',
   '{"name": "ADR Suite", "purpose": "Dialogue replacement"}',
   'active')
ON CONFLICT (id) DO NOTHING;

-- Gear.
INSERT INTO resources (id, type, spec, status) VALUES
  ('alexa-65', 'gear', '{"name": "Alexa 65", "kind": "camera"}', 'active'),
  ('alexa-mini', 'gear', '{"name": "Alexa Mini", "kind": "camera"}', 'active'),
  ('sony-venice', 'gear', '{"name": "Sony Venice", "kind": "camera"}', 'active'),
  ('gfm-primavera', 'gear', '{"name": "GFM Primavera"}', 'active')
ON CONFLICT (id) DO NOTHING;

-- Crew (turnaround rules live in spec; 11h union rest enforced by T-03 graph).
INSERT INTO resources (id, type, spec, status) VALUES
  ('maya', 'crew',
   '{"name": "Maya", "role": "sound", "turnaround": "11h union rest between wrap and next call"}',
   'active'),
  ('jon', 'crew',
   '{"name": "Jon", "role": "gaffer", "turnaround": "11h union rest between wrap and next call"}',
   'active'),
  ('priya', 'crew',
   '{"name": "Priya", "role": "camera", "turnaround": "11h union rest between wrap and next call"}',
   'active')
ON CONFLICT (id) DO NOTHING;

-- Pre-seeded demo hold: Project Atlas on Stage 3, 2026-09-06 08:00-10:00 UTC.
INSERT INTO slots
  (id, production, resource_type, resource_id, start_ts, end_ts,
   status, request_id, trace_id, idempotency_key)
VALUES
  ('slot_atlas_stage3_0800', 'Project Atlas', 'stage', 'stage-3',
   '2026-09-06T08:00:00Z', '2026-09-06T10:00:00Z',
   'confirmed', 'req_atlas', 'trace_atlas_001',
   '123e4567-e89b-42d3-a456-426614174000')
ON CONFLICT (id) DO NOTHING;

COMMIT;

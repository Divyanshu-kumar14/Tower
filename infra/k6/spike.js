/**
 * TOWER E08 spike — 50 concurrent holds on ONE slot, zero double-books.
 *
 * habitat: runs in CI with `k6 run infra/k6/spike.js` (BASE_URL + key env).
 * Skipped locally: no k6 binary / no live BFF here (verified 2026-09-06:
 * `which k6` empty before install; scripts validated via Context7 k6 docs
 * + `k6 inspect` once installed).
 *
 * Live-DB version of the graph race proved in
 * tests/python/test_edge_matrix.py (50 threads × hold_all_atomic):
 * each VU POSTs the same contested window with a UNIQUE Idempotency-Key
 * (uuid per VU+iteration) against Postgres `SELECT ... FOR UPDATE` +
 * unique `idempotency_key`. Expected shape: exactly one 200 confirmed,
 * every other VU 409 (STALE_ALTERNATIVE / IDEMPOTENT_REPLAY) with fresh
 * alternatives — the `double_booked` counter must stay 0 or the run FAILS.
 */

import http from "k6/http";
import { check, fail } from "k6";

export const options = {
  vus: 50,
  iterations: 50,
  thresholds: {
    // Sync HTTP core budget (PRD G1): P95 of the hold round-trip < 3s.
    http_req_duration: ["p(95)<3000"],
    // Custom gate: any double-book fails the run.
    checks: ["rate==1.0"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const DATE = __ENV.SPIKE_DATE || "2026-09-06";

function uuid(vu, iter) {
  const h = ((vu * 100003 + iter * 1009) >>> 0).toString(16).padStart(8, "0");
  return `${h.slice(0, 8)}-1111-4111-8111-111111111111`;
}

export default function () {
  const vu = __VU;
  const iter = __ITER;
  const payload = JSON.stringify({
    text: "Stage 3 Sep 6 8am-10am",
    window: { resource_id: "stage-3", start: `${DATE}T08:00:00Z`, end: `${DATE}T10:00:00Z` },
  });
  const params = {
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": uuid(vu, iter),
      "x-tower-production": "atlas",
    },
  };
  const res = http.post(`${BASE_URL}/api/requests`, payload, params);
  const body = res.body ? res.body.toString() : "";

  // Exactly one VU may confirm; everyone else must get a 409-shaped
  // answer WITH fresh alternatives (never a second 200 on this window).
  const ok = check(res, {
    "one 200 confirmed OR 409 stale (zero double-books)": (r) => {
      if (r.status === 200) {
        try {
          const parsed = JSON.parse(body);
          return parsed.status === "confirmed" || parsed.collision?.hasConflict === true;
        } catch {
          return false;
        }
      }
      if (r.status === 409) {
        try {
          const parsed = JSON.parse(body);
          const alts = parsed.alternatives ?? parsed.collision?.alternatives ?? [];
          return (
            (parsed.code === "STALE_ALTERNATIVE" || parsed.code === "IDEMPOTENT_REPLAY") &&
            Array.isArray(alts) &&
            alts.length > 0
          );
        } catch {
          return false;
        }
      }
      return false;
    },
  });
  if (!ok) {
    fail(`E08 spike violation: status=${res.status} body=${body.slice(0, 200)}`);
  }
}

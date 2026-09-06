/**
 * TOWER E24 herd — 100 requests against the 10 rps/IP bulkhead.
 *
 * habitat: runs in CI with `k6 run infra/k6/herd.js`. Skipped locally
 * (no k6 binary / no live BFF here). Rate-limit unit gate lives in
 * frontend/app/api/__tests__/requests.test.ts
 * ("10 rps/IP burst passes, 11th → 429 + Retry-After, no sleeps").
 *
 * Arrival-rate executor pins the herd just above the bulkhead (20 rps for
 * ~5s = 100 requests from one IP): the BFF must answer 429 + `Retry-After`
 * once the 10 rps budget is spent. Thresholds fail the run when the gate
 * is missing (no 429s) or when legitimate traffic is starved (no 200s).
 */

import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    herd: {
      executor: "constant-arrival-rate",
      rate: 20,
      timeUnit: "1s",
      duration: "5s",
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
  thresholds: {
    // The bulkhead MUST bite: some of the 100 must be shed with 429.
    "checks{herd:shed}": ["rate>0"],
    // …but the lot stays open: some must still succeed.
    "checks{herd:served}": ["rate>0"],
    http_req_duration: ["p(95)<3000"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

function uuid(tag) {
  const h = (Date.now() + __VU * 7919 + __ITER * 104729 + tag).toString(16);
  const p = (h + h + h + h).slice(0, 32);
  return `${p.slice(0, 8)}-${p.slice(8, 12)}-4${p.slice(13, 16)}-a${p.slice(17, 20)}-${p.slice(20, 32)}`;
}

export default function () {
  // One IP, 20 rps against the 10 rps/IP bulkhead on POST /api/requests
  // (the rate gate fires BEFORE agent forwarding, so 429s prove the
  // bulkhead even when the agent is still spinning up).
  const res = http.post(
    `${BASE_URL}/api/requests`,
    JSON.stringify({ text: "Stage 3 Sep 6 8am-10am" }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uuid(1),
        "x-tower-production": "atlas",
      },
      tags: { herd: "probe" },
    },
  );
  check(
    res,
    {
      "herd served (200 under budget)": (r) => r.status === 200,
    },
    { herd: "served" },
  );
  check(
    res,
    {
      "herd shed (429 + Retry-After over budget)": (r) =>
        r.status === 429 && (r.headers["Retry-After"] ?? "") !== "",
    },
    { herd: "shed" },
  );
}

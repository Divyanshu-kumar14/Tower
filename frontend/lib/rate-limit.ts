/**
 * 10 rps/IP token-bucket rate limiter (T-05, E24).
 *
 * Contract: each IP gets a bucket of 10 tokens refilling at 10 tokens/sec.
 * Normal: tokens available → consume one, allowed. Empty: reject with
 * `retryAfterSec` (≥1s) so handlers can set the `Retry-After` header → 429.
 * Clock is injectable: unit tests drive fake time, never real sleeps.
 *
 * Per-lot bulkhead note (PRD NG3 — single lot only): this bucket stops one
 * client starving the lot, but lot-level isolation lives in T-11 (separate
 * Cloud Run revisions per tenant, queue + bulkhead there). Do not add
 * per-production buckets here — cardinality would explode (E25).
 */
export const RATE_LIMIT_RPS = 10;
export const RATE_LIMIT_BURST = 10;

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec: number;
}

export type RateLimitClock = () => number;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: RateLimitClock = () => Date.now()) {}

  check(key: string): RateLimitDecision {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: RATE_LIMIT_BURST, updatedAt: t };
      this.buckets.set(key, bucket);
    }
    const elapsedSec = Math.max(0, (t - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(
      RATE_LIMIT_BURST,
      bucket.tokens + elapsedSec * RATE_LIMIT_RPS,
    );
    bucket.updatedAt = t;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSec: 0 };
    }
    const retryAfterSec = Math.max(
      1,
      Math.ceil((1 - bucket.tokens) / RATE_LIMIT_RPS),
    );
    return { allowed: false, retryAfterSec };
  }

  reset(): void {
    this.buckets.clear();
  }
}

let shared: TokenBucketRateLimiter | null = null;

export function getRateLimiter(): TokenBucketRateLimiter {
  if (shared === null) shared = new TokenBucketRateLimiter();
  return shared;
}

/** Test-only: replace the module singleton (e.g. with a fake clock). */
export function resetRateLimiterForTests(
  now?: RateLimitClock,
): TokenBucketRateLimiter {
  shared = new TokenBucketRateLimiter(now);
  return shared;
}

/** Normal: first `x-forwarded-for` entry. Empty/missing: `127.0.0.1`. */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp !== undefined && realIp.length > 0) return realIp;
  return "127.0.0.1";
}

export function rateLimitedResponse(
  traceId: string,
  retryAfterSec: number,
): Response {
  return Response.json(
    {
      code: "RATE_LIMITED",
      message: `rate limit exceeded (10 rps/IP); retry after ${retryAfterSec}s`,
    },
    {
      status: 429,
      headers: {
        "retry-after": String(retryAfterSec),
        "x-trace-id": traceId,
      },
    },
  );
}

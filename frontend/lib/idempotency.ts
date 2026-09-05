/**
 * 24h idempotency-key store (T-05, E19) — mirrors `agent/tower/store.py`.
 *
 * E19 semantics (identical on both sides of the BFF→agent boundary):
 * same key + same body-hash → replay the stored result;
 * same key + different body → `422 IDEMPOTENCY_KEY_REUSE`.
 * Entries older than 24h are treated as missing.
 *
 * Postgres live path (T-11, documented — unit tests use the in-memory
 * implementation below, no Docker/Postgres in this env):
 *
 * ```sql
 * -- lookup (scoped to the 24h window, same as the agent):
 * SELECT body_hash, response, created_at FROM idempotency_keys
 *  WHERE key = $1 AND created_at > now() - INTERVAL '24 hours';
 * -- save (first writer wins; concurrent dup → ON CONFLICT DO NOTHING):
 * INSERT INTO idempotency_keys (key, body_hash, response, created_at)
 * VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (key) DO NOTHING;
 * ```
 */
import { createHash } from "node:crypto";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export const IDEMPOTENCY_LOOKUP_SQL =
  "SELECT body_hash, response, created_at FROM idempotency_keys " +
  "WHERE key = $1 AND created_at > now() - INTERVAL '24 hours'";

export const IDEMPOTENCY_UPSERT_SQL =
  "INSERT INTO idempotency_keys (key, body_hash, response, created_at) " +
  "VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (key) DO NOTHING";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Hash an idempotency body for E19 comparison.
 * Normal: hex sha256 (objects canonicalized with sorted keys, mirroring
 * the agent's `json.dumps(sort_keys=True)`). Invalid: never throws —
 * any JSON-able value hashes deterministically.
 */
export function computeBodyHash(body: string | unknown): string {
  const raw =
    typeof body === "string" ? body : JSON.stringify(canonicalize(body));
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export class IdempotencyKeyReuseError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSE" as const;
  readonly status = 422 as const;

  constructor(readonly key: string) {
    super(`IDEMPOTENCY_KEY_REUSE: ${key}`);
    this.name = "IdempotencyKeyReuseError";
  }
}

export interface IdempotencyReplay {
  requestId: string;
  response: unknown;
}

export type IdempotencyClock = () => number;

interface StoredRecord {
  bodyHash: string;
  response: unknown;
  requestId: string;
  createdAt: number;
}

export class InMemoryIdempotencyStore {
  private readonly records = new Map<string, StoredRecord>();

  constructor(private readonly clock: IdempotencyClock = () => Date.now()) {}

  lookup(key: string): StoredRecord | null {
    const rec = this.records.get(key);
    if (rec === undefined) return null;
    if (this.clock() - rec.createdAt >= IDEMPOTENCY_TTL_MS) {
      this.records.delete(key);
      return null;
    }
    return rec;
  }

  save(
    key: string,
    bodyHash: string,
    response: unknown,
    requestId: string,
  ): void {
    this.records.set(key, {
      bodyHash,
      response,
      requestId,
      createdAt: this.clock(),
    });
  }

  /**
   * E19 gate. Normal (new key): null. Same key + same hash: stored replay.
   * Same key + different hash: throws IdempotencyKeyReuseError (→ 422).
   * Expired (>24h) entries are treated as missing.
   */
  check(key: string, bodyHash: string): IdempotencyReplay | null {
    const rec = this.lookup(key);
    if (rec === null) return null;
    if (rec.bodyHash !== bodyHash) throw new IdempotencyKeyReuseError(key);
    return { requestId: rec.requestId, response: rec.response };
  }

  clear(): void {
    this.records.clear();
  }
}

let shared: InMemoryIdempotencyStore | null = null;

export function getIdempotencyStore(): InMemoryIdempotencyStore {
  if (shared === null) shared = new InMemoryIdempotencyStore();
  return shared;
}

/** Test-only: replace the module singleton (e.g. with a fake clock). */
export function resetIdempotencyStoreForTests(
  clock?: IdempotencyClock,
): InMemoryIdempotencyStore {
  shared = new InMemoryIdempotencyStore(clock);
  return shared;
}

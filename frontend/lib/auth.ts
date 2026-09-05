/**
 * Actor extraction + audit logging (T-05, E20).
 *
 * Contract: every write path requires `x-tower-production` (missing/spoofed
 * → 401). An optional `Authorization: Bearer <jwt>` is verified when a
 * verifier is supplied. No secrets live in this repo: production verifies
 * Google-OAuth JWTs via JWKS (wired in T-11 with NextAuth); tests use the
 * HMAC test verifier below with an in-memory secret only.
 *
 * Google OAuth path (T-11, documented): NextAuth Google provider issues the
 * session JWT → BFF validates signature + `aud`/`exp` against Google JWKS →
 * `actor` (production + email) is forwarded to the agent and tagged on every
 * ledger write. Producers see only their own requests + public conflicts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface Actor {
  production: string;
  email?: string;
  verified: boolean;
}

export class AuthError extends Error {
  readonly status = 401 as const;
  readonly code = "UNAUTHORIZED" as const;

  constructor(message = "missing or invalid x-tower-production") {
    super(message);
    this.name = "AuthError";
  }
}

export interface JwtClaims {
  email?: string;
  sub?: string;
  [key: string]: unknown;
}

export interface JwtVerifier {
  verify(token: string): Promise<JwtClaims>;
}

/**
 * Validate the production header. Normal: trimmed token. Empty/spoofed
 * (whitespace, separators, absurd length): throws AuthError (→ 401).
 */
export function extractProduction(req: Request): string {
  const raw = req.headers.get("x-tower-production")?.trim() ?? "";
  if (raw.length === 0) throw new AuthError("missing x-tower-production");
  if (raw.length > 120 || /[\s,;]/.test(raw)) {
    throw new AuthError("invalid x-tower-production");
  }
  return raw;
}

/**
 * Normal: `{production, verified:false}` without a bearer token, or the
 * verified `{production, email, verified:true}` with one. Invalid: AuthError.
 */
export async function extractActor(
  req: Request,
  verifier?: JwtVerifier,
): Promise<Actor> {
  const production = extractProduction(req);
  const authorization = req.headers.get("authorization");
  if (authorization === null || authorization.trim().length === 0) {
    return { production, verified: false };
  }
  const match = /^Bearer (.+)$/.exec(authorization.trim());
  const token = match?.[1]?.trim() ?? "";
  if (token.length === 0) throw new AuthError("malformed Authorization header");
  if (verifier === undefined) {
    throw new AuthError("bearer token present but no verifier configured");
  }
  const claims = await verifier.verify(token);
  const email =
    typeof claims.email === "string" && claims.email.length > 0
      ? claims.email
      : undefined;
  return { production, email, verified: true };
}

export function unauthorizedResponse(
  traceId: string,
  message: string,
): Response {
  return Response.json(
    { code: "UNAUTHORIZED", message },
    { status: 401, headers: { "x-trace-id": traceId } },
  );
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(
    input.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * HMAC-SHA256 JWT verifier — TESTS ONLY (no deps, in-memory secret).
 * Normal: valid signature + JSON payload → claims. Invalid (shape,
 * signature, payload): throws AuthError. Never use in production.
 */
export function createHmacTestVerifier(secret: string): JwtVerifier {
  return {
    async verify(token: string): Promise<JwtClaims> {
      const parts = token.split(".");
      if (parts.length !== 3) throw new AuthError("malformed JWT");
      const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
      const signingInput = `${headerB64}.${payloadB64}`;
      const expected = createHmac("sha256", secret).update(signingInput).digest();
      let actual: Buffer;
      try {
        actual = base64UrlDecode(sigB64);
      } catch {
        throw new AuthError("malformed JWT signature");
      }
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new AuthError("invalid JWT signature");
      }
      try {
        const parsed: unknown = JSON.parse(
          base64UrlDecode(payloadB64).toString("utf8"),
        );
        if (typeof parsed !== "object" || parsed === null) {
          throw new AuthError("malformed JWT payload");
        }
        return parsed as JwtClaims;
      } catch (err) {
        if (err instanceof AuthError) throw err;
        throw new AuthError("malformed JWT payload");
      }
    },
  };
}

/** Test-only helper: mint a token the HMAC test verifier accepts. */
export async function mintHmacTestToken(
  secret: string,
  payload: JwtClaims,
): Promise<string> {
  const headerB64 = base64UrlEncode(Buffer.from('{"alg":"HS256","typ":"JWT"}'));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

export interface AuditEntry {
  actor: string;
  request_id: string;
  trace_id: string;
  before: unknown;
  after: unknown;
}

/**
 * Structured audit line — Loki/BQ shipping lands in T-06; this stdout JSON
 * is the owned contract (keys frozen: actor, request_id, trace_id,
 * before, after). Never logs secrets — actor is an id, not a credential.
 */
export function auditLog(entry: AuditEntry): void {
  console.log(JSON.stringify({ audit: true, ...entry }));
}

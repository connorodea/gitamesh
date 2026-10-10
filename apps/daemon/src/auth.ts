import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { GitameshError } from "@gitamesh/protocol";
import type { StorageAdapter, StoredToken } from "@gitamesh/core";
import type { RateLimiter } from "./rate-limit.js";

/**
 * Opaque bearer-token auth (spec section 12, simplified for this
 * milestone). Tokens are minted with `mintToken`, hashed with SHA-256
 * before storage (the raw value is shown to the caller exactly once), and
 * verified per-request against the same hash. Scopes gate individual
 * routes; a token with the `admin` scope satisfies every scope check.
 */
export const SCOPES = [
  "repository:read",
  "repository:write",
  "agent:register",
  "agent:heartbeat",
  "task:read",
  "task:create",
  "task:claim",
  "task:complete",
  "events:read",
  "message:write",
  "admin",
] as const;
export type Scope = (typeof SCOPES)[number];

const PROBLEM_BASE = "https://gitamesh.dev/problems";

export function unauthorized(detail: string): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/unauthorized`,
    title: "Unauthorized",
    status: 401,
    detail,
  });
}

export function forbidden(detail: string, requiredScope: Scope): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/forbidden`,
    title: "Forbidden",
    status: 403,
    detail,
    extensions: { required_scope: requiredScope },
  });
}

export function rateLimited(retryAfterMs: number): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/rate-limited`,
    title: "Too Many Requests",
    status: 429,
    detail: `Rate limit exceeded; retry after ${retryAfterMs}ms.`,
    extensions: { retry_after_ms: retryAfterMs },
  });
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function generateRawToken(): string {
  return `gm_${randomBytes(32).toString("base64url")}`;
}

export interface MintedToken {
  tokenId: string;
  rawToken: string;
  scopes: Scope[];
  createdAt: string;
  expiresAt: string | null;
}

/**
 * Mints a fresh bearer token and persists only its hash. The raw token is
 * returned once here and never recoverable again — callers (the CLI
 * bootstrap flow, `scripts/mint-token.ts`) must show it to the operator
 * immediately.
 */
export function mintToken(
  storage: StorageAdapter,
  scopes: Scope[],
  opts?: { expiresAt?: string | null },
): MintedToken {
  const rawToken = generateRawToken();
  const tokenId = storage.generateId("token");
  const createdAt = storage.now();
  const expiresAt = opts?.expiresAt ?? null;
  storage.saveToken({
    token_id: tokenId,
    token_hash: hashToken(rawToken),
    scopes,
    created_at: createdAt,
    expires_at: expiresAt,
    revoked_at: null,
  });
  return { tokenId, rawToken, scopes, createdAt, expiresAt };
}

export function verifyToken(
  storage: StorageAdapter,
  rawToken: string,
): StoredToken | undefined {
  const record = storage.getTokenByHash(hashToken(rawToken));
  if (!record) return undefined;
  if (record.revoked_at) return undefined;
  if (record.expires_at && new Date(record.expires_at).getTime() <= Date.now()) {
    return undefined;
  }
  return record;
}

function extractBearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header) {
    const [scheme, value] = header.split(" ", 2);
    if (scheme?.toLowerCase() === "bearer" && value) return value.trim();
  }
  // Fallback for the WebSocket route: browser WebSocket clients cannot set
  // arbitrary headers on the upgrade request, so `?token=` is accepted
  // there too. Non-WS routes should always prefer the Authorization header.
  const queryToken = (request.query as Record<string, unknown> | undefined)?.token;
  if (typeof queryToken === "string" && queryToken.length > 0) return queryToken;
  return undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    authTokenId?: string;
    authScopes?: Scope[];
  }
}

/**
 * Builds a Fastify `preHandler` that requires a valid, non-expired,
 * non-revoked bearer token carrying `requiredScope` (or `admin`).
 * Never logs the raw token or its hash — only `token_id` is attached to
 * the request for downstream structured logging.
 */
export function requireScope(
  storage: StorageAdapter,
  requiredScope: Scope,
  options?: { rateLimiter?: RateLimiter },
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = extractBearerToken(request);
    if (!rawToken) {
      const err = unauthorized("Missing or malformed Authorization: Bearer <token> header.");
      reply.code(err.status).type("application/problem+json").send(err.toProblemDetails());
      return reply;
    }
    const record = verifyToken(storage, rawToken);
    if (!record) {
      const err = unauthorized("Token is invalid, expired, or revoked.");
      reply.code(err.status).type("application/problem+json").send(err.toProblemDetails());
      return reply;
    }
    if (!record.scopes.includes(requiredScope) && !record.scopes.includes("admin")) {
      const err = forbidden(
        `Token ${record.token_id} lacks required scope "${requiredScope}".`,
        requiredScope,
      );
      reply.code(err.status).type("application/problem+json").send(err.toProblemDetails());
      return reply;
    }
    if (options?.rateLimiter) {
      const check = options.rateLimiter.check(record.token_id);
      if (!check.allowed) {
        const err = rateLimited(check.retryAfterMs);
        reply
          .code(err.status)
          .header("Retry-After", Math.ceil(check.retryAfterMs / 1000))
          .type("application/problem+json")
          .send(err.toProblemDetails());
        return reply;
      }
    }
    request.authTokenId = record.token_id;
    request.authScopes = record.scopes as Scope[];
  };
}

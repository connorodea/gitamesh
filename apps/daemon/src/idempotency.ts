import type { FastifyRequest } from "fastify";
import type { StorageAdapter } from "@gitamesh/core";

/**
 * Idempotency-key convention for this daemon: every mutating route reads
 * the key from the `Idempotency-Key` HTTP header (not a body field). This
 * is applied consistently across agents/tasks/claims routes so clients
 * only need to learn one mechanism. For `POST /v1/tasks/:id/claim`,
 * `.../heartbeat`, `.../complete`, and `.../fail` the key is threaded
 * straight into `CoordinationEngine`'s own `idempotencyKey` param (claim)
 * or relies on the engine's built-in attempt-status-based replay
 * (heartbeat/complete/fail — see `packages/core/src/engine.ts`). For
 * `POST /v1/agents` and `POST /v1/tasks`, which have no engine-level
 * equivalent, this module provides the same guarantee directly against
 * storage's generic idempotency-key table.
 */
export function getIdempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  if (typeof header === "string" && header.length > 0) return header;
  if (Array.isArray(header) && header[0]) return header[0];
  return undefined;
}

export function withIdempotency<T>(
  storage: StorageAdapter,
  scope: string,
  key: string | undefined,
  fn: () => T,
): { result: T; replayed: boolean } {
  if (key) {
    const cached = storage.lookupIdempotentResult<T>(`${scope}:${key}`);
    if (cached !== undefined) {
      return { result: cached, replayed: true };
    }
  }
  const result = fn();
  if (key) {
    storage.recordIdempotentResult(`${scope}:${key}`, result);
  }
  return { result, replayed: false };
}

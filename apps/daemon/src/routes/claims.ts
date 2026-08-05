import type { FastifyInstance } from "fastify";
import type { StorageAdapter } from "@gitamesh/core";
import { requireScope } from "../auth.js";
import type { EventBroadcaster } from "../events-bus.js";
import type { RateLimiter } from "../rate-limit.js";

export function registerClaimRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  broadcaster: EventBroadcaster,
  rateLimiter: RateLimiter,
): void {
  app.get(
    "/v1/claims",
    { preHandler: requireScope(storage, "repository:read") },
    async (request) => {
      const query = request.query as { repositoryId?: string };
      return { claims: storage.listActiveResourceClaims(query.repositoryId) };
    },
  );

  // Manual release is a governance/admin escape hatch — normal claim
  // release happens automatically via complete/fail/expire in
  // CoordinationEngine. Gated behind `admin` since it lets an operator
  // pull a claim out from under a still-running attempt.
  app.post(
    "/v1/claims/:claimId/release",
    { preHandler: requireScope(storage, "admin", { rateLimiter }) },
    async (request, reply) => {
      const { claimId } = request.params as { claimId: string };
      const claim = storage.getResourceClaim(claimId);
      if (!claim) {
        return reply.code(404).type("application/problem+json").send({
          type: "https://gitamesh.dev/problems/claim-not-found",
          title: "Claim not found",
          status: 404,
          detail: `No resource claim exists with id ${claimId}.`,
        });
      }
      const released = storage.releaseResourceClaim(claimId);
      if (!released) {
        return reply.code(409).type("application/problem+json").send({
          type: "https://gitamesh.dev/problems/claim-already-released",
          title: "Claim already released",
          status: 409,
          detail: `Claim ${claimId} was already released.`,
        });
      }
      storage.appendEvent({
        schema_version: 1,
        event_type: "claim.released",
        occurred_at: storage.now(),
        namespace_id: claim.repository_id,
        repository_id: claim.repository_id,
        workflow_id: null,
        task_id: claim.task_id,
        attempt_id: claim.attempt_id,
        agent_id: null,
        workspace_session_id: null,
        correlation_id: null,
        causation_id: null,
        idempotency_key: null,
        payload: { resource_key: claim.resource_key, manual: true },
        metadata: {},
      });
      broadcaster.notifyNew();
      return { released: true };
    },
  );
}

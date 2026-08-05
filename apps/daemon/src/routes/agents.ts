import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Agent } from "@gitamesh/protocol";
import { canTransitionAgent } from "@gitamesh/core";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { requireScope } from "../auth.js";
import { sendError } from "../problem.js";
import { getIdempotencyKey, withIdempotency } from "../idempotency.js";
import type { EventBroadcaster } from "../events-bus.js";
import type { RateLimiter } from "../rate-limit.js";

const RegisterAgentBody = z.object({
  namespace_id: z.string().default("default"),
  display_name: z.string().min(1),
  runtime: z.string().min(1),
  version: z.string().default("0.0.0"),
  capabilities: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export function registerAgentRoutes(
  app: FastifyInstance,
  storage: SqliteStorageAdapter,
  broadcaster: EventBroadcaster,
  rateLimiter: RateLimiter,
): void {
  app.post(
    "/v1/agents",
    { preHandler: requireScope(storage, "agent:register", { rateLimiter }) },
    async (request, reply) => {
      const parsed = RegisterAgentBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).type("application/problem+json").send({
          type: "https://gitamesh.dev/problems/invalid-request",
          title: "Invalid request body",
          status: 400,
          detail: parsed.error.message,
        });
      }
      const idempotencyKey = getIdempotencyKey(request);
      try {
        const { result: agent, replayed } = withIdempotency<Agent>(
          storage,
          "createAgent",
          idempotencyKey,
          () => {
            const now = storage.now();
            const created: Agent = {
              agent_id: storage.generateId("agent"),
              namespace_id: parsed.data.namespace_id,
              display_name: parsed.data.display_name,
              runtime: parsed.data.runtime,
              version: parsed.data.version,
              capabilities: parsed.data.capabilities,
              status: "registered",
              last_heartbeat_at: null,
              metadata: parsed.data.metadata,
            };
            storage.saveAgent(created);
            storage.appendEvent({
              schema_version: 1,
              event_type: "agent.registered",
              occurred_at: now,
              namespace_id: created.namespace_id,
              repository_id: null,
              workflow_id: null,
              task_id: null,
              attempt_id: null,
              agent_id: created.agent_id,
              workspace_session_id: null,
              correlation_id: null,
              causation_id: null,
              idempotency_key: idempotencyKey ?? null,
              payload: { runtime: created.runtime, version: created.version },
              metadata: {},
            });
            return created;
          },
        );
        if (!replayed) broadcaster.notifyNew();
        reply.code(201);
        return { agent, replayed };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/v1/agents",
    { preHandler: requireScope(storage, "repository:read") },
    async () => {
      return { agents: storage.listAgents() };
    },
  );

  app.post(
    "/v1/agents/:agentId/heartbeat",
    { preHandler: requireScope(storage, "agent:heartbeat", { rateLimiter }) },
    async (request, reply) => {
      const { agentId } = request.params as { agentId: string };
      const agent = storage.getAgent(agentId);
      if (!agent) {
        return reply.code(404).type("application/problem+json").send({
          type: "https://gitamesh.dev/problems/agent-not-found",
          title: "Agent not found",
          status: 404,
          detail: `No agent exists with id ${agentId}.`,
        });
      }
      const now = storage.now();
      const targetStatus = agent.status === "online" ? "online" : "online";
      if (agent.status !== "online" && !canTransitionAgent(agent.status, "online")) {
        return reply.code(409).type("application/problem+json").send({
          type: "https://gitamesh.dev/problems/invalid-state-transition",
          title: "Invalid state transition",
          status: 409,
          detail: `Agent ${agentId} cannot transition from "${agent.status}" to "online".`,
        });
      }
      const updated: Agent = {
        ...agent,
        status: targetStatus,
        last_heartbeat_at: now,
      };
      storage.saveAgent(updated);
      storage.appendEvent({
        schema_version: 1,
        event_type: "agent.heartbeat",
        occurred_at: now,
        namespace_id: agent.namespace_id,
        repository_id: null,
        workflow_id: null,
        task_id: null,
        attempt_id: null,
        agent_id: agent.agent_id,
        workspace_session_id: null,
        correlation_id: null,
        causation_id: null,
        idempotency_key: null,
        payload: {},
        metadata: {},
      });
      broadcaster.notifyNew();
      return { agent: updated };
    },
  );
}

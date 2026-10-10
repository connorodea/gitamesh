import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { EventEnvelope } from "@gitamesh/protocol";
import {
  coordinationConflict, currentProgressAttempt, setTaskDependencies,
  type StorageAdapter, type EventWithCursor,
} from "@gitamesh/core";
import { requireScope } from "../auth.js";
import { getIdempotencyKey } from "../idempotency.js";
import { sendError } from "../problem.js";
import type { EventBroadcaster } from "../events-bus.js";
import type { RateLimiter } from "../rate-limit.js";

const id = z.string().trim().min(1).max(256);
const Page = z.object({
  since: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const Message = z.object({
  repositoryId: id, fromAgentId: id, toAgentId: id,
  taskId: id.optional(), body: z.string().trim().min(1).max(16000),
}).strict();
const Progress = z.object({
  attemptId: id, fencingToken: z.number().int().nonnegative(),
  summary: z.string().trim().min(1).max(8000),
  phase: z.enum(["working", "blocked", "verifying", "ready_for_review"]),
  evidence: z.array(z.string().trim().min(1).max(2000)).max(20).default([]),
}).strict();

/** Adds evidence to the existing append-only event store, never to the task queue. */
export function registerCheckinRoutes(
  app: FastifyInstance, storage: StorageAdapter, broadcaster: EventBroadcaster, rateLimiter: RateLimiter,
): void {
  function append(request: FastifyRequest, event: Omit<EventEnvelope, "event_id" | "repository_sequence" | "schema_version" | "occurred_at" | "metadata" | "idempotency_key">) {
    return storage.appendEvent({
      ...event, schema_version: 1, occurred_at: storage.now(),
      idempotency_key: getIdempotencyKey(request) ?? null,
      metadata: { token_id: request.authTokenId },
    });
  }

  // Atomic event + retry record. Reusing a key with different content is a conflict.
  function mutate<T>(request: FastifyRequest, fn: () => T): { result: T; replayed: boolean } {
    const key = getIdempotencyKey(request);
    const scope = `checkin:${request.authTokenId}:${request.url}:${key}`;
    const hash = createHash("sha256").update(JSON.stringify(request.body)).digest("hex");
    const result = storage.transaction(() => {
      const cached = key ? storage.lookupIdempotentResult<{ hash: string; value: T }>(scope) : undefined;
      if (cached) {
        if (cached.hash !== hash) coordinationConflict("Idempotency key was already used with different content.");
        return { result: cached.value, replayed: true };
      }
      const value = fn();
      if (key) storage.recordIdempotentResult(scope, { hash, value });
      return { result: value, replayed: false };
    });
    if (!result.replayed) broadcaster.notifyNew();
    return result;
  }

  function page(repositoryId: string, query: z.infer<typeof Page>, matches: (event: EventWithCursor) => boolean) {
    const result = storage.listEventsSince(query.since, { repositoryId, limit: query.limit });
    // Cursor advances across scanned events even if none match. No matching event is skipped.
    return { events: result.events.filter(matches), nextCursor: result.nextCursor, observed_at: storage.now() };
  }

  app.post("/v1/messages", { preHandler: requireScope(storage, "message:write", { rateLimiter }) }, async (request, reply) => {
    const parsed = Message.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ detail: parsed.error.message });
    try {
      const result = mutate(request, () => {
        const body = parsed.data;
        const from = storage.getAgent(body.fromAgentId);
        const to = storage.getAgent(body.toAgentId);
        if (!from || !to || from.status === "revoked" || to.status === "revoked" || from.namespace_id !== to.namespace_id) {
          coordinationConflict("Both agents must be registered in the same namespace and not revoked.");
        }
        const task = body.taskId ? storage.getTask(body.taskId) : undefined;
        if (body.taskId && (!task || task.repository_id !== body.repositoryId)) {
          coordinationConflict("The linked task must belong to the message repository.");
        }
        return append(request, {
          event_type: "agent.message", namespace_id: from.namespace_id,
          repository_id: body.repositoryId, workflow_id: task?.workflow_id ?? null,
          task_id: body.taskId ?? null, attempt_id: null, agent_id: from.agent_id,
          workspace_session_id: null, correlation_id: null, causation_id: null,
          payload: { to_agent_id: to.agent_id, body: body.body },
        });
      });
      return reply.code(result.replayed ? 200 : 201).send({ message: result.result, replayed: result.replayed });
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v1/messages", { preHandler: requireScope(storage, "events:read") }, async (request, reply) => {
    const parsed = Page.extend({ repositoryId: id, agentId: id }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ detail: parsed.error.message });
    const q = parsed.data;
    return page(q.repositoryId, q, (event) =>
      ["agent.message", "agent.message_acknowledged"].includes(event.event_type) &&
      (event.agent_id === q.agentId || event.payload.to_agent_id === q.agentId));
  });

  app.post("/v1/messages/:messageId/ack", { preHandler: requireScope(storage, "message:write", { rateLimiter }) }, async (request, reply) => {
    const parsed = z.object({ repositoryId: id, agentId: id }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ detail: parsed.error.message });
    try {
      const result = mutate(request, () => {
        const { messageId } = request.params as { messageId: string };
        const events = storage.listEventsForRepository(parsed.data.repositoryId);
        const message = events.find((event) => event.event_id === messageId && event.event_type === "agent.message");
        if (!message || message.payload.to_agent_id !== parsed.data.agentId) {
          coordinationConflict("Only the named recipient can acknowledge this message.");
        }
        const recipient = storage.getAgent(parsed.data.agentId);
        if (!recipient || recipient.status === "revoked") coordinationConflict("Recipient is not active.");
        const prior = events.find((event) => event.event_type === "agent.message_acknowledged" && event.causation_id === messageId);
        if (prior) return prior;
        return append(request, {
          event_type: "agent.message_acknowledged", namespace_id: message.namespace_id,
          repository_id: message.repository_id, workflow_id: message.workflow_id,
          task_id: message.task_id, attempt_id: null, agent_id: parsed.data.agentId,
          workspace_session_id: null, correlation_id: messageId, causation_id: messageId,
          payload: { to_agent_id: message.agent_id, message_id: messageId },
        });
      });
      return { acknowledgement: result.result, replayed: result.replayed };
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/v1/tasks/:taskId/progress", { preHandler: requireScope(storage, "task:claim", { rateLimiter }) }, async (request, reply) => {
    const parsed = Progress.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ detail: parsed.error.message });
    try {
      const { taskId } = request.params as { taskId: string };
      const result = mutate(request, () => {
        const body = parsed.data;
        const attempt = currentProgressAttempt(storage, taskId, body.attemptId, body.fencingToken);
        const task = storage.getTask(taskId)!;
        return append(request, {
          event_type: "task.progress", namespace_id: storage.getAgent(attempt.agent_id)?.namespace_id ?? task.repository_id,
          repository_id: task.repository_id, workflow_id: task.workflow_id, task_id: taskId,
          attempt_id: attempt.attempt_id, agent_id: attempt.agent_id,
          workspace_session_id: attempt.workspace_session_id, correlation_id: null, causation_id: null,
          payload: { summary: body.summary, phase: body.phase, evidence: body.evidence },
        });
      });
      return { progress: result.result, replayed: result.replayed };
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v1/tasks/:taskId/progress", { preHandler: requireScope(storage, "task:read") }, async (request, reply) => {
    const parsed = Page.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ detail: parsed.error.message });
    const { taskId } = request.params as { taskId: string };
    const task = storage.getTask(taskId);
    if (!task) return reply.code(404).send({ detail: "Task does not exist." });
    return {
      ...page(task.repository_id, parsed.data, (event) => event.task_id === taskId && event.event_type === "task.progress"),
      task_status: task.status,
      active_attempts: storage.getActiveAttemptsForTask(taskId).map((attempt) => {
        const lease = storage.getLeaseByAttempt(attempt.attempt_id);
        return { attempt_id: attempt.attempt_id, agent_id: attempt.agent_id, heartbeat_at: attempt.heartbeat_at,
          expires_at: attempt.expires_at, lease_current: !!lease && lease.status === "active" &&
            Date.parse(lease.expires_at) > Date.parse(storage.now()) && Date.parse(attempt.expires_at) > Date.parse(storage.now()) };
      }),
    };
  });

  app.post("/v1/tasks/:taskId/dependencies", { preHandler: requireScope(storage, "task:create", { rateLimiter }) }, async (request, reply) => {
    const parsed = z.object({ dependencies: z.array(id).max(100), expectedDependencies: z.array(id).max(100) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ detail: parsed.error.message });
    try {
      const { taskId } = request.params as { taskId: string };
      const result = mutate(request, () => {
        const task = setTaskDependencies(storage, taskId, parsed.data.dependencies, parsed.data.expectedDependencies);
        append(request, {
          event_type: "task.dependencies_updated", namespace_id: task.repository_id,
          repository_id: task.repository_id, workflow_id: task.workflow_id, task_id: taskId,
          attempt_id: null, agent_id: null, workspace_session_id: null, correlation_id: null, causation_id: null,
          payload: { previous: parsed.data.expectedDependencies, dependencies: task.dependencies },
        });
        return task;
      });
      return { task: result.result, replayed: result.replayed };
    } catch (error) { return sendError(reply, error); }
  });
}

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Task, TaskAttempt } from "@gitamesh/protocol";
import {
  CoordinationEngine,
  canTransitionTask,
  canTransitionAttempt,
  taskNotFound as taskNotFoundError,
  invalidStateTransition,
} from "@gitamesh/core";
import type { StorageAdapter } from "@gitamesh/core";
import { requireScope } from "../auth.js";
import { sendError } from "../problem.js";
import { getIdempotencyKey, withIdempotency } from "../idempotency.js";
import type { EventBroadcaster } from "../events-bus.js";
import type { Metrics } from "../metrics.js";
import type { RateLimiter } from "../rate-limit.js";

const CreateTaskBody = z.object({
  repository_id: z.string().min(1),
  workflow_id: z.string().default("wf_default"),
  parent_task_id: z.string().nullable().default(null),
  title: z.string().min(1),
  description: z.string().default(""),
  priority: z.number().default(0),
  required_capabilities: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  join_policy: z.enum(["all", "any", "quorum"]).default("all"),
  base_sha: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  deadline_at: z.string().datetime().nullable().default(null),
});

const RequiredResourceSchema = z.object({
  resourceType: z.enum([
    "repository",
    "worktree",
    "branch",
    "path",
    "symbol",
    "integration_target",
    "custom",
  ]),
  resourceKey: z.string().min(1),
  mode: z.enum(["read", "write", "exclusive"]),
});

const ClaimBody = z.object({
  agentId: z.string().min(1),
  workspaceSessionId: z.string().min(1),
  requiredResources: z.array(RequiredResourceSchema).default([]),
});

const HeartbeatBody = z.object({
  attemptId: z.string().min(1),
  fencingToken: z.number().int().nonnegative(),
  leaseDurationMs: z.number().int().positive().optional(),
});

const CompleteBody = z.object({
  attemptId: z.string().min(1),
  fencingToken: z.number().int().nonnegative(),
  result: z.record(z.string(), z.unknown()).optional(),
});

const FailBody = z.object({
  attemptId: z.string().min(1),
  fencingToken: z.number().int().nonnegative(),
  error: z.string().min(1),
});

function isClaimConflict(err: unknown): boolean {
  const type = (err as { type?: string } | undefined)?.type ?? "";
  return (
    type.includes("resource-conflict") ||
    type.includes("task-already-claimed") ||
    type.includes("task-not-claimable")
  );
}

export function registerTaskRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  engine: CoordinationEngine,
  broadcaster: EventBroadcaster,
  metrics: Metrics,
  rateLimiter: RateLimiter,
): void {
  app.post(
    "/v1/tasks",
    { preHandler: requireScope(storage, "task:create", { rateLimiter }) },
    async (request, reply) => {
      const parsed = CreateTaskBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).type("application/problem+json").send({
          type: "https://gitamesh.dev/problems/invalid-request",
          title: "Invalid request body",
          status: 400,
          detail: parsed.error.message,
        });
      }
      const idempotencyKey = getIdempotencyKey(request);
      const { result: task, replayed } = withIdempotency<Task>(
        storage,
        "createTask",
        idempotencyKey,
        () => {
          const now = storage.now();
          const created: Task = {
            task_id: storage.generateId("task"),
            workflow_id: parsed.data.workflow_id,
            repository_id: parsed.data.repository_id,
            parent_task_id: parsed.data.parent_task_id,
            title: parsed.data.title,
            description: parsed.data.description,
            status: "pending",
            priority: parsed.data.priority,
            required_capabilities: parsed.data.required_capabilities,
            dependencies: parsed.data.dependencies,
            join_policy: parsed.data.join_policy,
            base_sha: parsed.data.base_sha,
            branch: parsed.data.branch,
            idempotency_key: idempotencyKey ?? null,
            deadline_at: parsed.data.deadline_at,
            created_at: now,
            updated_at: now,
          };
          storage.saveTask(created);
          storage.appendEvent({
            schema_version: 1,
            event_type: "task.created",
            occurred_at: now,
            namespace_id: created.repository_id,
            repository_id: created.repository_id,
            workflow_id: created.workflow_id,
            task_id: created.task_id,
            attempt_id: null,
            agent_id: null,
            workspace_session_id: null,
            correlation_id: null,
            causation_id: null,
            idempotency_key: idempotencyKey ?? null,
            payload: { title: created.title },
            metadata: {},
          });
          return created;
        },
      );
      if (!replayed) broadcaster.notifyNew();
      reply.code(201);
      return { task, replayed };
    },
  );

  app.get(
    "/v1/tasks",
    { preHandler: requireScope(storage, "task:read") },
    async (request) => {
      const query = request.query as { repositoryId?: string; status?: string };
      return {
        tasks: storage.listTasks({
          repositoryId: query.repositoryId,
          status: query.status,
        }),
      };
    },
  );

  app.get(
    "/v1/tasks/:taskId",
    { preHandler: requireScope(storage, "task:read") },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const task = storage.getTask(taskId);
      if (!task) return sendError(reply, taskNotFoundError(taskId));
      return { task };
    },
  );

  app.post(
    "/v1/tasks/:taskId/claim",
    { preHandler: requireScope(storage, "task:claim", { rateLimiter }) },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const parsed = ClaimBody.safeParse(request.body);
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
        const result = engine.claimTask({
          taskId,
          agentId: parsed.data.agentId,
          workspaceSessionId: parsed.data.workspaceSessionId,
          requiredResources: parsed.data.requiredResources,
          idempotencyKey,
        });
        if (!result.replayed) broadcaster.notifyNew();
        return result;
      } catch (err) {
        if (isClaimConflict(err)) metrics.incrementClaimConflicts();
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/v1/tasks/:taskId/heartbeat",
    { preHandler: requireScope(storage, "task:claim", { rateLimiter }) },
    async (request, reply) => {
      const parsed = HeartbeatBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).type("application/problem+json").send({
          type: "https://gitamesh.dev/problems/invalid-request",
          title: "Invalid request body",
          status: 400,
          detail: parsed.error.message,
        });
      }
      try {
        const result = engine.heartbeatAttempt(parsed.data);
        broadcaster.notifyNew();
        return result;
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/v1/tasks/:taskId/complete",
    { preHandler: requireScope(storage, "task:complete", { rateLimiter }) },
    async (request, reply) => {
      const parsed = CompleteBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).type("application/problem+json").send({
          type: "https://gitamesh.dev/problems/invalid-request",
          title: "Invalid request body",
          status: 400,
          detail: parsed.error.message,
        });
      }
      try {
        const result = engine.completeAttempt(parsed.data);
        if (!result.replayed) broadcaster.notifyNew();
        return result;
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/v1/tasks/:taskId/fail",
    { preHandler: requireScope(storage, "task:complete", { rateLimiter }) },
    async (request, reply) => {
      const parsed = FailBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).type("application/problem+json").send({
          type: "https://gitamesh.dev/problems/invalid-request",
          title: "Invalid request body",
          status: 400,
          detail: parsed.error.message,
        });
      }
      try {
        const result = engine.failAttempt(parsed.data);
        if (!result.replayed) broadcaster.notifyNew();
        return result;
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/v1/tasks/:taskId/cancel",
    { preHandler: requireScope(storage, "task:complete", { rateLimiter }) },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      try {
        const result = storage.transaction(() => {
          const task = storage.getTask(taskId);
          if (!task) throw taskNotFoundError(taskId);
          if (!canTransitionTask(task.status, "cancelled")) {
            throw invalidStateTransition({
              entity: "Task",
              entityId: taskId,
              from: task.status,
              to: "cancelled",
            });
          }
          const now = storage.now();
          for (const attempt of storage.getActiveAttemptsForTask(taskId)) {
            if (canTransitionAttempt(attempt.status, "cancelled")) {
              const cancelledAttempt: TaskAttempt = {
                ...attempt,
                status: "cancelled",
                completed_at: now,
                error: "task cancelled",
              };
              storage.saveAttempt(cancelledAttempt);
              storage.releaseResourceClaimsForAttempt(attempt.attempt_id);
              const lease = storage.getLeaseByAttempt(attempt.attempt_id);
              if (lease) {
                storage.saveLease({ ...lease, status: "released", released_at: now });
              }
            }
          }
          const updated: Task = { ...task, status: "cancelled", updated_at: now };
          storage.saveTask(updated);
          storage.appendEvent({
            schema_version: 1,
            event_type: "task.cancelled",
            occurred_at: now,
            namespace_id: updated.repository_id,
            repository_id: updated.repository_id,
            workflow_id: updated.workflow_id,
            task_id: updated.task_id,
            attempt_id: null,
            agent_id: null,
            workspace_session_id: null,
            correlation_id: null,
            causation_id: null,
            idempotency_key: null,
            payload: {},
            metadata: {},
          });
          return updated;
        });
        broadcaster.notifyNew();
        return { task: result };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}

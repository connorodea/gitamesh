import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Task, TaskAttempt, TaskNote, TaskRevision } from "@gitamesh/protocol";
import { TASK_UPDATABLE_FIELDS } from "@gitamesh/protocol";
import {
  CoordinationEngine,
  assertValidDependencies,
  dependencyState,
  canTransitionTask,
  canTransitionAttempt,
  taskNotFound as taskNotFoundError,
  invalidStateTransition,
} from "@gitamesh/core";
import type { StorageAdapter } from "@gitamesh/core";
import { requireScope } from "../auth.js";
import { sendError } from "../problem.js";
import { emitEvent, requireAgent, sendInvalidRequest } from "../collab.js";
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

const UpdateTaskBody = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    priority: z.number().optional(),
    branch: z.string().nullable().optional(),
    base_sha: z.string().nullable().optional(),
    dependencies: z.array(z.string().min(1)).optional(),
    /** Agent id recorded on the revision as who made the change. */
    updated_by: z.string().min(1).optional(),
  })
  .strict();

const AddNoteBody = z.object({
  agent_id: z.string().min(1),
  body: z.string().min(1).max(65_536),
});

/** Statuses in which a task is still waiting to be picked up. */
const WAITING_STATUSES: ReadonlySet<Task["status"]> = new Set(["pending", "queued", "blocked"]);

interface TaskOwner {
  agent_id: string;
  display_name: string;
  attempt_id: string;
  heartbeat_at: string;
  expires_at: string;
}

/**
 * A task as the list/show routes return it: the stored record plus who
 * holds it and whether its dependencies let it be claimed. `readiness` is
 * null once the task is no longer waiting (running, completed, ...).
 */
interface TaskView extends Task {
  owner: TaskOwner | null;
  readiness: "ready" | "blocked" | null;
  blocked_by: string[];
}

function describeTasks(storage: StorageAdapter, tasks: Task[]): TaskView[] {
  const attemptByTask = new Map<string, TaskAttempt>();
  for (const attempt of storage.listActiveAttempts()) {
    attemptByTask.set(attempt.task_id, attempt);
  }
  return tasks.map((task) => {
    const attempt = attemptByTask.get(task.task_id);
    const owner: TaskOwner | null = attempt
      ? {
          agent_id: attempt.agent_id,
          display_name: storage.getAgent(attempt.agent_id)?.display_name ?? attempt.agent_id,
          attempt_id: attempt.attempt_id,
          heartbeat_at: attempt.heartbeat_at,
          expires_at: attempt.expires_at,
        }
      : null;
    if (!WAITING_STATUSES.has(task.status)) {
      return { ...task, owner, readiness: null, blocked_by: [] };
    }
    const deps = dependencyState(storage, task);
    return {
      ...task,
      owner,
      readiness: deps.ready ? "ready" : "blocked",
      blocked_by: deps.ready ? [] : deps.waitingOn.map((dep) => dep.task_id),
    };
  });
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

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
      try {
        assertValidDependencies(storage, {
          repositoryId: parsed.data.repository_id,
          dependencies: parsed.data.dependencies,
        });
      } catch (err) {
        return sendError(reply, err);
      }
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
      const query = request.query as {
        repositoryId?: string;
        status?: string;
        /** Only tasks this agent currently holds. */
        agentId?: string;
        /** "true": only tasks nobody holds that are still waiting to be claimed. */
        unclaimed?: string;
      };
      let tasks = describeTasks(
        storage,
        storage.listTasks({ repositoryId: query.repositoryId, status: query.status }),
      );
      if (query.agentId) {
        tasks = tasks.filter((task) => task.owner?.agent_id === query.agentId);
      }
      if (query.unclaimed === "true") {
        tasks = tasks.filter((task) => task.owner === null && WAITING_STATUSES.has(task.status));
      }
      return { tasks };
    },
  );

  app.get(
    "/v1/tasks/:taskId",
    { preHandler: requireScope(storage, "task:read") },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const task = storage.getTask(taskId);
      if (!task) return sendError(reply, taskNotFoundError(taskId));
      return {
        task: describeTasks(storage, [task])[0],
        notes: storage.listTaskNotes(taskId),
        revisions: storage.listTaskRevisions(taskId),
      };
    },
  );

  app.patch(
    "/v1/tasks/:taskId",
    { preHandler: requireScope(storage, "task:create", { rateLimiter }) },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const parsed = UpdateTaskBody.safeParse(request.body);
      if (!parsed.success) return sendInvalidRequest(reply, parsed.error);
      try {
        const result = storage.transaction(() => {
          const task = storage.getTask(taskId);
          if (!task) throw taskNotFoundError(taskId);
          if (parsed.data.updated_by) requireAgent(storage, parsed.data.updated_by);

          const changes: TaskRevision["changes"] = {};
          const updated: Task = { ...task };
          for (const field of TASK_UPDATABLE_FIELDS) {
            const next = parsed.data[field];
            if (next === undefined || sameValue(task[field], next)) continue;
            changes[field] = { old: task[field], new: next };
            (updated as Record<string, unknown>)[field] = next;
          }
          if (Object.keys(changes).length === 0) {
            return { task, revision: null };
          }

          if (changes.dependencies) {
            if (!WAITING_STATUSES.has(task.status)) {
              throw invalidStateTransition({
                entity: "Task",
                entityId: taskId,
                from: task.status,
                to: task.status,
                detail: `Task ${taskId} is "${task.status}"; dependencies can change only while a task is pending, queued or blocked.`,
              });
            }
            assertValidDependencies(storage, {
              taskId,
              repositoryId: task.repository_id,
              dependencies: updated.dependencies,
            });
          }

          const now = storage.now();
          updated.updated_at = now;
          storage.saveTask(updated);
          const revision: TaskRevision = {
            revision_id: storage.generateId("rev"),
            task_id: taskId,
            changed_by: parsed.data.updated_by ?? null,
            changed_at: now,
            changes,
          };
          storage.appendTaskRevision(revision);
          emitEvent(storage, {
            event_type: "task.updated",
            namespace_id: task.repository_id,
            repository_id: task.repository_id,
            workflow_id: task.workflow_id,
            task_id: taskId,
            agent_id: revision.changed_by,
            payload: { revision_id: revision.revision_id, fields: Object.keys(changes) },
          });
          return { task: updated, revision };
        });
        if (result.revision) broadcaster.notifyNew();
        return { task: describeTasks(storage, [result.task])[0], revision: result.revision };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/v1/tasks/:taskId/notes",
    { preHandler: requireScope(storage, "task:claim", { rateLimiter }) },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const parsed = AddNoteBody.safeParse(request.body);
      if (!parsed.success) return sendInvalidRequest(reply, parsed.error);
      try {
        const note = storage.transaction(() => {
          const task = storage.getTask(taskId);
          if (!task) throw taskNotFoundError(taskId);
          requireAgent(storage, parsed.data.agent_id);
          const created: TaskNote = {
            note_id: storage.generateId("note"),
            task_id: taskId,
            agent_id: parsed.data.agent_id,
            body: parsed.data.body,
            created_at: storage.now(),
          };
          storage.appendTaskNote(created);
          emitEvent(storage, {
            event_type: "task.note_added",
            namespace_id: task.repository_id,
            repository_id: task.repository_id,
            workflow_id: task.workflow_id,
            task_id: taskId,
            agent_id: created.agent_id,
            payload: { note_id: created.note_id },
          });
          return created;
        });
        broadcaster.notifyNew();
        reply.code(201);
        return { note };
      } catch (err) {
        return sendError(reply, err);
      }
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

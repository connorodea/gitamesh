import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { GitameshError } from "@gitamesh/protocol";
import type { ResourceClaim, Task, TaskAttempt } from "@gitamesh/protocol";
import { CoordinationEngine, dependencyState } from "@gitamesh/core";
import type { ClaimTaskResult, StorageAdapter } from "@gitamesh/core";
import { forbidden, requireScope, unauthorized, verifyToken } from "../auth.js";
import { requireAgent, sendInvalidRequest } from "../collab.js";
import { getIdempotencyKey } from "../idempotency.js";
import type { EventBroadcaster } from "../events-bus.js";
import type { Metrics } from "../metrics.js";
import { sendError } from "../problem.js";
import type { RateLimiter } from "../rate-limit.js";

export const MAX_QUEUE_WAIT_MS = 25_000;

const QueueClaimBody = z.object({
  repositoryId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  workspaceSessionId: z.string().trim().min(1),
  waitMs: z.number().int().min(0).max(MAX_QUEUE_WAIT_MS).default(0),
  requiredResources: z.array(z.object({
    resourceType: z.enum(["repository", "worktree", "branch", "path", "symbol", "integration_target", "custom"]),
    resourceKey: z.string().min(1),
    mode: z.enum(["read", "write", "exclusive"]),
  }).strict()).default([]),
}).strict();

interface QueueClaimSuccess {
  task: Task;
  attempt: TaskAttempt;
  fencingToken: number;
  resourceClaims: ResourceClaim[];
  replayed: boolean;
  waitedMs: number;
}

interface QueueClaimEmpty {
  task: null;
  attempt: null;
  fencingToken: null;
  waitedMs: number;
  reason: "no_ready_task" | "timeout";
}

export type QueueClaimResponse = QueueClaimSuccess | QueueClaimEmpty;

interface SavedQueueClaim {
  requestHash: string;
  taskId: string;
  claim: ClaimTaskResult;
}

function queueError(status: number, code: string, title: string, detail: string): GitameshError {
  return new GitameshError({ type: `https://gitamesh.dev/problems/${code}`, status, title, detail });
}

function isUnavailable(error: unknown): boolean {
  if (!(error instanceof GitameshError) || error.status !== 409) return false;
  return ["resource-conflict", "task-already-claimed", "task-not-claimable", "task-dependencies-incomplete"]
    .some((code) => error.type.endsWith(`/${code}`));
}

/**
 * The queue is a view over existing tasks. This route never creates another
 * job record, grants execution permissions, or runs task text as a command.
 * A ready task is acquired by the existing fenced CoordinationEngine.
 */
export function registerQueueRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  engine: CoordinationEngine,
  broadcaster: EventBroadcaster,
  metrics: Metrics,
  rateLimiter: RateLimiter,
): void {
  const pending = new Set<() => void>();
  let closing = false;

  // preClose runs before Fastify waits for active connections to finish.
  app.addHook("preClose", async () => {
    closing = true;
    for (const stop of [...pending]) stop();
  });

  app.post("/v1/queue/claim", {
    preHandler: [
      requireScope(storage, "task:read"),
      requireScope(storage, "task:claim", { rateLimiter }),
    ],
  }, async (request, reply) => {
    const parsed = QueueClaimBody.safeParse(request.body);
    if (!parsed.success) return sendInvalidRequest(reply, parsed.error);
    const body = parsed.data;
    // Unlike the legacy WebSocket auth fallback, a queue credential may
    // never appear in a URL (where request logs and browser history retain it).
    const rawToken = request.headers.authorization?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
    if (!rawToken) return sendError(reply, unauthorized("Use an Authorization: Bearer <token> header."));

    const started = Date.now();
    const key = getIdempotencyKey(request);
    const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    // A key cannot replay another token's claim or another worker/session's
    // claim. Hash the tuple rather than concatenating user-controlled fields.
    const cacheKey = key === undefined ? undefined : `queueClaim:${createHash("sha256")
      .update(JSON.stringify([request.authTokenId, body.repositoryId, body.agentId, body.workspaceSessionId, key]))
      .digest("hex")}`;
    const empty = (reason: QueueClaimEmpty["reason"]): QueueClaimEmpty => ({
      task: null, attempt: null, fencingToken: null, waitedMs: Date.now() - started, reason,
    });
    const unavailable = () => queueError(503, "queue-stopping", "Queue is stopping", "The daemon is shutting down; retry on an available daemon.");

    const authorize = () => {
      const token = verifyToken(storage, rawToken);
      if (!token) throw unauthorized("Token is invalid, expired, or revoked.");
      for (const scope of ["task:read", "task:claim"] as const) {
        if (!token.scopes.includes(scope) && !token.scopes.includes("admin")) {
          throw forbidden(`Token no longer has required scope "${scope}".`, scope);
        }
      }
    };

    const tryClaim = (): QueueClaimSuccess | null => storage.transaction(() => {
      if (closing) throw unavailable();
      authorize();
      const agent = requireAgent(storage, body.agentId);
      if (agent.status === "revoked") {
        throw queueError(403, "agent-revoked", "Agent is revoked", "A revoked agent cannot acquire or replay a queue claim.");
      }
      const cached = cacheKey ? storage.lookupIdempotentResult<SavedQueueClaim>(cacheKey) : undefined;
      if (cached) {
        if (cached.requestHash !== requestHash) {
          throw queueError(409, "idempotency-conflict", "Idempotency key already used", "This Idempotency-Key was used with different queue claim parameters.");
        }
        const attempt = storage.getAttempt(cached.claim.attempt.attempt_id);
        const lease = attempt && storage.getLeaseByAttempt(attempt.attempt_id);
        const task = storage.getTask(cached.taskId);
        if (!attempt || !task || task.status !== "running" ||
            (attempt.status !== "running" && attempt.status !== "leased") ||
            !lease || lease.status !== "active" ||
            attempt.fencing_token !== cached.claim.fencingToken ||
            Math.min(new Date(attempt.expires_at).getTime(), new Date(lease.expires_at).getTime()) <= new Date(storage.now()).getTime()) {
          throw queueError(409, "queue-claim-expired", "The previous claim is no longer active", "This key belongs to an ended or expired claim. Use a new Idempotency-Key for a new queue claim.");
        }
        return {
          task, attempt, fencingToken: cached.claim.fencingToken, replayed: true,
          resourceClaims: storage.getActiveResourceClaims(body.repositoryId).filter((claim) => claim.attempt_id === attempt.attempt_id),
          waitedMs: Date.now() - started,
        };
      }

      if (agent.status === "draining") {
        throw queueError(409, "agent-draining", "Agent is draining", "A draining agent may finish its existing claims but cannot acquire new queue work.");
      }

      const capabilities = new Set(agent.capabilities);
      const candidates = storage.listTasks({ repositoryId: body.repositoryId })
        .filter((task) => (task.status === "pending" || task.status === "queued") &&
          task.required_capabilities.every((capability) => capabilities.has(capability)))
        .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id));

      for (const task of candidates) {
        if (!dependencyState(storage, task).ready) continue;
        // Authorization may have expired during a slow storage scan. Verify
        // immediately before the mutation, in the same transaction.
        authorize();
        try {
          const claim = engine.claimTask({
            taskId: task.task_id,
            agentId: body.agentId,
            workspaceSessionId: body.workspaceSessionId,
            requiredResources: body.requiredResources,
          });
          if (cacheKey) storage.recordIdempotentResult(cacheKey, { requestHash, taskId: task.task_id, claim } satisfies SavedQueueClaim);
          return { ...claim, task: storage.getTask(task.task_id)!, waitedMs: Date.now() - started };
        } catch (error) {
          if (!isUnavailable(error)) throw error;
          metrics.incrementClaimConflicts();
          // Another worker may win the task, or a resource may be busy.
          // Keep looking; every successful acquisition still uses the engine.
        }
      }
      return null;
    });

    try {
      const initial = tryClaim();
      if (initial) {
        if (!initial.replayed) broadcaster.notifyNew();
        return initial;
      }
      if (body.waitMs === 0) return empty("no_ready_task");

      return await new Promise<QueueClaimResponse>((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result?: QueueClaimResponse, error?: unknown) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          unsubscribe();
          pending.delete(onShutdown);
          reply.raw.off("close", onClose);
          if (error) reject(error);
          else {
            resolve(result!);
            // Unsubscribe before broadcasting: claim events can synchronously
            // wake another waiter and must never re-enter this request.
            if (result?.task && !result.replayed) broadcaster.notifyNew();
          }
        };
        const onShutdown = () => finish(undefined, unavailable());
        const onClose = () => finish(empty("timeout"));
        const check = () => {
          if (settled) return;
          if (request.raw.aborted || reply.raw.destroyed) return onClose();
          try {
            const claim = tryClaim();
            if (claim) finish(claim);
          } catch (error) {
            finish(undefined, error);
          }
        };
        unsubscribe = broadcaster.onChange(check);
        pending.add(onShutdown);
        reply.raw.once("close", onClose);
        timer = setTimeout(() => {
          // Also rescan at the boundary. Durable storage remains authoritative
          // if a cross-process wake signal was delayed or dropped.
          check();
          if (!settled) finish(empty("timeout"));
        }, Math.max(0, body.waitMs - (Date.now() - started)));
        // Subscribe first, then recheck: changes between the initial scan and
        // subscription cannot strand a waiting worker until its timeout.
        check();
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

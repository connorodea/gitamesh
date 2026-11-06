import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Task } from "@gitamesh/protocol";
import {
  CoordinationEngine,
  MAX_SUBTASKS_PER_DISPATCH,
  collectSubtaskResults,
  dispatchSubtasks,
  unsettledSubtaskIds,
  waitOutcome,
  taskNotFound as taskNotFoundError,
} from "@gitamesh/core";
import type { FanInSummary, StorageAdapter, WaitWake } from "@gitamesh/core";
import { requireScope } from "../auth.js";
import { sendError } from "../problem.js";
import { sendInvalidRequest } from "../collab.js";
import { getIdempotencyKey, withIdempotency } from "../idempotency.js";
import type { EventBroadcaster } from "../events-bus.js";
import type { RateLimiter } from "../rate-limit.js";

/** Long-poll cap. Keeps one wait under Node's default 300 s request timeout. */
export const MAX_WAIT_MS = 120_000;

const SubtaskSpecBody = z
  .object({
    title: z.string().min(1),
    description: z.string().default(""),
    priority: z.number().optional(),
    required_capabilities: z.array(z.string()).default([]),
    branch: z.string().nullable().default(null),
    base_sha: z.string().nullable().default(null),
  })
  .strict();

const DispatchBody = z
  .object({
    subtasks: z.array(SubtaskSpecBody).min(1).max(MAX_SUBTASKS_PER_DISPATCH),
    workflow_id: z.string().min(1).optional(),
    deadline_at: z.string().datetime().nullable().default(null),
  })
  .strict();

const WaitBody = z
  .object({
    until: z.enum(["all", "any"]).default("all"),
    fail_fast: z.boolean().default(false),
    timeout_ms: z.number().int().min(0).max(MAX_WAIT_MS).default(30_000),
  })
  .strict();

interface WaitResponse {
  woke: WaitWake | "timeout";
  waited_ms: number;
  summary: FanInSummary;
}

export function registerOrchestrationRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  engine: CoordinationEngine,
  broadcaster: EventBroadcaster,
  rateLimiter: RateLimiter,
): void {
  app.post(
    "/v1/tasks/:taskId/dispatch",
    { preHandler: requireScope(storage, "task:create", { rateLimiter }) },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const parsed = DispatchBody.safeParse(request.body ?? {});
      if (!parsed.success) return sendInvalidRequest(reply, parsed.error);
      const idempotencyKey = getIdempotencyKey(request);
      try {
        const { result, replayed } = storage.transaction(() =>
          withIdempotency(storage, `dispatch:${taskId}`, idempotencyKey, () =>
            dispatchSubtasks(storage, {
              parentTaskId: taskId,
              subtasks: parsed.data.subtasks,
              workflowId: parsed.data.workflow_id,
              deadlineAt: parsed.data.deadline_at,
              idempotencyKey,
            }),
          ),
        );
        if (!replayed) broadcaster.notifyNew();
        reply.code(201);
        return { parent: result.parent, subtasks: result.subtasks, replayed };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/v1/tasks/:taskId/subtasks",
    { preHandler: requireScope(storage, "task:read") },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      try {
        return collectSubtaskResults(storage, taskId);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/v1/tasks/:taskId/wait",
    { preHandler: requireScope(storage, "task:read") },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const parsed = WaitBody.safeParse(request.body ?? {});
      if (!parsed.success) return sendInvalidRequest(reply, parsed.error);
      if (!storage.getTask(taskId)) return sendError(reply, taskNotFoundError(taskId));
      const policy = { until: parsed.data.until, failFast: parsed.data.fail_fast };
      const started = Date.now();
      const respond = (woke: WaitResponse["woke"], summary: FanInSummary): WaitResponse => ({
        woke,
        waited_ms: Date.now() - started,
        summary,
      });

      const initial = collectSubtaskResults(storage, taskId);
      const initialWake = waitOutcome(initial, policy);
      if (initialWake) return respond(initialWake, initial);

      // Wake on the broadcaster's change signal rather than polling storage.
      return new Promise<WaitResponse>((resolve) => {
        let settled = false;
        const finish = (woke: WaitResponse["woke"], summary: FanInSummary) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          reply.raw.off("close", onClose);
          resolve(respond(woke, summary));
        };
        const unsubscribe = broadcaster.onChange(() => {
          const summary = collectSubtaskResults(storage, taskId);
          const wake = waitOutcome(summary, policy);
          if (wake) finish(wake, summary);
        });
        const timer = setTimeout(() => finish("timeout", collectSubtaskResults(storage, taskId)), parsed.data.timeout_ms);
        timer.unref?.();
        // A client that hangs up stops the wait so the listener does not leak.
        const onClose = () => finish("timeout", initial);
        reply.raw.on("close", onClose);
      });
    },
  );

  app.post(
    "/v1/tasks/:taskId/cancel-subtasks",
    { preHandler: requireScope(storage, "task:complete", { rateLimiter }) },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      try {
        const cancelled: Task[] = [];
        for (const childId of unsettledSubtaskIds(storage, taskId)) {
          const result = engine.cancelTask({ taskId: childId });
          cancelled.push(result.task, ...result.cancelledChildren);
        }
        if (cancelled.length > 0) broadcaster.notifyNew();
        return { cancelled, summary: collectSubtaskResults(storage, taskId) };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}

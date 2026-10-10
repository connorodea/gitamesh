import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { PathLock } from "@gitamesh/protocol";
import { GitameshError, pathLockConflict, taskNotFound } from "@gitamesh/protocol";
import { canonicalizePathGlob, pathGlobsOverlap } from "@gitamesh/core";
import type { StorageAdapter } from "@gitamesh/core";
import { requireScope } from "../auth.js";
import { sendError } from "../problem.js";
import { emitEvent, requireAgent, sendInvalidRequest } from "../collab.js";
import type { EventBroadcaster } from "../events-bus.js";
import type { RateLimiter } from "../rate-limit.js";

const DEFAULT_TTL_SECONDS = 900;
const MAX_TTL_SECONDS = 86_400;
const ttlSchema = z.number().int().positive().max(MAX_TTL_SECONDS);

const AcquireBody = z.object({
  agent_id: z.string().min(1),
  repository_id: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  task_id: z.string().min(1).nullable().default(null),
  ttl_seconds: ttlSchema.default(DEFAULT_TTL_SECONDS),
});

const HeartbeatBody = z.object({
  agent_id: z.string().min(1),
  ttl_seconds: ttlSchema.optional(),
});

const ReleaseBody = z.object({ agent_id: z.string().min(1) });

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function isActive(lock: PathLock, nowIso: string): boolean {
  return lock.released_at === null && lock.expires_at > nowIso;
}

function lockProblem(slug: string, title: string, status: number, detail: string): GitameshError {
  return new GitameshError({
    type: `https://gitamesh.dev/problems/${slug}`,
    title,
    status,
    detail,
  });
}

/** The lock as returned to clients: the stored record plus the holder's name. */
function describeLock(storage: StorageAdapter, lock: PathLock) {
  return {
    ...lock,
    holder_display_name: storage.getAgent(lock.agent_id)?.display_name ?? lock.agent_id,
  };
}

/**
 * Loads a lock for heartbeat/release and checks the caller holds it.
 * Throws the matching problem otherwise.
 */
function requireHeldLock(storage: StorageAdapter, lockId: string, agentId: string): PathLock {
  const lock = storage.getPathLock(lockId);
  if (!lock) {
    throw lockProblem("lock-not-found", "Lock not found", 404, `No path lock exists with id ${lockId}.`);
  }
  if (lock.agent_id !== agentId) {
    throw lockProblem(
      "not-lock-holder",
      "Not the lock holder",
      403,
      `Lock ${lockId} is held by ${lock.agent_id}, not ${agentId}.`,
    );
  }
  if (lock.released_at !== null) {
    throw lockProblem(
      "lock-already-released",
      "Lock already released",
      409,
      `Lock ${lockId} was released at ${lock.released_at}.`,
    );
  }
  return lock;
}

/**
 * Advisory path locks between agents. Released and expired locks stay in
 * storage as history; there is no delete route.
 */
export function registerLockRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  broadcaster: EventBroadcaster,
  rateLimiter: RateLimiter,
): void {
  app.post(
    "/v1/locks",
    { preHandler: requireScope(storage, "task:claim", { rateLimiter }) },
    async (request, reply) => {
      const parsed = AcquireBody.safeParse(request.body);
      if (!parsed.success) return sendInvalidRequest(reply, parsed.error);
      try {
        const lock = storage.transaction(() => {
          const agent = requireAgent(storage, parsed.data.agent_id);
          if (parsed.data.task_id && !storage.getTask(parsed.data.task_id)) {
            throw taskNotFound(parsed.data.task_id);
          }
          const paths = [...new Set(parsed.data.paths.map(canonicalizePathGlob))];
          const now = storage.now();

          // All-or-nothing: one overlap with another agent's live lock
          // refuses the whole request. An agent never conflicts with itself.
          for (const existing of storage.listUnreleasedPathLocks(parsed.data.repository_id)) {
            if (existing.agent_id === agent.agent_id || !isActive(existing, now)) continue;
            for (const path of paths) {
              const conflictingPath = existing.paths.find((held) => pathGlobsOverlap(path, held));
              if (conflictingPath !== undefined) {
                throw pathLockConflict({
                  path,
                  conflictingPath,
                  lockId: existing.lock_id,
                  holderAgentId: existing.agent_id,
                  holderDisplayName:
                    storage.getAgent(existing.agent_id)?.display_name ?? existing.agent_id,
                  expiresAt: existing.expires_at,
                });
              }
            }
          }

          const created: PathLock = {
            lock_id: storage.generateId("lock"),
            repository_id: parsed.data.repository_id,
            agent_id: agent.agent_id,
            task_id: parsed.data.task_id,
            paths,
            acquired_at: now,
            heartbeat_at: now,
            expires_at: addSeconds(now, parsed.data.ttl_seconds),
            released_at: null,
          };
          storage.savePathLock(created);
          emitEvent(storage, {
            event_type: "lock.acquired",
            namespace_id: created.repository_id,
            repository_id: created.repository_id,
            task_id: created.task_id,
            agent_id: created.agent_id,
            payload: { lock_id: created.lock_id, paths },
          });
          return created;
        });
        broadcaster.notifyNew();
        reply.code(201);
        return { lock: describeLock(storage, lock) };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/v1/locks",
    { preHandler: requireScope(storage, "repository:read") },
    async (request) => {
      const query = request.query as { repositoryId?: string; agentId?: string };
      const now = storage.now();
      const locks = storage
        .listUnreleasedPathLocks(query.repositoryId)
        .filter((lock) => isActive(lock, now))
        .filter((lock) => !query.agentId || lock.agent_id === query.agentId)
        .map((lock) => describeLock(storage, lock));
      return { locks };
    },
  );

  app.post(
    "/v1/locks/:lockId/heartbeat",
    { preHandler: requireScope(storage, "task:claim", { rateLimiter }) },
    async (request, reply) => {
      const { lockId } = request.params as { lockId: string };
      const parsed = HeartbeatBody.safeParse(request.body);
      if (!parsed.success) return sendInvalidRequest(reply, parsed.error);
      try {
        const lock = storage.transaction(() => {
          const held = requireHeldLock(storage, lockId, parsed.data.agent_id);
          const now = storage.now();
          if (!isActive(held, now)) {
            throw lockProblem(
              "lock-expired",
              "Lock expired",
              409,
              `Lock ${lockId} expired at ${held.expires_at}; acquire it again.`,
            );
          }
          // Without an explicit TTL, renew for the same span as the last one.
          const previousTtlSeconds = Math.max(
            1,
            Math.round(
              (new Date(held.expires_at).getTime() - new Date(held.heartbeat_at).getTime()) / 1000,
            ),
          );
          const renewed: PathLock = {
            ...held,
            heartbeat_at: now,
            expires_at: addSeconds(now, parsed.data.ttl_seconds ?? previousTtlSeconds),
          };
          storage.savePathLock(renewed);
          return renewed;
        });
        return { lock: describeLock(storage, lock) };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/v1/locks/:lockId/release",
    { preHandler: requireScope(storage, "task:claim", { rateLimiter }) },
    async (request, reply) => {
      const { lockId } = request.params as { lockId: string };
      const parsed = ReleaseBody.safeParse(request.body);
      if (!parsed.success) return sendInvalidRequest(reply, parsed.error);
      try {
        const lock = storage.transaction(() => {
          const held = requireHeldLock(storage, lockId, parsed.data.agent_id);
          const released: PathLock = { ...held, released_at: storage.now() };
          storage.savePathLock(released);
          emitEvent(storage, {
            event_type: "lock.released",
            namespace_id: released.repository_id,
            repository_id: released.repository_id,
            task_id: released.task_id,
            agent_id: released.agent_id,
            payload: { lock_id: released.lock_id },
          });
          return released;
        });
        broadcaster.notifyNew();
        return { lock: describeLock(storage, lock) };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}

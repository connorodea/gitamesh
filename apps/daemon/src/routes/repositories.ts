import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Repository } from "@gitamesh/protocol";
import type { StorageAdapter } from "@gitamesh/core";
import { requireScope } from "../auth.js";
import { sendError } from "../problem.js";
import { emitEvent, sendInvalidRequest } from "../collab.js";
import type { EventBroadcaster } from "../events-bus.js";
import type { RateLimiter } from "../rate-limit.js";

const RegisterRepositoryBody = z.object({
  namespace_id: z.string().min(1).default("default"),
  display_name: z.string().min(1),
  git_common_dir: z.string().min(1),
  default_branch: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

/** The id the CLI derived for this clone (`gitamesh repo status`), if it sent one. */
function localRepositoryId(metadata: Record<string, unknown>): string | undefined {
  const id = metadata.local_repository_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The already-registered repository this request names, if any. A local id
 * is the stronger identity (it survives moving the clone), so it is the
 * only key consulted when the client sends one; `git_common_dir` is the
 * fallback, scoped to the namespace.
 */
function findRegistered(
  storage: StorageAdapter,
  body: z.infer<typeof RegisterRepositoryBody>,
): Repository | undefined {
  const localId = localRepositoryId(body.metadata);
  if (localId) return storage.getRepository(localId);
  return storage
    .listRepositories()
    .find((r) => r.namespace_id === body.namespace_id && r.git_common_dir === body.git_common_dir);
}

export function registerRepositoryRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  broadcaster: EventBroadcaster,
  rateLimiter: RateLimiter,
): void {
  // Registration is naturally idempotent (no Idempotency-Key needed):
  // re-registering returns the stored record unchanged with `replayed: true`.
  app.post(
    "/v1/repositories",
    { preHandler: requireScope(storage, "repository:write", { rateLimiter }) },
    async (request, reply) => {
      const parsed = RegisterRepositoryBody.safeParse(request.body);
      if (!parsed.success) return sendInvalidRequest(reply, parsed.error);
      try {
        const { repository, replayed } = storage.transaction(() => {
          const existing = findRegistered(storage, parsed.data);
          if (existing) return { repository: existing, replayed: true };

          const created: Repository = {
            repository_id: localRepositoryId(parsed.data.metadata) ?? storage.generateId("repo"),
            namespace_id: parsed.data.namespace_id,
            display_name: parsed.data.display_name,
            git_common_dir: parsed.data.git_common_dir,
            default_branch: parsed.data.default_branch,
            created_at: storage.now(),
            metadata: parsed.data.metadata,
          };
          storage.saveRepository(created);
          emitEvent(storage, {
            event_type: "repository.registered",
            namespace_id: created.namespace_id,
            repository_id: created.repository_id,
            payload: { display_name: created.display_name, default_branch: created.default_branch },
          });
          return { repository: created, replayed: false };
        });
        if (!replayed) broadcaster.notifyNew();
        reply.code(replayed ? 200 : 201);
        return { repository, replayed };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/v1/repositories",
    { preHandler: requireScope(storage, "repository:read") },
    async () => {
      return { repositories: storage.listRepositories() };
    },
  );
}

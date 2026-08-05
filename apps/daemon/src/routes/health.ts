import type { FastifyInstance } from "fastify";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import type { Metrics } from "../metrics.js";
import { renderPrometheus } from "../metrics.js";
import { requireScope } from "../auth.js";

export function registerHealthRoutes(
  app: FastifyInstance,
  storage: SqliteStorageAdapter,
  metrics: Metrics,
): void {
  // No auth required — used by load balancers / orchestrators.
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      const ok = storage.ping();
      if (!ok) {
        reply.code(503);
        return { status: "not_ready" };
      }
      return { status: "ok" };
    } catch {
      reply.code(503);
      return { status: "not_ready" };
    }
  });

  // Gated behind `admin` — task counts/labels could leak repository
  // structure to an unauthenticated caller otherwise.
  app.get(
    "/metrics",
    { preHandler: requireScope(storage, "admin") },
    async (_request, reply) => {
      reply.type("text/plain; version=0.0.4");
      return renderPrometheus(storage, metrics);
    },
  );
}

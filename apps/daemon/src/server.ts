import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { CoordinationEngine } from "@gitamesh/core";
import type { StorageAdapter } from "@gitamesh/core";
import { Metrics } from "./metrics.js";
import { EventBroadcaster } from "./events-bus.js";
import { RateLimiter } from "./rate-limit.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerClaimRoutes } from "./routes/claims.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerLockRoutes } from "./routes/locks.js";

export interface BuildServerOptions {
  storage: StorageAdapter;
  logger?: boolean | Record<string, unknown>;
  /** Rolling-window mutating-request cap per token; default 60/min (see rate-limit.ts). */
  rateLimitPerMinute?: number;
}

export interface BuiltServer {
  app: FastifyInstance;
  metrics: Metrics;
  broadcaster: EventBroadcaster;
  /** Runs one lease-expiration sweep and folds the count into metrics. Call on an interval from index.ts. */
  sweepExpiredLeases: () => void;
}

/**
 * Builds (but does not `listen()`) the Fastify daemon. Split out from
 * `index.ts` so tests can drive it via `.inject()` / a real ephemeral
 * port without going through CLI arg parsing or process-level concerns.
 */
export function buildServer(options: BuildServerOptions): BuiltServer {
  const { storage } = options;
  const engine = new CoordinationEngine(storage);
  const metrics = new Metrics();
  const broadcaster = new EventBroadcaster(storage, metrics);
  const rateLimiter = new RateLimiter(options.rateLimitPerMinute ?? 60);

  const app = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL ?? "info",
      // Never log secrets: redact Authorization headers outright. Request
      // ids are included automatically by Fastify's default logger.
      redact: ["req.headers.authorization"],
    },
  });

  app.addHook("onRequest", async (request) => {
    request.log.info(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
      },
      "request received",
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        reqId: request.id,
        statusCode: reply.statusCode,
        tokenId: request.authTokenId,
      },
      "request completed",
    );
  });

  app.setErrorHandler((error: Error, _request, reply) => {
    app.log.error({ err: error.message }, "unhandled route error");
    reply.code(500).type("application/problem+json").send({
      type: "https://gitamesh.dev/problems/internal-error",
      title: "Internal Server Error",
      status: 500,
      detail: error.message,
    });
  });

  // IMPORTANT: @fastify/websocket's `onRoute` hook (which makes
  // `{ websocket: true }` routes actually intercept the upgrade) is only
  // attached once the plugin's registration finishes booting. Fastify's
  // plugin boot (avvio) is asynchronous, so routes added synchronously
  // right after a bare `app.register(websocketPlugin)` call can be
  // registered BEFORE that hook exists — the route then silently falls
  // back to being treated as a normal HTTP handler. `.after()` guarantees
  // everything inside it runs only once the websocket plugin has fully
  // booted.
  app.register(websocketPlugin).after(() => {
    registerHealthRoutes(app, storage, metrics);
    registerAgentRoutes(app, storage, broadcaster, rateLimiter);
    registerTaskRoutes(app, storage, engine, broadcaster, metrics, rateLimiter);
    registerClaimRoutes(app, storage, broadcaster, rateLimiter);
    registerEventRoutes(app, storage, broadcaster);
    registerMessageRoutes(app, storage, broadcaster, rateLimiter);
    registerLockRoutes(app, storage, broadcaster, rateLimiter);
  });

  const sweepExpiredLeases = () => {
    const result = engine.expireStaleLeases();
    if (result.expiredAttemptIds.length > 0) {
      metrics.incrementLeaseExpirations(result.expiredAttemptIds.length);
      broadcaster.notifyNew();
    }
  };

  return { app, metrics, broadcaster, sweepExpiredLeases };
}

import type { FastifyInstance } from "fastify";
import type { StorageAdapter, EventWithCursor } from "@gitamesh/core";
import { requireScope } from "../auth.js";
import type { EventBroadcaster } from "../events-bus.js";

export function registerEventRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  broadcaster: EventBroadcaster,
): void {
  app.get(
    "/v1/events",
    { preHandler: requireScope(storage, "events:read") },
    async (request) => {
      const query = request.query as {
        since?: string;
        repositoryId?: string;
        limit?: string;
      };
      const since = query.since ? Number(query.since) : 0;
      const limit = query.limit ? Number(query.limit) : 200;
      const { events, nextCursor } = storage.listEventsSince(since, {
        repositoryId: query.repositoryId,
        limit,
      });
      return { events, nextCursor };
    },
  );

  // WebSocket stream. Auth + scope check runs as a normal preHandler
  // before the upgrade completes (see auth.ts — Authorization header or
  // ?token= query param, the latter because browser WebSocket clients
  // cannot set custom headers on the upgrade request).
  //
  // Reconnect semantics: pass `?since=<cursor>` (the `cursor` field from
  // the last event you received) to resume with no gaps. Re-delivery of
  // the boundary event is possible (at-least-once) — see events-bus.ts.
  app.get(
    "/v1/events/stream",
    { websocket: true, preHandler: requireScope(storage, "events:read") },
    (socket, request) => {
      const query = (request.query ?? {}) as { since?: string; repositoryId?: string };
      const since = query.since ? Number(query.since) : 0;

      const unsubscribe = broadcaster.subscribe(
        {
          send: (events: EventWithCursor[]) => {
            for (const event of events) {
              socket.send(JSON.stringify(event));
            }
          },
          repositoryId: query.repositoryId,
        },
        since,
      );

      socket.on("close", () => unsubscribe());
      socket.on("error", () => unsubscribe());
    },
  );
}

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Device } from "@gitamesh/protocol";
import type { StorageAdapter } from "@gitamesh/core";
import { requireScope } from "../auth.js";
import { sendError } from "../problem.js";
import { getIdempotencyKey, withIdempotency } from "../idempotency.js";
import type { EventBroadcaster } from "../events-bus.js";
import type { RateLimiter } from "../rate-limit.js";

const RegisterDeviceBody = z.object({
  namespace_id: z.string().default("default"),
  hostname: z.string().min(1),
  display_name: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  agent_id: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export function registerDeviceRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  broadcaster: EventBroadcaster,
  rateLimiter: RateLimiter,
): void {
  app.post(
    "/v1/devices",
    { preHandler: requireScope(storage, "device:register", { rateLimiter }) },
    async (request, reply) => {
      const parsed = RegisterDeviceBody.safeParse(request.body);
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
        const { result: device, replayed } = withIdempotency<Device>(
          storage,
          "createDevice",
          idempotencyKey,
          () => {
            const now = storage.now();
            const created: Device = {
              device_id: storage.generateId("device"),
              namespace_id: parsed.data.namespace_id,
              hostname: parsed.data.hostname,
              display_name: parsed.data.display_name,
              capabilities: parsed.data.capabilities,
              status: "registered",
              agent_id: parsed.data.agent_id,
              last_heartbeat_at: null,
              created_at: now,
              metadata: parsed.data.metadata,
            };
            storage.saveDevice(created);
            storage.appendEvent({
              schema_version: 1,
              event_type: "device.registered",
              occurred_at: now,
              namespace_id: created.namespace_id,
              repository_id: null,
              workflow_id: null,
              task_id: null,
              attempt_id: null,
              agent_id: created.agent_id,
              workspace_session_id: null,
              correlation_id: null,
              causation_id: null,
              idempotency_key: idempotencyKey ?? null,
              payload: { hostname: created.hostname, capabilities: created.capabilities },
              metadata: {},
            });
            return created;
          },
        );
        if (!replayed) broadcaster.notifyNew();
        reply.code(201).type("application/json").send(device);
      } catch (err) {
        return sendError(reply, 500, "Internal Server Error", String(err));
      }
    },
  );

  app.get("/v1/devices/:deviceId", async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const device = storage.getDevice(deviceId);
    if (!device) {
      return reply.code(404).type("application/problem+json").send({
        type: "https://gitamesh.dev/problems/not-found",
        title: "Device Not Found",
        status: 404,
        detail: `Device ${deviceId} not found.`,
      });
    }
    reply.type("application/json").send(device);
  });

  app.get("/v1/devices", async (request, reply) => {
    const devices = storage.listDevices();
    reply.type("application/json").send({ devices });
  });

  app.post(
    "/v1/devices/:deviceId/heartbeat",
    { preHandler: requireScope(storage, "device:heartbeat", { rateLimiter }) },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      const device = storage.getDevice(deviceId);
      if (!device) {
        return reply.code(404).type("application/problem+json").send({
          type: "https://gitamesh.dev/problems/not-found",
          title: "Device Not Found",
          status: 404,
          detail: `Device ${deviceId} not found.`,
        });
      }
      const now = storage.now();
      const updated: Device = { ...device, last_heartbeat_at: now, status: "online" };
      storage.saveDevice(updated);
      storage.appendEvent({
        schema_version: 1,
        event_type: "device.heartbeat",
        occurred_at: now,
        namespace_id: device.namespace_id,
        repository_id: null,
        workflow_id: null,
        task_id: null,
        attempt_id: null,
        agent_id: device.agent_id,
        workspace_session_id: null,
        correlation_id: null,
        causation_id: null,
        idempotency_key: null,
        payload: {},
        metadata: {},
      });
      broadcaster.notifyNew();
      reply.type("application/json").send(updated);
    },
  );
}

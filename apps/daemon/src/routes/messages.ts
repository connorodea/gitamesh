import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Message } from "@gitamesh/protocol";
import { GitameshError, MESSAGE_BROADCAST, taskNotFound } from "@gitamesh/protocol";
import type { StorageAdapter } from "@gitamesh/core";
import { requireScope } from "../auth.js";
import { sendError } from "../problem.js";
import { emitEvent, requireAgent, sendInvalidRequest } from "../collab.js";
import type { EventBroadcaster } from "../events-bus.js";
import type { RateLimiter } from "../rate-limit.js";

const SendMessageBody = z.object({
  from: z.string().min(1),
  /** An agent id, or "all". */
  to: z.string().min(1),
  repository_id: z.string().min(1).nullable().default(null),
  task_id: z.string().min(1).nullable().default(null),
  body: z.string().min(1).max(65_536),
});

const AckBody = z.object({ agent_id: z.string().min(1) });

const ListQuery = z.object({
  to: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  unread: z.enum(["true", "false"]).optional(),
  since: z.string().datetime().optional(),
  repositoryId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

function messageNotFound(messageId: string): GitameshError {
  return new GitameshError({
    type: "https://gitamesh.dev/problems/message-not-found",
    title: "Message not found",
    status: 404,
    detail: `No message exists with id ${messageId}.`,
    extensions: { message_id: messageId },
  });
}

/**
 * Agent-to-agent messages. There is deliberately NO update and NO delete
 * route: a message is written once, and the only later change is an agent
 * adding its own ack.
 */
export function registerMessageRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  broadcaster: EventBroadcaster,
  rateLimiter: RateLimiter,
): void {
  app.post(
    "/v1/messages",
    { preHandler: requireScope(storage, "task:claim", { rateLimiter }) },
    async (request, reply) => {
      const parsed = SendMessageBody.safeParse(request.body);
      if (!parsed.success) return sendInvalidRequest(reply, parsed.error);
      try {
        const message = storage.transaction(() => {
          const sender = requireAgent(storage, parsed.data.from);
          if (parsed.data.to !== MESSAGE_BROADCAST) requireAgent(storage, parsed.data.to);
          if (parsed.data.task_id && !storage.getTask(parsed.data.task_id)) {
            throw taskNotFound(parsed.data.task_id);
          }
          const created: Message = {
            message_id: storage.generateId("msg"),
            from: parsed.data.from,
            to: parsed.data.to,
            repository_id: parsed.data.repository_id,
            task_id: parsed.data.task_id,
            body: parsed.data.body,
            created_at: storage.now(),
            acked_by: [],
          };
          storage.appendMessage(created);
          emitEvent(storage, {
            event_type: "message.sent",
            namespace_id: created.repository_id ?? sender.namespace_id,
            repository_id: created.repository_id,
            task_id: created.task_id,
            agent_id: created.from,
            payload: { message_id: created.message_id, to: created.to },
          });
          return created;
        });
        broadcaster.notifyNew();
        reply.code(201);
        return { message };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/v1/messages",
    { preHandler: requireScope(storage, "task:read") },
    async (request, reply) => {
      const parsed = ListQuery.safeParse(request.query);
      if (!parsed.success) return sendInvalidRequest(reply, parsed.error);
      const query = parsed.data;
      if (query.unread === "true" && !query.to) {
        return sendError(
          reply,
          new GitameshError({
            type: "https://gitamesh.dev/problems/invalid-request",
            title: "Invalid request",
            status: 400,
            detail: "unread=true needs to=<agentId>: unread is per agent.",
          }),
        );
      }
      const messages = storage
        .listMessages({ repositoryId: query.repositoryId, since: query.since })
        .filter((m) => {
          if (query.to && m.to !== query.to && m.to !== MESSAGE_BROADCAST) return false;
          if (query.from && m.from !== query.from) return false;
          if (query.taskId && m.task_id !== query.taskId) return false;
          if (query.unread === "true") {
            // An agent's own broadcast is never unread for that agent.
            if (m.from === query.to) return false;
            if (m.acked_by.some((ack) => ack.agent_id === query.to)) return false;
          }
          return true;
        });
      return { messages };
    },
  );

  app.post(
    "/v1/messages/:messageId/ack",
    { preHandler: requireScope(storage, "task:claim", { rateLimiter }) },
    async (request, reply) => {
      const { messageId } = request.params as { messageId: string };
      const parsed = AckBody.safeParse(request.body);
      if (!parsed.success) return sendInvalidRequest(reply, parsed.error);
      try {
        const result = storage.transaction(() => {
          const message = storage.getMessage(messageId);
          if (!message) throw messageNotFound(messageId);
          const agent = requireAgent(storage, parsed.data.agent_id);
          if (message.to !== MESSAGE_BROADCAST && message.to !== agent.agent_id) {
            throw new GitameshError({
              type: "https://gitamesh.dev/problems/not-message-recipient",
              title: "Not the recipient",
              status: 403,
              detail: `Message ${messageId} is addressed to ${message.to}; ${agent.agent_id} cannot ack it.`,
              extensions: { message_id: messageId, to: message.to },
            });
          }
          const acked = storage.ackMessage(messageId, agent.agent_id, storage.now());
          if (acked) {
            emitEvent(storage, {
              event_type: "message.acked",
              namespace_id: message.repository_id ?? agent.namespace_id,
              repository_id: message.repository_id,
              task_id: message.task_id,
              agent_id: agent.agent_id,
              payload: { message_id: messageId },
            });
          }
          return { message: storage.getMessage(messageId)!, already_acked: !acked };
        });
        if (!result.already_acked) broadcaster.notifyNew();
        return result;
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}

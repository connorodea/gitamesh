import type { FastifyReply } from "fastify";
import type { ZodError } from "zod";
import type { Agent, EventEnvelope } from "@gitamesh/protocol";
import { GitameshError } from "@gitamesh/protocol";
import type { StorageAdapter } from "@gitamesh/core";

const PROBLEM_BASE = "https://gitamesh.dev/problems";

/**
 * 400 for a body/query that failed its zod schema. `detail` is ONE line
 * (`field: message; field: message`) so it survives `| tail -1` and log
 * truncation; the raw issues go in `extensions`.
 */
export function sendInvalidRequest(reply: FastifyReply, error: ZodError): FastifyReply {
  const detail = error.issues
    .map((issue) => {
      const field = issue.path.join(".");
      return field ? `${field}: ${issue.message}` : issue.message;
    })
    .join("; ");
  return reply.code(400).type("application/problem+json").send({
    type: `${PROBLEM_BASE}/invalid-request`,
    title: "Invalid request body",
    status: 400,
    detail,
    extensions: { issues: error.issues },
  });
}

export function agentNotFound(agentId: string): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/agent-not-found`,
    title: "Agent not found",
    status: 404,
    detail: `No agent exists with id ${agentId}.`,
    extensions: { agent_id: agentId },
  });
}

export function requireAgent(storage: StorageAdapter, agentId: string): Agent {
  const agent = storage.getAgent(agentId);
  if (!agent) throw agentNotFound(agentId);
  return agent;
}

/** Appends an event, defaulting every correlation field the caller does not set to null. */
export function emitEvent(
  storage: StorageAdapter,
  event: Pick<EventEnvelope, "event_type" | "namespace_id" | "payload"> &
    Partial<Pick<EventEnvelope, "repository_id" | "workflow_id" | "task_id" | "agent_id">>,
): void {
  storage.appendEvent({
    schema_version: 1,
    event_type: event.event_type,
    occurred_at: storage.now(),
    namespace_id: event.namespace_id,
    repository_id: event.repository_id ?? null,
    workflow_id: event.workflow_id ?? null,
    task_id: event.task_id ?? null,
    attempt_id: null,
    agent_id: event.agent_id ?? null,
    workspace_session_id: null,
    correlation_id: null,
    causation_id: null,
    idempotency_key: null,
    payload: event.payload,
    metadata: {},
  });
}

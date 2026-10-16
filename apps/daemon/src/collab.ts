import type { FastifyReply } from "fastify";
import type { ZodError } from "zod";
import type { Agent, EventEnvelope, Repository } from "@gitamesh/protocol";
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

export function repositoryNotRegistered(repositoryId: string): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/repository-not-registered`,
    title: "Repository not registered",
    status: 404,
    detail:
      `No repository is registered with id ${repositoryId}. ` +
      "Run `gitamesh repo register` in that repository (or call gitamesh_register_repository), then retry. " +
      "`gitamesh repo list` shows the registered ids.",
    extensions: { repository_id: repositoryId },
  });
}

function unregisteredRepositoryWarning(repositoryId: string): string {
  return (
    `Stored, but no repository is registered with id ${repositoryId}, so it will not appear in ` +
    "`gitamesh repo list`. Run `gitamesh repo register` in that repository " +
    "(or call gitamesh_register_repository), or check the id for a typo."
  );
}

/**
 * What the daemon does with a write that names a repository it has never
 * registered. `warn` (the default) stores the write as before but returns a
 * `warnings` entry and logs it; `refuse` answers 404 repository-not-registered.
 * The default stays non-breaking because registration was optional until now:
 * live agents and stored rows already use ids that were never registered.
 */
export type UnregisteredRepositoryPolicy = "warn" | "refuse";

export function parseUnregisteredRepositoryPolicy(value: string | undefined): UnregisteredRepositoryPolicy {
  const normalized = (value ?? "warn").trim().toLowerCase();
  if (normalized === "warn" || normalized === "") return "warn";
  if (normalized === "refuse") return "refuse";
  throw new Error(`Unknown GITAMESH_UNREGISTERED_REPOSITORY "${value}". Supported: "warn" (default), "refuse".`);
}

export interface ResponseWarning {
  code: "repository-not-registered";
  detail: string;
  repository_id: string;
}

/**
 * Checks a repository id a write names. `null` means "not about any one
 * repository" and is always accepted. A registered id returns no warnings.
 * An unregistered id returns one warning, or throws under `refuse`.
 */
export function checkRepository(
  storage: StorageAdapter,
  repositoryId: string | null,
  policy: UnregisteredRepositoryPolicy,
): ResponseWarning[] {
  if (repositoryId === null || storage.getRepository(repositoryId)) return [];
  if (policy === "refuse") throw repositoryNotRegistered(repositoryId);
  return [
    { code: "repository-not-registered", detail: unregisteredRepositoryWarning(repositoryId), repository_id: repositoryId },
  ];
}

/** Spreads `warnings` into a response body only when there is one. */
export function withWarnings<T extends object>(body: T, warnings: ResponseWarning[]): T & { warnings?: ResponseWarning[] } {
  return warnings.length > 0 ? { ...body, warnings } : body;
}

/** Appends an event, defaulting every correlation field the caller does not set to null. */
export function emitEvent(
  storage: StorageAdapter,
  event: Pick<EventEnvelope, "event_type" | "namespace_id" | "payload"> &
    Partial<
      Pick<
        EventEnvelope,
        "repository_id" | "workflow_id" | "task_id" | "attempt_id" | "agent_id" | "workspace_session_id"
      >
    >,
): void {
  storage.appendEvent({
    schema_version: 1,
    event_type: event.event_type,
    occurred_at: storage.now(),
    namespace_id: event.namespace_id,
    repository_id: event.repository_id ?? null,
    workflow_id: event.workflow_id ?? null,
    task_id: event.task_id ?? null,
    attempt_id: event.attempt_id ?? null,
    agent_id: event.agent_id ?? null,
    workspace_session_id: event.workspace_session_id ?? null,
    correlation_id: null,
    causation_id: null,
    idempotency_key: null,
    payload: event.payload,
    metadata: {},
  });
}

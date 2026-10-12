import { z } from "zod";
import {
  MessageSchema,
  PathLockSchema,
  TaskNoteSchema,
  TaskRevisionSchema,
} from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, invalidInputError, type ToolError } from "../tool-result.js";
import { TaskViewSchema, type TaskView } from "./list-tasks.js";

/**
 * Agent-collaboration tools: messages, task update/notes/history, and path
 * locks. Inputs are camelCase like every other tool here; each handler
 * maps them onto the daemon's snake_case bodies (`apps/daemon/src/routes/
 * messages.ts`, `locks.ts`, `tasks.ts`). `apps/daemon/test/collab-mcp.test.ts`
 * runs these handlers against a real in-memory daemon so the two cannot
 * drift apart silently.
 */

const id = z.string().min(1);
const LockViewSchema = PathLockSchema.extend({ holder_display_name: z.string() });
type Message = z.infer<typeof MessageSchema>;
type LockView = z.infer<typeof LockViewSchema>;

function output<T extends z.ZodRawShape>(shape: T) {
  return z.union([z.object({ ok: z.literal(true), ...shape }), ToolErrorSchema]);
}

// --- messages ----------------------------------------------------------------

export const SendMessageInputSchema = z.object({
  from: id.describe("Your agent id."),
  to: id.describe('The receiving agent id, or "all" for every agent.'),
  body: z.string().min(1).max(65_536),
  repositoryId: id.optional(),
  taskId: id.optional(),
});
export const SendMessageOutputSchema = output({ message: MessageSchema });

export async function handleSendMessage(
  input: z.infer<typeof SendMessageInputSchema>,
  client: DaemonClient,
): Promise<{ ok: true; message: Message } | ToolError> {
  const result = await client.sendMessage({
    from: input.from,
    to: input.to,
    body: input.body,
    repository_id: input.repositoryId ?? null,
    task_id: input.taskId ?? null,
  });
  return fromDaemonResult(result, (data) => ({ ok: true as const, message: data.message as Message }));
}

export const ListMessagesInputSchema = z.object({
  to: id.optional().describe('Messages for this agent, including those sent to "all".'),
  from: id.optional(),
  unread: z.boolean().optional().describe("Only messages `to` has not acked. Needs `to`."),
  since: z.string().datetime().optional(),
  repositoryId: id.optional(),
  taskId: id.optional(),
});
export const ListMessagesOutputSchema = output({ messages: z.array(MessageSchema) });

export async function handleListMessages(
  input: z.infer<typeof ListMessagesInputSchema>,
  client: DaemonClient,
): Promise<{ ok: true; messages: Message[] } | ToolError> {
  if (input.unread && !input.to) {
    return invalidInputError("unread needs `to`: unread is per agent.");
  }
  const result = await client.listMessages({
    to: input.to,
    from: input.from,
    unread: input.unread ? "true" : undefined,
    since: input.since,
    repositoryId: input.repositoryId,
    taskId: input.taskId,
  });
  return fromDaemonResult(result, (data) => ({ ok: true as const, messages: data.messages as Message[] }));
}

export const AckMessageInputSchema = z.object({ messageId: id, agentId: id });
export const AckMessageOutputSchema = output({ message: MessageSchema, alreadyAcked: z.boolean() });

export async function handleAckMessage(
  input: z.infer<typeof AckMessageInputSchema>,
  client: DaemonClient,
): Promise<{ ok: true; message: Message; alreadyAcked: boolean } | ToolError> {
  const result = await client.ackMessage(input.messageId, { agent_id: input.agentId });
  return fromDaemonResult(result, (data) => ({
    ok: true as const,
    message: data.message as Message,
    alreadyAcked: data.already_acked,
  }));
}

// --- tasks: show, update, note --------------------------------------------------

export const GetTaskInputSchema = z.object({ taskId: id });
export const GetTaskOutputSchema = output({
  task: TaskViewSchema,
  notes: z.array(TaskNoteSchema),
  revisions: z.array(TaskRevisionSchema),
});

export async function handleGetTask(
  input: z.infer<typeof GetTaskInputSchema>,
  client: DaemonClient,
): Promise<
  | {
      ok: true;
      task: TaskView;
      notes: z.infer<typeof TaskNoteSchema>[];
      revisions: z.infer<typeof TaskRevisionSchema>[];
    }
  | ToolError
> {
  const result = await client.getTask(input.taskId);
  return fromDaemonResult(result, (data) => ({
    ok: true as const,
    task: data.task as TaskView,
    notes: (data.notes ?? []) as z.infer<typeof TaskNoteSchema>[],
    revisions: (data.revisions ?? []) as z.infer<typeof TaskRevisionSchema>[],
  }));
}

export const UpdateTaskInputSchema = z.object({
  taskId: id,
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: z.number().optional(),
  branch: z.string().nullable().optional(),
  baseSha: z.string().nullable().optional(),
  dependencies: z
    .array(id)
    .optional()
    .describe("Replaces the whole dependency list; [] clears it."),
  agentId: id.optional().describe("Recorded in the revision history as who made the change."),
});
export const UpdateTaskOutputSchema = output({
  task: TaskViewSchema,
  revision: TaskRevisionSchema.nullable(),
});

export async function handleUpdateTask(
  input: z.infer<typeof UpdateTaskInputSchema>,
  client: DaemonClient,
): Promise<
  { ok: true; task: TaskView; revision: z.infer<typeof TaskRevisionSchema> | null } | ToolError
> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.title = input.title;
  if (input.description !== undefined) body.description = input.description;
  if (input.priority !== undefined) body.priority = input.priority;
  if (input.branch !== undefined) body.branch = input.branch;
  if (input.baseSha !== undefined) body.base_sha = input.baseSha;
  if (input.dependencies !== undefined) body.dependencies = input.dependencies;
  if (Object.keys(body).length === 0) {
    return invalidInputError(
      "Nothing to update: give title, description, priority, branch, baseSha or dependencies.",
    );
  }
  if (input.agentId !== undefined) body.updated_by = input.agentId;

  const result = await client.updateTask(input.taskId, body);
  return fromDaemonResult(result, (data) => ({
    ok: true as const,
    task: data.task as TaskView,
    revision: data.revision as z.infer<typeof TaskRevisionSchema> | null,
  }));
}

export const AddTaskNoteInputSchema = z.object({
  taskId: id,
  agentId: id,
  body: z.string().min(1).max(65_536),
});
export const AddTaskNoteOutputSchema = output({ note: TaskNoteSchema });

export async function handleAddTaskNote(
  input: z.infer<typeof AddTaskNoteInputSchema>,
  client: DaemonClient,
): Promise<{ ok: true; note: z.infer<typeof TaskNoteSchema> } | ToolError> {
  const result = await client.addTaskNote(input.taskId, { agent_id: input.agentId, body: input.body });
  return fromDaemonResult(result, (data) => ({
    ok: true as const,
    note: data.note as z.infer<typeof TaskNoteSchema>,
  }));
}

// --- path locks -------------------------------------------------------------------

const ttl = z.number().int().positive().max(86_400);

export const AcquireLockInputSchema = z.object({
  agentId: id,
  repositoryId: id,
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe("Repository-relative paths or globs. A plain path covers everything under it."),
  taskId: id.optional(),
  ttlSeconds: ttl.optional().describe("Seconds until expiry unless heartbeated. Default 900."),
});
export const LockOutputSchema = output({ lock: LockViewSchema });

function lockResult(data: { lock: unknown }): { ok: true; lock: LockView } {
  return { ok: true as const, lock: data.lock as LockView };
}

export async function handleAcquireLock(
  input: z.infer<typeof AcquireLockInputSchema>,
  client: DaemonClient,
): Promise<{ ok: true; lock: LockView } | ToolError> {
  const result = await client.acquireLock({
    agent_id: input.agentId,
    repository_id: input.repositoryId,
    paths: input.paths,
    task_id: input.taskId ?? null,
    ttl_seconds: input.ttlSeconds,
  });
  return fromDaemonResult(result, lockResult);
}

export const ListLocksInputSchema = z.object({
  repositoryId: id.optional(),
  agentId: id.optional(),
});
export const ListLocksOutputSchema = output({ locks: z.array(LockViewSchema) });

export async function handleListLocks(
  input: z.infer<typeof ListLocksInputSchema>,
  client: DaemonClient,
): Promise<{ ok: true; locks: LockView[] } | ToolError> {
  const result = await client.listLocks({
    repositoryId: input.repositoryId,
    agentId: input.agentId,
  });
  return fromDaemonResult(result, (data) => ({ ok: true as const, locks: data.locks as LockView[] }));
}

export const HeartbeatLockInputSchema = z.object({
  lockId: id,
  agentId: id,
  ttlSeconds: ttl.optional(),
});

export async function handleHeartbeatLock(
  input: z.infer<typeof HeartbeatLockInputSchema>,
  client: DaemonClient,
): Promise<{ ok: true; lock: LockView } | ToolError> {
  const result = await client.heartbeatLock(input.lockId, {
    agent_id: input.agentId,
    ttl_seconds: input.ttlSeconds,
  });
  return fromDaemonResult(result, lockResult);
}

export const ReleaseLockInputSchema = z.object({ lockId: id, agentId: id });

export async function handleReleaseLock(
  input: z.infer<typeof ReleaseLockInputSchema>,
  client: DaemonClient,
): Promise<{ ok: true; lock: LockView } | ToolError> {
  const result = await client.releaseLock(input.lockId, { agent_id: input.agentId });
  return fromDaemonResult(result, lockResult);
}

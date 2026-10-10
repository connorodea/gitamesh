import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient } from "./internal-client.js";
import { LoopMemClient } from "./loopmem-client.js";
import {
  MemoryInitInputSchema, handleMemoryInit,
  MemoryRememberInputSchema, handleMemoryRemember,
  MemoryRecallInputSchema, handleMemoryRecall,
  MemoryGetInputSchema, handleMemoryGet,
  MemoryContextInputSchema, handleMemoryContext,
} from "./tools/memory.js";
import type { GitameshMcpConfig } from "./config.js";

import { StatusInputSchema, handleStatus } from "./tools/status.js";
import { RegisterAgentInputSchema, handleRegisterAgent } from "./tools/register-agent.js";
import { CreateTaskInputSchema, handleCreateTask } from "./tools/create-task.js";
import { ListTasksInputSchema, handleListTasks } from "./tools/list-tasks.js";
import { ClaimTaskInputSchema, handleClaimTask } from "./tools/claim-task.js";
import { HeartbeatInputSchema, handleHeartbeat } from "./tools/heartbeat.js";
import { CompleteTaskInputSchema, handleCompleteTask } from "./tools/complete-task.js";
import { FailTaskInputSchema, handleFailTask } from "./tools/fail-task.js";
import { ListClaimsInputSchema, handleListClaims } from "./tools/list-claims.js";
import { EnqueueIntegrationInputSchema, handleEnqueueIntegration } from "./tools/enqueue-integration.js";
import { WatchEventsInputSchema, handleWatchEvents } from "./tools/watch-events.js";
import {
  SendMessageInputSchema, handleSendMessage,
  ListMessagesInputSchema, handleListMessages,
  AckMessageInputSchema, handleAckMessage,
  GetTaskInputSchema, handleGetTask,
  UpdateTaskInputSchema, handleUpdateTask,
  AddTaskNoteInputSchema, handleAddTaskNote,
  AcquireLockInputSchema, handleAcquireLock,
  ListLocksInputSchema, handleListLocks,
  HeartbeatLockInputSchema, handleHeartbeatLock,
  ReleaseLockInputSchema, handleReleaseLock,
} from "./tools/collab.js";

/**
 * Wraps any structured result (always a plain, schema-validated object —
 * never a bare string) as an MCP `CallToolResult`, putting it in both
 * `structuredContent` (for clients that read structured tool output) and a
 * JSON-stringified `content` block (for clients that only render text) so
 * the same result is visible either way.
 */
function toCallToolResult(payload: Record<string, unknown>): CallToolResult {
  return {
    isError: payload.ok === false,
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function createMcpServer(config: GitameshMcpConfig): McpServer {
  const client = new DaemonClient({ baseUrl: config.daemonUrl, token: config.token });
  const memoryClient = config.loopmem ? new LoopMemClient(config.loopmem) : undefined;

  const server = new McpServer({
    name: "gitamesh-mcp-server",
    version: "0.1.0",
  });

  server.registerTool(
    "gitamesh_status",
    {
      title: "Gitamesh status",
      description:
        "Daemon health plus this repository's open task and active-claim counts. " +
        "Reads GITAMESH_URL/GITAMESH_DAEMON_URL/GITAMESH_TOKEN or .gitamesh/config.yaml.",
      inputSchema: StatusInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleStatus(input, client, config.daemonUrl)),
  );

  server.registerTool(
    "gitamesh_register_agent",
    {
      title: "Register agent",
      description: "Registers an AI agent runtime with the Gitamesh daemon.",
      inputSchema: RegisterAgentInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleRegisterAgent(input, client)),
  );

  server.registerTool(
    "gitamesh_create_task",
    {
      title: "Create task",
      description: "Creates a coordination task in a repository's workflow.",
      inputSchema: CreateTaskInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleCreateTask(input, client)),
  );

  server.registerTool(
    "gitamesh_list_tasks",
    {
      title: "List tasks",
      description:
        "Lists tasks with owner (who holds each, last heartbeat) and readiness (ready, or blocked by dependencies). Filters: repositoryId, status, agentId (tasks that agent holds), unclaimed (free to claim).",
      inputSchema: ListTasksInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleListTasks(input, client)),
  );

  server.registerTool(
    "gitamesh_claim_task",
    {
      title: "Claim task",
      description:
        "Claims a task for an agent's workspace session, atomically acquiring any required " +
        "resource locks. On conflict (already claimed, resource contention, or not claimable) " +
        "returns a structured ok:false result — never throws.",
      inputSchema: ClaimTaskInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleClaimTask(input, client)),
  );

  server.registerTool(
    "gitamesh_heartbeat",
    {
      title: "Heartbeat task attempt",
      description: "Renews an in-progress attempt's lease using its fencing token.",
      inputSchema: HeartbeatInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleHeartbeat(input, client)),
  );

  server.registerTool(
    "gitamesh_complete_task",
    {
      title: "Complete task",
      description: "Marks a claimed attempt (and its task) complete, releasing its resource claims.",
      inputSchema: CompleteTaskInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleCompleteTask(input, client)),
  );

  server.registerTool(
    "gitamesh_fail_task",
    {
      title: "Fail task",
      description:
        "Marks a claimed attempt failed; the task requeues unless the retry limit is exhausted.",
      inputSchema: FailTaskInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleFailTask(input, client)),
  );

  server.registerTool(
    "gitamesh_list_claims",
    {
      title: "List resource claims",
      description: "Lists active (unreleased) resource claims, optionally filtered by repository.",
      inputSchema: ListClaimsInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleListClaims(input, client)),
  );

  server.registerTool(
    "gitamesh_enqueue_integration",
    {
      title: "Enqueue integration candidate",
      description:
        "Enqueues a completed task's branch as an integration candidate. NOT YET SUPPORTED — " +
        "apps/daemon has no integration-candidate lifecycle; this always returns a structured " +
        "supported:false result. Kept registered so the capability gap is discoverable.",
      inputSchema: EnqueueIntegrationInputSchema.shape,
    },
    (input) => toCallToolResult(handleEnqueueIntegration(input)),
  );

  server.registerTool(
    "gitamesh_watch_events",
    {
      title: "Watch events (cursor page)",
      description:
        "Returns up to `limit` coordination events since cursor `since`, via the daemon's " +
        "GET /v1/events. This is a request/response page, not a live subscription — pass the " +
        "returned nextCursor back in as `since` to poll incrementally. See the module doc in " +
        "src/tools/watch-events.ts for why a live WebSocket stream isn't exposed as an MCP tool.",
      inputSchema: WatchEventsInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleWatchEvents(input, client)),
  );

  server.registerTool(
    "gitamesh_send_message",
    {
      title: "Send message",
      description:
        "Sends a message to one agent or to \"all\". Append-only: messages are never edited or deleted. Use this instead of creating a task to talk to another agent.",
      inputSchema: SendMessageInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleSendMessage(input, client)),
  );

  server.registerTool(
    "gitamesh_list_messages",
    {
      title: "List messages",
      description:
        "Lists messages, oldest first. For your inbox pass to=<your agent id> and unread=true (includes messages sent to \"all\"). Read it when a session starts and before claiming work.",
      inputSchema: ListMessagesInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleListMessages(input, client)),
  );

  server.registerTool(
    "gitamesh_ack_message",
    {
      title: "Acknowledge message",
      description:
        "Marks a message as read by an agent. Repeating it is harmless and returns alreadyAcked: true.",
      inputSchema: AckMessageInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleAckMessage(input, client)),
  );

  server.registerTool(
    "gitamesh_get_task",
    {
      title: "Get task",
      description:
        "Reads one task with its owner (who holds it, last heartbeat), readiness, progress notes and revision history.",
      inputSchema: GetTaskInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleGetTask(input, client)),
  );

  server.registerTool(
    "gitamesh_update_task",
    {
      title: "Update task",
      description:
        "Changes a task's title, description, priority, branch, base SHA or dependency list. Each change writes an append-only revision (who, when, old -> new). Pass agentId so the revision names you.",
      inputSchema: UpdateTaskInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleUpdateTask(input, client)),
  );

  server.registerTool(
    "gitamesh_add_task_note",
    {
      title: "Add task note",
      description:
        "Appends a progress note to a task. Notes are shown by gitamesh_get_task and are never edited or deleted.",
      inputSchema: AddTaskNoteInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleAddTaskNote(input, client)),
  );

  server.registerTool(
    "gitamesh_acquire_lock",
    {
      title: "Acquire path lock",
      description:
        "Locks repository paths or globs for an agent so no other agent edits them. Acquire before editing. An overlap with another agent's live lock returns ok:false and names the holder; nothing is locked. Expires after ttlSeconds unless heartbeated.",
      inputSchema: AcquireLockInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleAcquireLock(input, client)),
  );

  server.registerTool(
    "gitamesh_list_locks",
    {
      title: "List path locks",
      description:
        "Lists active path locks with holder and paths, optionally for one repository or agent.",
      inputSchema: ListLocksInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleListLocks(input, client)),
  );

  server.registerTool(
    "gitamesh_heartbeat_lock",
    {
      title: "Heartbeat path lock",
      description:
        "Renews a path lock you hold. An expired lock cannot be renewed; acquire it again.",
      inputSchema: HeartbeatLockInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleHeartbeatLock(input, client)),
  );

  server.registerTool(
    "gitamesh_release_lock",
    {
      title: "Release path lock",
      description:
        "Releases a path lock you hold. The record is kept as history.",
      inputSchema: ReleaseLockInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleReleaseLock(input, client)),
  );

  server.registerTool(
    "gitamesh_memory_init",
    {
      title: "Initialize shared memory",
      description: "Initialize a repository memory namespace once. Requires GITAMESH_LOOPMEM_STORE. Use the same repositoryId across agents and worktrees; use recall or context when each session starts.",
      inputSchema: MemoryInitInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleMemoryInit(input, memoryClient)),
  );

  server.registerTool(
    "gitamesh_memory_remember",
    {
      title: "Save shared memory",
      description: "Save a durable fact, decision, constraint, failure, or next action before compaction or session end. Requires agentId and workspaceSessionId provenance. This explicit call does not capture conversations automatically or change task claims.",
      inputSchema: MemoryRememberInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleMemoryRemember(input, memoryClient)),
  );

  server.registerTool(
    "gitamesh_memory_recall",
    {
      title: "Recall shared memory",
      description: "Read shared repository memory when a session starts or before repeating work. All agents and worktrees using the same repositoryId read the same namespace. Optional text, kind, agent, and session filters; no model call.",
      inputSchema: MemoryRecallInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleMemoryRecall(input, memoryClient)),
  );

  server.registerTool(
    "gitamesh_memory_get",
    {
      title: "Read one shared memory",
      description: "Read one complete memory by repositoryId and memory ID, including provenance and superseded records. Evidence references are not proof that a claim is true.",
      inputSchema: MemoryGetInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleMemoryGet(input, memoryClient)),
  );

  server.registerTool(
    "gitamesh_memory_context",
    {
      title: "Build shared memory context",
      description: "Build a bounded context packet from stored repository memory for a new session or after saving memory before compaction. Does not erase history or compact a model session.",
      inputSchema: MemoryContextInputSchema.shape,
    },
    async (input) => toCallToolResult(await handleMemoryContext(input, memoryClient)),
  );

  return server;
}

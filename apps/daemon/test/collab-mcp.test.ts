/**
 * The MCP server's collaboration tool handlers against a real (in-memory)
 * daemon. `packages/mcp-server`'s own tests use a fake `fetch`, which can
 * only check the body shape its author believed the daemon wants; here each
 * handler's request goes through the daemon's actual zod schemas, and each
 * result is parsed by the tool's own output schema.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { DaemonClient } from "../../../packages/mcp-server/src/internal-client.js";
import * as collab from "../../../packages/mcp-server/src/tools/collab.js";
import { handleCreateTask, CreateTaskInputSchema } from "../../../packages/mcp-server/src/tools/create-task.js";
import { handleClaimTask, ClaimTaskInputSchema } from "../../../packages/mcp-server/src/tools/claim-task.js";
import { handleListTasks, ListTasksInputSchema, ListTasksOutputSchema } from "../../../packages/mcp-server/src/tools/list-tasks.js";
import { handleRegisterAgent, RegisterAgentInputSchema } from "../../../packages/mcp-server/src/tools/register-agent.js";
import * as repositories from "../../../packages/mcp-server/src/tools/repositories.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { mintToken, SCOPES } from "../src/auth.js";

const REPO = "repo-1";

let storage: SqliteStorageAdapter;
let built: BuiltServer;
let client: DaemonClient;

beforeEach(() => {
  storage = createInMemorySqliteStorage();
  built = buildServer({ storage, logger: false, rateLimitPerMinute: 10_000 });
  const rawToken = mintToken(storage, [...SCOPES]).rawToken;

  const injectFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const res = await built.app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH",
      url: `${url.pathname}${url.search}`,
      headers: init?.headers as Record<string, string>,
      payload: init?.body as string | undefined,
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: { "content-type": String(res.headers["content-type"] ?? "") },
    });
  }) as typeof fetch;
  client = new DaemonClient({ baseUrl: "http://daemon.test", token: rawToken, fetchImpl: injectFetch });
});

afterEach(async () => {
  await built.app.close();
  storage.close();
});

/** Unwraps a tool result that must be a success, failing with the tool's error otherwise. */
function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result).toMatchObject({ ok: true });
  return result as Extract<T, { ok: true }>;
}

function failed<T extends { ok: boolean }>(result: T): { type: string; status?: number; detail?: string } {
  expect(result.ok).toBe(false);
  return (result as unknown as { error: { type: string; status?: number; detail?: string } }).error;
}

async function agent(name: string): Promise<string> {
  const result = ok(
    await handleRegisterAgent(
      RegisterAgentInputSchema.parse({ displayName: name, runtime: "custom", capabilities: [] }),
      client,
    ),
  );
  return (result.agent as { agent_id: string }).agent_id;
}

async function task(title: string, dependencies: string[] = []): Promise<string> {
  const result = ok(
    await handleCreateTask(
      CreateTaskInputSchema.parse({ repositoryId: REPO, workflowId: "wf-1", title, dependencies }),
      client,
    ),
  );
  return result.task.task_id;
}

describe("MCP messages", () => {
  it("send -> unread inbox -> ack -> inbox empty", async () => {
    const claude = await agent("claude");
    const codex = await agent("codex");
    const taskId = await task("t");

    const sent = ok(
      await collab.handleSendMessage(
        collab.SendMessageInputSchema.parse({
          from: claude, to: codex, body: "please review", repositoryId: REPO, taskId,
        }),
        client,
      ),
    );
    collab.SendMessageOutputSchema.parse(sent);
    expect(sent.message).toMatchObject({ from: claude, to: codex, repository_id: REPO, task_id: taskId });

    const inbox = ok(
      await collab.handleListMessages(collab.ListMessagesInputSchema.parse({ to: codex, unread: true }), client),
    );
    collab.ListMessagesOutputSchema.parse(inbox);
    expect(inbox.messages.map((m) => m.message_id)).toEqual([sent.message.message_id]);

    const acked = ok(
      await collab.handleAckMessage(
        collab.AckMessageInputSchema.parse({ messageId: sent.message.message_id, agentId: codex }),
        client,
      ),
    );
    collab.AckMessageOutputSchema.parse(acked);
    expect(acked.alreadyAcked).toBe(false);
    expect(acked.message.acked_by.map((a) => a.agent_id)).toEqual([codex]);

    const after = ok(
      await collab.handleListMessages(collab.ListMessagesInputSchema.parse({ to: codex, unread: true }), client),
    );
    expect(after.messages).toEqual([]);
  });

  it("an unknown sender is a structured 404", async () => {
    const error = failed(
      await collab.handleSendMessage(
        collab.SendMessageInputSchema.parse({ from: "ghost", to: "all", body: "x" }),
        client,
      ),
    );
    expect(error).toMatchObject({ status: 404, type: expect.stringContaining("agent-not-found") });
  });
});

describe("MCP task update, notes and history", () => {
  it("update writes a revision; note is appended; get_task returns both", async () => {
    const claude = await agent("claude");
    const taskId = await task("old");

    const updated = ok(
      await collab.handleUpdateTask(
        collab.UpdateTaskInputSchema.parse({
          taskId, title: "new", description: "fresh", priority: 3, branch: "feat/x", baseSha: "abc", agentId: claude,
        }),
        client,
      ),
    );
    collab.UpdateTaskOutputSchema.parse(updated);
    expect(updated.task).toMatchObject({ title: "new", priority: 3, branch: "feat/x", base_sha: "abc" });
    expect(updated.revision?.changed_by).toBe(claude);
    expect(updated.revision?.changes.title).toEqual({ old: "old", new: "new" });

    const unchanged = ok(
      await collab.handleUpdateTask(collab.UpdateTaskInputSchema.parse({ taskId, title: "new" }), client),
    );
    expect(unchanged.revision).toBeNull();

    const note = ok(
      await collab.handleAddTaskNote(
        collab.AddTaskNoteInputSchema.parse({ taskId, agentId: claude, body: "half done" }),
        client,
      ),
    );
    collab.AddTaskNoteOutputSchema.parse(note);

    const shown = ok(await collab.handleGetTask(collab.GetTaskInputSchema.parse({ taskId }), client));
    collab.GetTaskOutputSchema.parse(shown);
    expect(shown.notes.map((n) => n.body)).toEqual(["half done"]);
    expect(shown.revisions).toHaveLength(1);
  });

  it("dependencies: update sets them, list shows blocked, claim is refused with a structured 409", async () => {
    const claude = await agent("claude");
    const first = await task("first");
    const second = await task("second");

    const set = ok(
      await collab.handleUpdateTask(
        collab.UpdateTaskInputSchema.parse({ taskId: second, dependencies: [first] }),
        client,
      ),
    );
    expect(set.task).toMatchObject({ dependencies: [first], readiness: "blocked", blocked_by: [first] });

    const error = failed(
      await handleClaimTask(
        ClaimTaskInputSchema.parse({ taskId: second, agentId: claude, workspaceSessionId: "ws-1" }),
        client,
      ),
    );
    expect(error.status).toBe(409);
    expect(error.type).toContain("task-dependencies-incomplete");
    expect(error.detail).toContain(first);

    const cycle = failed(
      await collab.handleUpdateTask(
        collab.UpdateTaskInputSchema.parse({ taskId: first, dependencies: [second] }),
        client,
      ),
    );
    expect(cycle.type).toContain("invalid-dependencies");
  });
});

describe("MCP list_tasks owner visibility", () => {
  it("returns owner and readiness, and filters by agentId and unclaimed", async () => {
    const claude = await agent("claude-mvp-loop");
    const held = await task("held");
    const free = await task("free");
    ok(
      await handleClaimTask(
        ClaimTaskInputSchema.parse({ taskId: held, agentId: claude, workspaceSessionId: "ws-1" }),
        client,
      ),
    );

    const list = async (input: Record<string, unknown>) => {
      const result = ok(await handleListTasks(ListTasksInputSchema.parse(input), client));
      ListTasksOutputSchema.parse(result);
      return result.tasks;
    };
    const all = await list({ repositoryId: REPO });
    expect(all.find((t) => t.task_id === held)?.owner).toMatchObject({
      agent_id: claude,
      display_name: "claude-mvp-loop",
    });
    expect(all.find((t) => t.task_id === free)).toMatchObject({ owner: null, readiness: "ready" });
    expect((await list({ agentId: claude })).map((t) => t.task_id)).toEqual([held]);
    expect((await list({ unclaimed: true })).map((t) => t.task_id)).toEqual([free]);
  });
});

describe("MCP path locks", () => {
  it("acquire -> list -> conflict names the holder -> heartbeat -> release", async () => {
    const claude = await agent("claude-mvp-loop");
    const codex = await agent("codex-mvp-audit");

    const acquired = ok(
      await collab.handleAcquireLock(
        collab.AcquireLockInputSchema.parse({
          agentId: claude, repositoryId: REPO, paths: ["src/api/**"], ttlSeconds: 120,
        }),
        client,
      ),
    );
    collab.LockOutputSchema.parse(acquired);
    expect(acquired.lock).toMatchObject({ agent_id: claude, holder_display_name: "claude-mvp-loop", paths: ["src/api/**"] });

    const listed = ok(await collab.handleListLocks(collab.ListLocksInputSchema.parse({ repositoryId: REPO }), client));
    collab.ListLocksOutputSchema.parse(listed);
    expect(listed.locks.map((l) => l.lock_id)).toEqual([acquired.lock.lock_id]);

    const conflict = failed(
      await collab.handleAcquireLock(
        collab.AcquireLockInputSchema.parse({ agentId: codex, repositoryId: REPO, paths: ["src/api/users.ts"] }),
        client,
      ),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.type).toContain("path-lock-conflict");
    expect(conflict.detail).toContain("claude-mvp-loop");

    const beat = ok(
      await collab.handleHeartbeatLock(
        collab.HeartbeatLockInputSchema.parse({ lockId: acquired.lock.lock_id, agentId: claude, ttlSeconds: 600 }),
        client,
      ),
    );
    expect(new Date(beat.lock.expires_at).getTime() - new Date(beat.lock.heartbeat_at).getTime()).toBe(600_000);

    const notHolder = failed(
      await collab.handleReleaseLock(
        collab.ReleaseLockInputSchema.parse({ lockId: acquired.lock.lock_id, agentId: codex }),
        client,
      ),
    );
    expect(notHolder.status).toBe(403);

    const released = ok(
      await collab.handleReleaseLock(
        collab.ReleaseLockInputSchema.parse({ lockId: acquired.lock.lock_id, agentId: claude }),
        client,
      ),
    );
    expect(released.lock.released_at).not.toBeNull();
    const after = ok(await collab.handleListLocks(collab.ListLocksInputSchema.parse({}), client));
    expect(after.locks).toEqual([]);
  });
});

describe("MCP repositories", () => {
  it("register returns the record, a repeat is replayed, and list shows it once", async () => {
    const input = repositories.RegisterRepositoryInputSchema.parse({
      displayName: "juricratic",
      gitCommonDir: "/repos/juricratic/.git",
      defaultBranch: "main",
      repositoryId: "local-id-1",
    });

    const first = ok(await repositories.handleRegisterRepository(input, client));
    repositories.RegisterRepositoryOutputSchema.parse(first);
    expect(first.replayed).toBe(false);
    expect(first.repository).toMatchObject({
      repository_id: "local-id-1",
      display_name: "juricratic",
      git_common_dir: "/repos/juricratic/.git",
      default_branch: "main",
      namespace_id: "default",
    });

    const again = ok(await repositories.handleRegisterRepository(input, client));
    expect(again.replayed).toBe(true);
    expect(again.repository.repository_id).toBe("local-id-1");

    const listed = ok(
      await repositories.handleListRepositories(repositories.ListRepositoriesInputSchema.parse({}), client),
    );
    repositories.ListRepositoriesOutputSchema.parse(listed);
    expect(listed.repositories.map((r) => r.repository_id)).toEqual(["local-id-1"]);
  });

  it("without repositoryId the daemon assigns one and matches a repeat by gitCommonDir", async () => {
    const input = repositories.RegisterRepositoryInputSchema.parse({
      displayName: "other",
      gitCommonDir: "/repos/other/.git",
      defaultBranch: "main",
    });
    const first = ok(await repositories.handleRegisterRepository(input, client));
    const again = ok(await repositories.handleRegisterRepository(input, client));

    expect(first.repository.repository_id).toMatch(/^repo_/);
    expect(again).toMatchObject({ replayed: true, repository: { repository_id: first.repository.repository_id } });
  });
});

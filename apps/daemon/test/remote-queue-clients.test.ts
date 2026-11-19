import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemorySqliteStorage, type SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { GitameshClient, type ClaimNextTaskResult } from "../../../packages/sdk-typescript/src/client.js";
import { runCli } from "../../../packages/cli/src/cli.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { mintToken } from "../src/auth.js";

let storage: SqliteStorageAdapter;
let built: BuiltServer;
let client: GitameshClient;
let rawToken: string;
let baseUrl: string;
let cwd: string;

beforeEach(async () => {
  storage = createInMemorySqliteStorage();
  storage.saveRepository({
    repository_id: "repo-queue",
    namespace_id: "default",
    display_name: "Queue integration fixture",
    git_common_dir: "/tmp/queue-integration/.git",
    default_branch: "main",
    created_at: storage.now(),
    metadata: {},
  });
  built = buildServer({ storage, logger: false });
  rawToken = mintToken(storage, ["admin"]).rawToken;
  baseUrl = await built.app.listen({ port: 0, host: "127.0.0.1" });
  client = new GitameshClient({ baseUrl, token: rawToken });
  cwd = await mkdtemp(join(tmpdir(), "gitamesh-remote-queue-"));
});

afterEach(async () => {
  await built.app.close();
  storage.close();
  await rm(cwd, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await runCli(["node", "gitamesh", ...args], {
    cwd,
    env: { GITAMESH_TOKEN: rawToken, GITAMESH_DAEMON_URL: baseUrl },
    sink: { log: (line) => logs.push(line), error: (line) => errors.push(line) },
  });
  return { code, logs, errors };
}

describe("remote queue through the real HTTP CLI and SDK clients", () => {
  it("rolls back a submission if its event cannot be stored, then accepts a safe retry", async () => {
    const append = vi.spyOn(storage, "appendEvent").mockImplementationOnce(() => {
      throw new Error("Simulated event storage failure");
    });
    const input = { repositoryId: "repo-queue", title: "Atomic submission", idempotencyKey: "atomic-create" };
    await expect(client.createTask(input)).rejects.toMatchObject({ status: 500 });
    expect((await client.listTasks()).tasks).toHaveLength(0);
    append.mockRestore();
    const retried = await client.createTask(input);
    expect(retried.replayed).toBe(false);
    expect((await client.listTasks()).tasks).toHaveLength(1);
  });

  it("retries CLI submissions using the HTTP idempotency key without duplicating tasks", async () => {
    const args = [
      "task", "create", "--workflow-id", "wf_default", "--repository-id", "repo-queue",
      "--title", "Submitted remotely", "--idempotency-key", "remote-submission-1", "--json",
    ];
    const first = await cli(...args);
    const retry = await cli(...args);
    expect(first).toMatchObject({ code: 0, errors: [] });
    expect(retry).toMatchObject({ code: 0, errors: [] });
    const created = JSON.parse(first.logs.join("\n"));
    expect(JSON.parse(retry.logs.join("\n"))).toMatchObject({
      task: { task_id: created.task.task_id }, replayed: true,
    });
    expect((await client.listTasks()).tasks).toHaveLength(1);
  });

  it("lets a CLI worker claim once, recover its response, and complete through the SDK", async () => {
    const { agent } = await client.registerAgent({ displayName: "CLI worker", runtime: "custom" });
    const { task } = await client.createTask({ repositoryId: "repo-queue", title: "Verify remote delivery" });
    const args = [
      "task", "next", "--repository-id", "repo-queue", "--agent-id", agent.agent_id,
      "--workspace-session-id", "remote-worker-session", "--wait", "0",
      "--idempotency-key", "next-request-1", "--json",
    ];
    const picked = await cli(...args);
    expect(picked).toMatchObject({ code: 0, errors: [] });
    const claimed = JSON.parse(picked.logs.join("\n")) as ClaimNextTaskResult;
    expect(claimed.task?.task_id).toBe(task.task_id);
    if (!claimed.task) throw new Error("Expected a claim");
    const replay = await cli(...args);
    expect(replay).toMatchObject({ code: 0, errors: [] });
    expect(JSON.parse(replay.logs.join("\n"))).toMatchObject({
      task: { task_id: task.task_id },
      attempt: { attempt_id: claimed.attempt.attempt_id },
      replayed: true,
    });
    const completed = await client.completeTask(task.task_id, {
      attemptId: claimed.attempt.attempt_id,
      fencingToken: claimed.fencingToken,
      result: { summary: "Verified by a connected worker" },
    });
    expect(completed.task.status).toBe("completed");
    const empty = await cli(...args.slice(0, -3), "--json");
    expect(empty).toMatchObject({ code: 0, errors: [] });
    expect(JSON.parse(empty.logs.join("\n"))).toMatchObject({ task: null, reason: "no_ready_task" });
  });

  it("wakes a waiting SDK worker when a separate API client submits a matching task", async () => {
    const { agent } = await client.registerAgent({
      displayName: "SDK worker", runtime: "custom", capabilities: ["typescript"],
    });
    const waiting = client.claimNextTask({
      repositoryId: "repo-queue", agentId: agent.agent_id,
      workspaceSessionId: "sdk-session", waitMs: 2_000, idempotencyKey: "sdk-wait-1",
    });
    await client.createTask({
      repositoryId: "repo-queue", title: "Needs a different worker", requiredCapabilities: ["python"],
    });
    const { task } = await client.createTask({
      repositoryId: "repo-queue", title: "Ready for the SDK worker", requiredCapabilities: ["typescript"],
    });
    const claimed = await waiting;
    expect(claimed.task?.task_id).toBe(task.task_id);
    expect(claimed.attempt?.agent_id).toBe(agent.agent_id);
    expect(claimed.waitedMs).toBeLessThan(2_000);
  });

  it("preserves AbortError when a caller cancels its pending SDK wait", async () => {
    const { agent } = await client.registerAgent({ displayName: "Cancelled worker", runtime: "custom" });
    const controller = new AbortController();
    const waiting = client.claimNextTask({
      repositoryId: "repo-queue", agentId: agent.agent_id,
      workspaceSessionId: "cancelled-session", waitMs: 2_000, signal: controller.signal,
    });
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
  });

  it("rejects an invalid CLI wait without submitting a claim", async () => {
    const outcome = await cli(
      "task", "next", "--repository-id", "repo-queue", "--agent-id", "agent-1",
      "--workspace-session-id", "ws-1", "--wait", "26",
    );
    expect(outcome.code).toBe(1);
    expect(outcome.errors.join("\n")).toContain("between 0 and 25");
    expect(storage.listActiveAttempts()).toHaveLength(0);
  });
});

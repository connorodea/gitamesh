/**
 * The orchestration CLI commands and MCP tools against a real (in-memory)
 * daemon, so each request goes through the daemon's own zod schemas.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { runCli } from "../../../packages/cli/src/cli.js";
import { DaemonClient } from "../../../packages/mcp-server/src/internal-client.js";
import * as orch from "../../../packages/mcp-server/src/tools/orchestration.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { mintToken, SCOPES } from "../src/auth.js";

let storage: SqliteStorageAdapter;
let built: BuiltServer;
let cwd: string;
let rawToken: string;

beforeEach(async () => {
  storage = createInMemorySqliteStorage();
  built = buildServer({ storage, logger: false, rateLimitPerMinute: 10_000 });
  rawToken = mintToken(storage, [...SCOPES]).rawToken;
  storage.saveRepository({
    repository_id: "repo-1",
    namespace_id: "default",
    display_name: "repo-1",
    git_common_dir: "/tmp/repo-1/.git",
    default_branch: "main",
    created_at: storage.now(),
    metadata: {},
  });
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-orch-"));
});

afterEach(async () => {
  await built.app.close();
  storage.close();
  await fs.rm(cwd, { recursive: true, force: true });
});

const injectFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input.toString());
  const res = await built.app.inject({
    method: (init?.method ?? "GET") as "GET" | "POST",
    url: `${url.pathname}${url.search}`,
    headers: init?.headers as Record<string, string>,
    payload: init?.body as string | undefined,
  });
  return new Response(res.body, {
    status: res.statusCode,
    headers: { "content-type": String(res.headers["content-type"] ?? "") },
  });
}) as typeof fetch;

async function cliJson<T>(...args: string[]): Promise<T> {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await runCli(["node", "gitamesh", ...args, "--json"], {
    cwd,
    env: { GITAMESH_TOKEN: rawToken },
    sink: { log: (line) => logs.push(line), error: (line) => errors.push(line) },
    fetchImpl: injectFetch,
  });
  expect(errors).toEqual([]);
  expect(code).toBe(0);
  return JSON.parse(logs.join("\n")) as T;
}

async function setup(): Promise<{ agentId: string; parentId: string }> {
  const { agent } = await cliJson<{ agent: { agent_id: string } }>(
    "agent", "register", "--display-name", "orch", "--runtime", "custom",
  );
  const { task } = await cliJson<{ task: { task_id: string } }>(
    "task", "create", "--workflow-id", "wf-1", "--repository-id", "repo-1", "--title", "parent",
  );
  return { agentId: agent.agent_id, parentId: task.task_id };
}

describe("orchestration CLI", () => {
  it("dispatches, completes a child with a result, collects it, waits, and cancels the rest", async () => {
    const { agentId, parentId } = await setup();
    const { subtasks } = await cliJson<{ subtasks: Array<{ task_id: string }> }>(
      "task", "dispatch", parentId, "--subtask", "a", "--subtask", "b",
    );
    expect(subtasks).toHaveLength(2);
    const [a] = subtasks;

    const claim = await cliJson<{ attempt: { attempt_id: string }; fencingToken: number }>(
      "task", "claim", a!.task_id, "--agent-id", agentId, "--workspace-session-id", "ws-1",
    );
    await cliJson(
      "task", "complete", a!.task_id,
      "--attempt-id", claim.attempt.attempt_id,
      "--fencing-token", String(claim.fencingToken),
      "--result", '{"files":3}',
    );

    const summary = await cliJson<{ succeeded: number; subtasks: Array<{ task_id: string; result: unknown }> }>(
      "task", "subtasks", parentId,
    );
    expect(summary.succeeded).toBe(1);
    expect(summary.subtasks.find((s) => s.task_id === a!.task_id)?.result).toEqual({ files: 3 });

    const waited = await cliJson<{ woke: string; cancelled: unknown[]; summary: { outcome: string } }>(
      "task", "wait", parentId, "--timeout", "0.1", "--cancel-remaining",
    );
    expect(waited.woke).toBe("timeout");
    expect(waited.cancelled).toHaveLength(1);
    expect(waited.summary.outcome).toBe("partial");
  });
});

describe("orchestration MCP tools", () => {
  it("dispatch -> wait(any) -> results -> cancel", async () => {
    const { agentId, parentId } = await setup();
    const client = new DaemonClient({ baseUrl: "http://daemon.test", token: rawToken, fetchImpl: injectFetch });

    const dispatched = await orch.handleDispatchSubtasks(
      orch.DispatchSubtasksInputSchema.parse({ taskId: parentId, subtasks: [{ title: "x" }, { title: "y" }] }),
      client,
    );
    expect(orch.DispatchSubtasksOutputSchema.parse(dispatched)).toMatchObject({ ok: true, replayed: false });
    const ids = (dispatched as { subtasks: Array<{ task_id: string }> }).subtasks.map((s) => s.task_id);

    const waiting = orch.handleWaitForSubtasks(
      orch.WaitForSubtasksInputSchema.parse({ taskId: parentId, until: "any", timeoutMs: 10_000 }),
      client,
    );
    const claim = await cliJson<{ attempt: { attempt_id: string }; fencingToken: number }>(
      "task", "claim", ids[1]!, "--agent-id", agentId, "--workspace-session-id", "ws-1",
    );
    await cliJson(
      "task", "complete", ids[1]!, "--attempt-id", claim.attempt.attempt_id, "--fencing-token", String(claim.fencingToken),
    );
    const woke = await waiting;
    expect(orch.WaitForSubtasksOutputSchema.parse(woke)).toMatchObject({ ok: true, woke: "any_succeeded" });

    const results = await orch.handleGetSubtaskResults({ taskId: parentId }, client);
    expect(orch.SubtaskResultsOutputSchema.parse(results)).toMatchObject({ ok: true, summary: { succeeded: 1, total: 2 } });

    const cancelled = await orch.handleCancelSubtasks({ taskId: parentId }, client);
    expect(orch.CancelSubtasksOutputSchema.parse(cancelled)).toMatchObject({ ok: true, summary: { outcome: "partial" } });

    const missing = await orch.handleGetSubtaskResults({ taskId: "nope" }, client);
    expect(missing).toMatchObject({ ok: false });
  });
});

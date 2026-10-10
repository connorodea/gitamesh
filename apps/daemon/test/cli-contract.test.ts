/**
 * Contract test: the real `gitamesh` CLI against a real (in-memory) daemon.
 *
 * The CLI's own unit tests use a fake `fetch`, so they can only assert the
 * body shape the CLI author BELIEVED the daemon wants — which is how
 * `task claim` shipped sending `agent_id`/`workspace_session_id` to a
 * route whose schema requires `agentId`/`workspaceSessionId`. Here every
 * request the CLI builds goes through the daemon's actual zod schemas.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { runCli } from "../../../packages/cli/src/cli.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { mintToken, SCOPES } from "../src/auth.js";

let storage: SqliteStorageAdapter;
let built: BuiltServer;
let cwd: string;
let rawToken: string;

beforeEach(async () => {
  storage = createInMemorySqliteStorage();
  built = buildServer({ storage, logger: false });
  rawToken = mintToken(storage, [...SCOPES]).rawToken;
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-cli-contract-"));
});

afterEach(async () => {
  await built.app.close();
  storage.close();
  await fs.rm(cwd, { recursive: true, force: true });
});

/** Routes the CLI's `fetch` calls into the daemon via `app.inject`. */
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

async function cli(...args: string[]): Promise<{ code: number; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await runCli(["node", "gitamesh", ...args], {
    cwd,
    env: { GITAMESH_TOKEN: rawToken },
    sink: { log: (line) => logs.push(line), error: (line) => errors.push(line) },
    fetchImpl: injectFetch,
  });
  return { code, logs, errors };
}

async function cliJson<T>(...args: string[]): Promise<T> {
  const result = await cli(...args, "--json");
  expect(result.errors).toEqual([]);
  expect(result.code).toBe(0);
  return JSON.parse(result.logs.join("\n")) as T;
}

interface Claimed {
  attempt: { attempt_id: string; status: string };
  fencingToken: number;
  resourceClaims: Array<{ resource_key: string; mode: string }>;
}

async function createAgentAndTask(repositoryId = "repo-1"): Promise<{ agentId: string; taskId: string }> {
  const { agent } = await cliJson<{ agent: { agent_id: string } }>(
    "agent", "register", "--display-name", "contract", "--runtime", "custom",
  );
  const { task } = await cliJson<{ task: { task_id: string } }>(
    "task", "create", "--workflow-id", "wf-1", "--repository-id", repositoryId, "--title", "t",
  );
  return { agentId: agent.agent_id, taskId: task.task_id };
}

async function claim(taskId: string, agentId: string, ...extra: string[]): Promise<Claimed> {
  return cliJson<Claimed>(
    "task", "claim", taskId, "--agent-id", agentId, "--workspace-session-id", "ws-1", ...extra,
  );
}

describe("gitamesh CLI <-> daemon request contract", () => {
  it("task claim is accepted and its resource claim is listed by `lock list`", async () => {
    const { agentId, taskId } = await createAgentAndTask();

    const claimed = await claim(taskId, agentId, "--resource", "path:write:src/app.ts");

    expect(claimed.attempt.status).toBe("running");
    expect(claimed.resourceClaims.map((c) => c.resource_key)).toEqual(["src/app.ts"]);

    const mine = await cliJson<Array<{ resource_key: string }>>(
      "lock", "list", "--claims", "--repository-id", "repo-1",
    );
    expect(mine.map((c) => c.resource_key)).toEqual(["src/app.ts"]);
    // The repository filter must actually reach the daemon (`?repositoryId=`).
    expect(
      await cliJson<unknown[]>("lock", "list", "--claims", "--repository-id", "other-repo"),
    ).toEqual([]);
  });

  it("task list --repository-id filters on the daemon side", async () => {
    await createAgentAndTask("repo-1");
    await createAgentAndTask("repo-2");

    const tasks = await cliJson<Array<{ repository_id: string }>>(
      "task", "list", "--repository-id", "repo-2",
    );
    expect(tasks.map((t) => t.repository_id)).toEqual(["repo-2"]);
  });

  it("task heartbeat and task complete are accepted with the claim's fencing token", async () => {
    const { agentId, taskId } = await createAgentAndTask();
    const { attempt, fencingToken } = await claim(taskId, agentId);
    const fence = ["--attempt-id", attempt.attempt_id, "--fencing-token", String(fencingToken)];

    expect((await cli("task", "heartbeat", taskId, ...fence)).code).toBe(0);
    const done = await cliJson<{ task: { status: string } }>("task", "complete", taskId, ...fence);
    expect(done.task.status).toBe("completed");
  });

  it("task fail is accepted", async () => {
    const { agentId, taskId } = await createAgentAndTask();
    const { attempt, fencingToken } = await claim(taskId, agentId);

    const failed = await cliJson<{ attempt: { status: string; error: string } }>(
      "task", "fail", taskId,
      "--attempt-id", attempt.attempt_id,
      "--fencing-token", String(fencingToken),
      "--error", "boom",
    );
    expect(failed.attempt.status).toBe("failed");
    expect(failed.attempt.error).toBe("boom");
  });

  it("task cancel is accepted and releases the claim", async () => {
    const { agentId, taskId } = await createAgentAndTask();
    await claim(taskId, agentId, "--resource", "path:write:src/app.ts");

    const cancelled = await cliJson<{ task: { status: string } }>("task", "cancel", taskId);
    expect(cancelled.task.status).toBe("cancelled");
    expect(await cliJson<unknown[]>("lock", "list", "--claims")).toEqual([]);
  });

  it("lock release <claimId> releases a task's resource claim", async () => {
    const { agentId, taskId } = await createAgentAndTask();
    await claim(taskId, agentId, "--resource", "path:write:src/app.ts");
    const [held] = await cliJson<Array<{ resource_claim_id: string }>>("lock", "list", "--claims");

    expect(await cliJson<{ released: boolean }>("lock", "release", held!.resource_claim_id)).toEqual({
      released: true,
    });
    expect(await cliJson<unknown[]>("lock", "list", "--claims")).toEqual([]);
  });

  it("a refused request prints the failure as line 1, then the problem's fields", async () => {
    const { agentId, taskId } = await createAgentAndTask();
    await claim(taskId, agentId);

    const second = await cli(
      "task", "claim", taskId, "--agent-id", agentId, "--workspace-session-id", "ws-2",
    );
    expect(second.code).toBe(1);
    expect(second.logs).toEqual([]);
    expect(second.errors[0]).toBe(
      `Error: POST /v1/tasks/${taskId}/claim failed (409): Task not claimable — Task ${taskId} is in status "running" and cannot be claimed.`,
    );
    expect(second.errors.slice(1)).toEqual([
      "  type: https://gitamesh.dev/problems/task-not-claimable",
      `  task_id: ${taskId}`,
      "  current_status: running",
    ]);
  });

  it("a body that fails the daemon's schema is one readable line, not a JSON dump", async () => {
    const result = await cli(
      "task", "create", "--workflow-id", "wf-1", "--repository-id", "repo-1",
      "--title", "t", "--priority", "not-a-number",
    );
    expect(result.code).toBe(1);
    expect(result.errors[0]).toMatch(/^Error: POST \/v1\/tasks failed \(400\): Invalid request body — priority: /);
    expect(result.errors.join("\n")).not.toContain("[");
  });

  it("repo register is accepted and the repository is then listed by the daemon", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd });

    const { repository, replayed } = await cliJson<{
      repository: { repository_id: string; display_name: string; default_branch: string; metadata: Record<string, unknown> };
      replayed: boolean;
    }>("repo", "register", "--display-name", "contract-repo");

    expect(replayed).toBe(false);
    expect(repository.display_name).toBe("contract-repo");
    expect(repository.default_branch).toBe("main");
    // The daemon keys the repository by the CLI's local id, the same id
    // `repo status` prints and `task create --repository-id` takes.
    const status = await cliJson<{ repository_id: string }>("repo", "status");
    expect(repository.repository_id).toBe(status.repository_id);
    expect(storage.listRepositories()).toEqual([repository]);

    // Registering again is a replay, not a second repository.
    const again = await cliJson<{ replayed: boolean }>("repo", "register");
    expect(again.replayed).toBe(true);
    expect(storage.listRepositories()).toHaveLength(1);
  });

  it("agent heartbeat is accepted", async () => {
    const { agentId } = await createAgentAndTask();

    const beat = await cliJson<{ agent: { status: string } }>("agent", "heartbeat", agentId);
    expect(beat.agent.status).toBe("online");
  });
});

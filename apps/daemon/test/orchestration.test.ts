/**
 * Async multi-agent orchestration routes (ADR-0002): dispatch N subtasks
 * under a parent, read their results as one fan-in summary, long-poll until
 * they settle, and cancel the ones still running.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { buildServer, type BuiltServer } from "../src/server.js";
import { mintToken } from "../src/auth.js";

let storage: SqliteStorageAdapter;
let built: BuiltServer;
let headers: Record<string, string>;

beforeEach(() => {
  storage = createInMemorySqliteStorage();
  built = buildServer({ storage, logger: false, rateLimitPerMinute: 10_000 });
  headers = { authorization: `Bearer ${mintToken(storage, ["admin"]).rawToken}` };
});

afterEach(async () => {
  await built.app.close();
  storage.close();
});

async function post(url: string, payload: unknown, extra: Record<string, string> = {}) {
  return built.app.inject({ method: "POST", url, headers: { ...headers, ...extra }, payload: payload as object });
}

async function newAgent(): Promise<string> {
  const res = await post("/v1/agents", { display_name: "worker", runtime: "custom" });
  return res.json().agent.agent_id as string;
}

async function newParent(): Promise<string> {
  const res = await post("/v1/tasks", { repository_id: "repo_1", title: "orchestrate", workflow_id: "wf_orch" });
  expect(res.statusCode).toBe(201);
  return res.json().task.task_id as string;
}

async function dispatch(parentId: string, titles: string[], extra: object = {}) {
  const res = await post(`/v1/tasks/${parentId}/dispatch`, { subtasks: titles.map((title) => ({ title })), ...extra });
  expect(res.statusCode).toBe(201);
  return (res.json().subtasks as Array<{ task_id: string }>).map((t) => t.task_id);
}

async function finish(taskId: string, agentId: string, result: Record<string, unknown>) {
  const claim = await post(`/v1/tasks/${taskId}/claim`, { agentId, workspaceSessionId: "ws_1" });
  const { attempt, fencingToken } = claim.json() as { attempt: { attempt_id: string }; fencingToken: number };
  const res = await post(`/v1/tasks/${taskId}/complete`, { attemptId: attempt.attempt_id, fencingToken, result });
  expect(res.statusCode).toBe(200);
}

describe("POST /v1/tasks/:taskId/dispatch", () => {
  it("creates the children under the parent and returns at once", async () => {
    const parent = await newParent();
    const res = await post(`/v1/tasks/${parent}/dispatch`, {
      subtasks: [{ title: "a", description: "first" }, { title: "b", priority: 3 }],
      deadline_at: "2099-01-01T00:00:00.000Z",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { subtasks: Array<Record<string, unknown>>; replayed: boolean };
    expect(body.replayed).toBe(false);
    expect(body.subtasks).toHaveLength(2);
    expect(body.subtasks[0]).toMatchObject({ parent_task_id: parent, workflow_id: "wf_orch", description: "first", status: "pending" });
    expect(body.subtasks[1]).toMatchObject({ priority: 3, deadline_at: "2099-01-01T00:00:00.000Z" });
  });

  it("replays with the same Idempotency-Key instead of creating more children", async () => {
    const parent = await newParent();
    const first = await post(`/v1/tasks/${parent}/dispatch`, { subtasks: [{ title: "a" }] }, { "idempotency-key": "k1" });
    const second = await post(`/v1/tasks/${parent}/dispatch`, { subtasks: [{ title: "a" }] }, { "idempotency-key": "k1" });
    expect(second.json().replayed).toBe(true);
    expect(second.json().subtasks).toEqual(first.json().subtasks);
    const summary = await built.app.inject({ method: "GET", url: `/v1/tasks/${parent}/subtasks`, headers });
    expect(summary.json().total).toBe(1);
  });

  it("answers 404 for an unknown parent and 400 for an empty list", async () => {
    expect((await post("/v1/tasks/nope/dispatch", { subtasks: [{ title: "a" }] })).statusCode).toBe(404);
    const parent = await newParent();
    expect((await post(`/v1/tasks/${parent}/dispatch`, { subtasks: [] })).statusCode).toBe(400);
  });
});

describe("GET /v1/tasks/:taskId/subtasks", () => {
  it("returns each child's result once workers complete them", async () => {
    const agent = await newAgent();
    const parent = await newParent();
    const [a, b] = await dispatch(parent, ["a", "b"]);
    await finish(a!, agent, { lines: 10 });

    const res = await built.app.inject({ method: "GET", url: `/v1/tasks/${parent}/subtasks`, headers });
    expect(res.statusCode).toBe(200);
    const summary = res.json();
    expect(summary).toMatchObject({ total: 2, settled: 1, succeeded: 1, outcome: "running", all_settled: false });
    expect(summary.subtasks.find((s: { task_id: string }) => s.task_id === a)).toMatchObject({ result: { lines: 10 } });
    expect(summary.subtasks.find((s: { task_id: string }) => s.task_id === b)).toMatchObject({ status: "pending" });
  });
});

describe("POST /v1/tasks/:taskId/wait", () => {
  it("returns at once when the condition already holds", async () => {
    const agent = await newAgent();
    const parent = await newParent();
    const [a] = await dispatch(parent, ["a"]);
    await finish(a!, agent, {});
    const res = await post(`/v1/tasks/${parent}/wait`, { timeout_ms: 5_000 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ woke: "all_settled", summary: { outcome: "succeeded" } });
  });

  it("blocks until the last child completes, then wakes without polling", async () => {
    const agent = await newAgent();
    const parent = await newParent();
    const [a, b] = await dispatch(parent, ["a", "b"]);
    await finish(a!, agent, {});

    const waiting = post(`/v1/tasks/${parent}/wait`, { until: "all", timeout_ms: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    await finish(b!, agent, { done: true });

    const res = await waiting;
    expect(res.json()).toMatchObject({ woke: "all_settled", summary: { succeeded: 2, outcome: "succeeded" } });
    expect(res.json().waited_ms).toBeLessThan(10_000);
  });

  it("returns woke=timeout with the partial summary when children are still running", async () => {
    const parent = await newParent();
    await dispatch(parent, ["a"]);
    const res = await post(`/v1/tasks/${parent}/wait`, { timeout_ms: 100 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ woke: "timeout", summary: { total: 1, settled: 0, outcome: "running" } });
  });

  it("wakes on the first permanent failure with fail_fast", async () => {
    const agent = await newAgent();
    const parent = await newParent();
    const [a] = await dispatch(parent, ["a", "b"]);
    // Three failed attempts exhaust the default retry limit.
    for (let i = 0; i < 3; i += 1) {
      const claim = await post(`/v1/tasks/${a}/claim`, { agentId: agent, workspaceSessionId: "ws_1" });
      const { attempt, fencingToken } = claim.json() as { attempt: { attempt_id: string }; fencingToken: number };
      await post(`/v1/tasks/${a}/fail`, { attemptId: attempt.attempt_id, fencingToken, error: "boom" });
    }
    const res = await post(`/v1/tasks/${parent}/wait`, { fail_fast: true, timeout_ms: 1_000 });
    expect(res.json()).toMatchObject({ woke: "failure", summary: { failed: 1 } });
  });

  it("rejects a timeout above the cap", async () => {
    const parent = await newParent();
    expect((await post(`/v1/tasks/${parent}/wait`, { timeout_ms: 10_000_000 })).statusCode).toBe(400);
  });
});

describe("POST /v1/tasks/:taskId/cancel-subtasks", () => {
  it("cancels unsettled children, including a running one, and leaves finished ones alone", async () => {
    const agent = await newAgent();
    const parent = await newParent();
    const [a, b, c] = await dispatch(parent, ["a", "b", "c"]);
    await finish(a!, agent, {});
    await post(`/v1/tasks/${b}/claim`, { agentId: agent, workspaceSessionId: "ws_1" });

    const res = await post(`/v1/tasks/${parent}/cancel-subtasks`, {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cancelled.map((t: { task_id: string }) => t.task_id).sort()).toEqual([b, c].sort());
    expect(body.summary).toMatchObject({ succeeded: 1, cancelled: 2, all_settled: true, outcome: "partial" });
    expect(storage.getTask(parent)!.status).toBe("pending");
  });
});

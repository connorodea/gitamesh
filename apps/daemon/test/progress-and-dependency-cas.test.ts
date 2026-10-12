/**
 * Two coordination guards:
 *  - POST/GET /v1/tasks/:taskId/progress: a progress report is accepted only
 *    from the task's current, unexpired attempt (fencing token), and never
 *    renews the lease.
 *  - PATCH /v1/tasks/:taskId `expected_dependencies`: a compare-and-set, so an
 *    agent editing dependencies from a stale read gets a 409 instead of
 *    silently overwriting a concurrent edit.
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
  const res = await post("/v1/agents", { display_name: "agent", runtime: "custom" });
  expect(res.statusCode).toBe(201);
  return res.json().agent.agent_id as string;
}

async function newTask(title: string, dependencies: string[] = []): Promise<string> {
  const res = await post("/v1/tasks", { repository_id: "repo_1", title, dependencies });
  expect(res.statusCode).toBe(201);
  return res.json().task.task_id as string;
}

async function claim(taskId: string, agentId: string) {
  const res = await post(`/v1/tasks/${taskId}/claim`, { agentId, workspaceSessionId: "ws_1" });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { attempt: { attempt_id: string }; fencingToken: number };
  return { attemptId: body.attempt.attempt_id, fencingToken: body.fencingToken };
}

const report = (attemptId: string, fencingToken: number, extra: object = {}) => ({
  attemptId,
  fencingToken,
  summary: "parsed the manifest",
  phase: "working",
  ...extra,
});

describe("task progress reports", () => {
  it("records a report from the current attempt and lists it for that task only", async () => {
    const agent = await newAgent();
    const taskId = await newTask("A");
    const other = await newTask("B");
    const { attemptId, fencingToken } = await claim(taskId, agent);
    await claim(other, agent);

    const res = await post(`/v1/tasks/${taskId}/progress`, report(attemptId, fencingToken, { evidence: ["log line 1"] }));
    expect(res.statusCode).toBe(201);
    expect(res.json().replayed).toBe(false);

    const listed = await built.app.inject({ method: "GET", url: `/v1/tasks/${taskId}/progress`, headers });
    expect(listed.statusCode).toBe(200);
    const { events, nextCursor } = listed.json() as { events: Array<{ event_type: string; task_id: string; attempt_id: string; payload: Record<string, unknown> }>; nextCursor: number };
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "task.progress", task_id: taskId, attempt_id: attemptId });
    expect(events[0]!.payload).toMatchObject({ summary: "parsed the manifest", phase: "working", evidence: ["log line 1"] });

    // Reading again from the returned cursor yields nothing new.
    const again = await built.app.inject({ method: "GET", url: `/v1/tasks/${taskId}/progress?since=${nextCursor}`, headers });
    expect(again.json().events).toEqual([]);
  });

  it("rejects a wrong fencing token and records nothing", async () => {
    const agent = await newAgent();
    const taskId = await newTask("A");
    const { attemptId, fencingToken } = await claim(taskId, agent);

    const res = await post(`/v1/tasks/${taskId}/progress`, report(attemptId, fencingToken + 1));
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toMatch(/stale-attempt-token/);
    const listed = await built.app.inject({ method: "GET", url: `/v1/tasks/${taskId}/progress`, headers });
    expect(listed.json().events).toEqual([]);
  });

  it("rejects an attempt that belongs to a different task", async () => {
    const agent = await newAgent();
    const taskA = await newTask("A");
    const taskB = await newTask("B");
    const a = await claim(taskA, agent);
    await claim(taskB, agent);

    const res = await post(`/v1/tasks/${taskB}/progress`, report(a.attemptId, a.fencingToken));
    expect(res.statusCode).toBe(409);
  });

  it("rejects an unknown attempt with 404", async () => {
    const taskId = await newTask("A");
    const res = await post(`/v1/tasks/${taskId}/progress`, report("attempt_nope", 1));
    expect(res.statusCode).toBe(404);
  });

  it("rejects a report once the attempt's lease has expired", async () => {
    const agent = await newAgent();
    const taskId = await newTask("A");
    const { attemptId, fencingToken } = await claim(taskId, agent);
    const attempt = storage.getAttempt(attemptId)!;
    storage.saveAttempt({ ...attempt, expires_at: new Date(Date.now() - 1000).toISOString() });

    const res = await post(`/v1/tasks/${taskId}/progress`, report(attemptId, fencingToken));
    expect(res.statusCode).toBe(409);
  });

  it("rejects a report after the task completed", async () => {
    const agent = await newAgent();
    const taskId = await newTask("A");
    const { attemptId, fencingToken } = await claim(taskId, agent);
    const done = await post(`/v1/tasks/${taskId}/complete`, { attemptId, fencingToken });
    expect(done.statusCode).toBe(200);

    const res = await post(`/v1/tasks/${taskId}/progress`, report(attemptId, fencingToken));
    expect(res.statusCode).toBe(409);
  });

  it("does not renew the lease", async () => {
    const agent = await newAgent();
    const taskId = await newTask("A");
    const { attemptId, fencingToken } = await claim(taskId, agent);
    const before = storage.getAttempt(attemptId)!;

    const res = await post(`/v1/tasks/${taskId}/progress`, report(attemptId, fencingToken));
    expect(res.statusCode).toBe(201);
    const after = storage.getAttempt(attemptId)!;
    expect(after.expires_at).toBe(before.expires_at);
    expect(after.heartbeat_at).toBe(before.heartbeat_at);
  });

  it("replays a retry with the same Idempotency-Key instead of recording twice", async () => {
    const agent = await newAgent();
    const taskId = await newTask("A");
    const { attemptId, fencingToken } = await claim(taskId, agent);
    const key = { "idempotency-key": "progress-1" };

    const first = await post(`/v1/tasks/${taskId}/progress`, report(attemptId, fencingToken), key);
    const second = await post(`/v1/tasks/${taskId}/progress`, report(attemptId, fencingToken), key);
    expect(first.json().replayed).toBe(false);
    expect(second.json().replayed).toBe(true);
    const listed = await built.app.inject({ method: "GET", url: `/v1/tasks/${taskId}/progress`, headers });
    expect(listed.json().events).toHaveLength(1);
  });

  it("rejects a malformed report with 400", async () => {
    const taskId = await newTask("A");
    const res = await post(`/v1/tasks/${taskId}/progress`, { attemptId: "x", fencingToken: 1, summary: "", phase: "nope" });
    expect(res.statusCode).toBe(400);
  });
});

describe("dependency edits with expected_dependencies", () => {
  async function patch(taskId: string, payload: object) {
    return built.app.inject({ method: "PATCH", url: `/v1/tasks/${taskId}`, headers, payload });
  }

  it("applies the edit when the expected set matches, regardless of order or duplicates", async () => {
    const a = await newTask("A");
    const b = await newTask("B");
    const c = await newTask("C");
    const task = await newTask("T", [a, b]);

    const res = await patch(task, { dependencies: [c], expected_dependencies: [b, a, a] });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.dependencies).toEqual([c]);
    expect(storage.getTask(task)!.dependencies).toEqual([c]);
  });

  it("rejects with 409 and changes nothing when the expected set is stale", async () => {
    const a = await newTask("A");
    const b = await newTask("B");
    const task = await newTask("T", [a]);
    const revisionsBefore = storage.listTaskRevisions(task).length;

    const res = await patch(task, { dependencies: [b], expected_dependencies: [] });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toMatch(/dependencies-changed/);
    expect(storage.getTask(task)!.dependencies).toEqual([a]);
    expect(storage.listTaskRevisions(task)).toHaveLength(revisionsBefore);
  });

  it("still accepts an edit with no expected_dependencies (unchanged behaviour)", async () => {
    const a = await newTask("A");
    const task = await newTask("T");
    const res = await patch(task, { dependencies: [a] });
    expect(res.statusCode).toBe(200);
  });

  it("rejects expected_dependencies sent without dependencies", async () => {
    const task = await newTask("T");
    const res = await patch(task, { title: "x", expected_dependencies: [] });
    expect(res.statusCode).toBe(400);
  });
});

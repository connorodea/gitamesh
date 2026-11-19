import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinationEngine } from "@gitamesh/core";
import { createInMemorySqliteStorage, type SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import type { Task } from "@gitamesh/protocol";
import { mintToken } from "../src/auth.js";
import { EventBroadcaster } from "../src/events-bus.js";
import { Metrics } from "../src/metrics.js";
import { RateLimiter } from "../src/rate-limit.js";
import { registerAgentRoutes } from "../src/routes/agents.js";
import { registerTaskRoutes } from "../src/routes/tasks.js";
import { registerQueueRoutes } from "../src/routes/queue.js";

let storage: SqliteStorageAdapter;
let app: FastifyInstance;
let engine: CoordinationEngine;
let broadcaster: EventBroadcaster;
let queueLimiter: RateLimiter;
let headers: Record<string, string>;
let activeWaiters: number;

beforeEach(() => {
  storage = createInMemorySqliteStorage();
  app = Fastify({ logger: false });
  engine = new CoordinationEngine(storage);
  const metrics = new Metrics();
  broadcaster = new EventBroadcaster(storage, metrics);
  const limiter = new RateLimiter(10_000);
  queueLimiter = new RateLimiter(10_000);
  activeWaiters = 0;
  const subscribe = broadcaster.onChange.bind(broadcaster);
  vi.spyOn(broadcaster, "onChange").mockImplementation((listener) => {
    activeWaiters += 1;
    const unsubscribe = subscribe(listener);
    let active = true;
    return () => {
      if (active) activeWaiters -= 1;
      active = false;
      unsubscribe();
    };
  });
  // Compose the real daemon routes over one real SQLite engine. This keeps
  // queue behavior tests independent of unrelated UI/WebSocket registration.
  registerAgentRoutes(app, storage, broadcaster, limiter);
  registerTaskRoutes(app, storage, engine, broadcaster, metrics, limiter);
  registerQueueRoutes(app, storage, engine, broadcaster, metrics, queueLimiter);
  headers = { authorization: `Bearer ${mintToken(storage, ["admin"]).rawToken}` };
});

afterEach(async () => {
  await app.close();
  expect(activeWaiters).toBe(0);
  storage.close();
  vi.restoreAllMocks();
});

async function post(url: string, payload: object, auth = headers) {
  return app.inject({ method: "POST", url, payload, headers: auth });
}

async function agent(capabilities: string[] = []) {
  const response = await post("/v1/agents", { display_name: "worker", runtime: "custom", capabilities });
  expect(response.statusCode).toBe(201);
  return response.json().agent.agent_id as string;
}

async function task(title: string, fields: Partial<Task> = {}): Promise<Task> {
  const response = await post("/v1/tasks", { repository_id: "repo_queue", title, ...fields });
  expect(response.statusCode).toBe(201);
  return response.json().task as Task;
}

function claimBody(agentId: string, extra: object = {}) {
  return { repositoryId: "repo_queue", agentId, workspaceSessionId: "session_queue", ...extra };
}

async function waitForCount(count: number) {
  await vi.waitFor(() => expect(activeWaiters).toBe(count), { timeout: 1_000, interval: 5 });
}

async function complete(taskId: string, agentId: string) {
  const acquired = await post(`/v1/tasks/${taskId}/claim`, { agentId, workspaceSessionId: "dependency_session" });
  expect(acquired.statusCode).toBe(200);
  const { attempt, fencingToken } = acquired.json();
  const response = await post(`/v1/tasks/${taskId}/complete`, { attemptId: attempt.attempt_id, fencingToken });
  expect(response.statusCode).toBe(200);
}

describe("remote task queue", () => {
  it("requires header authentication, both read/claim scopes, and a registered agent", async () => {
    const worker = await agent();
    const body = claimBody(worker);
    expect((await post("/v1/queue/claim", body, {})).statusCode).toBe(401);
    for (const scope of ["task:read", "task:claim"] as const) {
      const only = mintToken(storage, [scope]);
      expect((await post("/v1/queue/claim", body, { authorization: `Bearer ${only.rawToken}` })).statusCode).toBe(403);
    }
    const narrow = mintToken(storage, ["task:read", "task:claim"]);
    expect((await post(`/v1/queue/claim?token=${narrow.rawToken}`, body, {})).statusCode).toBe(401);
    const authorized = { authorization: `Bearer ${narrow.rawToken}` };
    expect((await post("/v1/queue/claim", body, authorized)).statusCode).toBe(200);
    expect((await post("/v1/queue/claim", claimBody("missing-agent"), authorized)).statusCode).toBe(404);
  });

  it("rejects malformed parameters and unbounded waits", async () => {
    const worker = await agent();
    for (const extra of [{ waitMs: -1 }, { waitMs: 25_001 }, { waitMs: 0.5 }, { repositoryId: " " }, { command: "execute me" }]) {
      expect((await post("/v1/queue/claim", claimBody(worker, extra))).statusCode).toBe(400);
    }
  });

  it("does not assign new work to revoked or draining agents", async () => {
    const worker = await agent();
    const submitted = await task("await an available worker");
    const registered = storage.getAgent(worker)!;
    storage.saveAgent({ ...registered, status: "draining" });
    expect((await post("/v1/queue/claim", claimBody(worker))).statusCode).toBe(409);
    storage.saveAgent({ ...registered, status: "revoked" });
    expect((await post("/v1/queue/claim", claimBody(worker))).statusCode).toBe(403);
    expect(storage.getTask(submitted.task_id)?.status).toBe("pending");
  });

  it("orders ready tasks by priority, skips incompatible work, and confines selection to the requested repository", async () => {
    const worker = await agent(["typescript"]);
    await task("foreign", { repository_id: "repo_elsewhere", priority: 999 });
    await task("GPU only", { required_capabilities: ["gpu"], priority: 100 });
    const low = await task("low", { priority: 1 });
    const high = await task("high", { priority: 10, required_capabilities: ["typescript"] });
    const manual = await task("manually blocked", { priority: 500 });
    storage.saveTask({ ...manual, status: "blocked" });
    const first = await post("/v1/queue/claim", claimBody(worker));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ task: { task_id: high.task_id, status: "running" }, attempt: { agent_id: worker }, replayed: false });
    expect(first.json().fencingToken).toBeGreaterThan(0);
    expect((await post("/v1/queue/claim", claimBody(worker))).json().task.task_id).toBe(low.task_id);
    expect((await post("/v1/queue/claim", claimBody(worker))).json()).toMatchObject({ task: null, attempt: null, fencingToken: null, reason: "no_ready_task" });
    expect(storage.getTask(manual.task_id)?.status).toBe("blocked");
  });

  it("uses a stable oldest-first/task-id tie break for equal priorities", async () => {
    const worker = await agent();
    const first = await task("older");
    const second = await task("newer");
    storage.saveTask({ ...first, created_at: "2026-01-01T00:00:00.000Z" });
    storage.saveTask({ ...second, created_at: "2026-01-02T00:00:00.000Z" });
    expect((await post("/v1/queue/claim", claimBody(worker))).json().task.task_id).toBe(first.task_id);
    const third = await task("same time");
    storage.saveTask({ ...third, created_at: "2026-01-02T00:00:00.000Z" });
    const expected = [second.task_id, third.task_id].sort((a, b) => a.localeCompare(b))[0];
    expect((await post("/v1/queue/claim", claimBody(worker))).json().task.task_id).toBe(expected);
  });

  it("wakes a waiting worker when API submission creates a task and keeps the normal fenced lifecycle", async () => {
    const worker = await agent();
    const rateCheck = vi.spyOn(queueLimiter, "check");
    const waiting = post("/v1/queue/claim", claimBody(worker, { waitMs: 1_000 }));
    await waitForCount(1);
    const submitted = await task("submitted remotely");
    const response = await waiting;
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.task.task_id).toBe(submitted.task_id);
    expect(result.waitedMs).toBeLessThan(1_000);
    expect(rateCheck).toHaveBeenCalledTimes(1);
    expect(activeWaiters).toBe(0);
    expect((await post(`/v1/tasks/${submitted.task_id}/heartbeat`, { attemptId: result.attempt.attempt_id, fencingToken: result.fencingToken })).statusCode).toBe(200);
    expect((await post(`/v1/tasks/${submitted.task_id}/complete`, { attemptId: result.attempt.attempt_id, fencingToken: result.fencingToken, result: { output: "done" } })).statusCode).toBe(200);
    expect(storage.getTask(submitted.task_id)?.status).toBe("completed");
  });

  it("gives exactly one of two waiting workers the only submitted task", async () => {
    const workers = [await agent(), await agent()];
    const waiting = workers.map((worker) => post("/v1/queue/claim", claimBody(worker, { waitMs: 200 })));
    await waitForCount(2);
    const submitted = await task("one task, two workers");
    const responses = await Promise.all(waiting);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const bodies = responses.map((response) => response.json());
    expect(bodies.filter((body) => body.task !== null)).toHaveLength(1);
    expect(bodies.filter((body) => body.reason === "timeout")).toHaveLength(1);
    expect(storage.getActiveAttemptsForTask(submitted.task_id)).toHaveLength(1);
    expect(activeWaiters).toBe(0);
  });

  it("waits for dependencies and wakes when their completion readies the task", async () => {
    const worker = await agent(["typescript"]);
    const dependency = await task("GPU prerequisite", { required_capabilities: ["gpu"] });
    const dependent = await task("then code", { required_capabilities: ["typescript"], dependencies: [dependency.task_id], priority: 50 });
    expect((await post("/v1/queue/claim", claimBody(worker))).json().task).toBeNull();
    const waiting = post("/v1/queue/claim", claimBody(worker, { waitMs: 1_000 }));
    await waitForCount(1);
    await complete(dependency.task_id, await agent(["gpu"]));
    expect((await waiting).json().task.task_id).toBe(dependent.task_id);
  });

  it("releases its listener on timeout and returns an explicit empty result", async () => {
    const worker = await agent();
    const response = await post("/v1/queue/claim", claimBody(worker, { waitMs: 30 }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ task: null, attempt: null, fencingToken: null, reason: "timeout" });
    expect(activeWaiters).toBe(0);
  });

  it("rescans durable tasks at timeout when a live signal was missed", async () => {
    const worker = await agent();
    const waiting = post("/v1/queue/claim", claimBody(worker, { waitMs: 100 }));
    await waitForCount(1);
    // Model a write by another daemon whose optional Redis ping was lost.
    const notify = vi.spyOn(broadcaster, "notifyNew").mockImplementation(() => {});
    const submitted = await task("persisted without notification");
    notify.mockRestore();
    expect((await waiting).json().task.task_id).toBe(submitted.task_id);
  });

  it("honors resource claims and retries when the resource is released", async () => {
    const worker = await agent();
    const held = await task("holder");
    const resource = { resourceType: "path", resourceKey: "src/shared.ts", mode: "write" };
    const current = await post(`/v1/tasks/${held.task_id}/claim`, { agentId: worker, workspaceSessionId: "holder", requiredResources: [resource] });
    const target = await task("waiting for resource");
    const waiting = post("/v1/queue/claim", claimBody(worker, { waitMs: 1_000, requiredResources: [resource] }));
    await waitForCount(1);
    expect(storage.getTask(target.task_id)?.status).toBe("pending");
    const { attempt, fencingToken } = current.json();
    await post(`/v1/tasks/${held.task_id}/complete`, { attemptId: attempt.attempt_id, fencingToken });
    const response = await waiting;
    expect(response.statusCode).toBe(200);
    expect(response.json().task.task_id).toBe(target.task_id);
    expect(response.json().resourceClaims).toHaveLength(1);
  });

  it("replays a successful Idempotency-Key, rejects changed parameters, and scopes replay to the token", async () => {
    const worker = await agent();
    const firstTask = await task("first", { priority: 10 });
    const nextTask = await task("next");
    const auth = { ...headers, "idempotency-key": "retry-safe" };
    const first = (await post("/v1/queue/claim", claimBody(worker), auth)).json();
    const replay = (await post("/v1/queue/claim", claimBody(worker), auth)).json();
    expect(first.task.task_id).toBe(firstTask.task_id);
    expect(replay).toMatchObject({ task: { task_id: firstTask.task_id }, attempt: { attempt_id: first.attempt.attempt_id }, replayed: true });
    expect(storage.getTask(nextTask.task_id)?.status).toBe("pending");
    expect((await post("/v1/queue/claim", claimBody(worker, { waitMs: 1 }), auth)).statusCode).toBe(409);
    const secondToken = mintToken(storage, ["task:read", "task:claim"]);
    const other = await post("/v1/queue/claim", claimBody(worker), { authorization: `Bearer ${secondToken.rawToken}`, "idempotency-key": "retry-safe" });
    expect(other.json().task.task_id).toBe(nextTask.task_id);
    expect(other.json().replayed).toBe(false);
  });

  it("does not cache empty results, and never replays an expired attempt as new work", async () => {
    const worker = await agent();
    const auth = { ...headers, "idempotency-key": "empty-then-claim" };
    expect((await post("/v1/queue/claim", claimBody(worker), auth)).json().task).toBeNull();
    const submitted = await task("later");
    const first = (await post("/v1/queue/claim", claimBody(worker), auth)).json();
    const endedAt = "2000-01-01T00:00:00.000Z";
    storage.saveAttempt({ ...storage.getAttempt(first.attempt.attempt_id)!, expires_at: endedAt });
    storage.saveLease({ ...storage.getLeaseByAttempt(first.attempt.attempt_id)!, expires_at: endedAt });
    const stale = await post("/v1/queue/claim", claimBody(worker), auth);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().type).toContain("queue-claim-expired");
    engine.expireStaleLeases();
    broadcaster.notifyNew();
    const recovered = await post("/v1/queue/claim", claimBody(worker), { ...headers, "idempotency-key": "replacement" });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().task.task_id).toBe(submitted.task_id);
    expect(recovered.json().fencingToken).toBeGreaterThan(first.fencingToken);
  });

  it("refuses a revoked token when work arrives during a wait", async () => {
    const worker = await agent();
    const credential = mintToken(storage, ["task:read", "task:claim"]);
    const waiting = post("/v1/queue/claim", claimBody(worker, { waitMs: 1_000 }), { authorization: `Bearer ${credential.rawToken}` });
    await waitForCount(1);
    storage.revokeToken(credential.tokenId, storage.now());
    const submitted = await task("must not be claimed");
    expect((await waiting).statusCode).toBe(401);
    expect(storage.getTask(submitted.task_id)?.status).toBe("pending");
  });

  it("refuses credentials that expire while a worker waits", async () => {
    const worker = await agent();
    const credential = mintToken(storage, ["task:read", "task:claim"], { expiresAt: new Date(Date.now() + 100).toISOString() });
    const waiting = post("/v1/queue/claim", claimBody(worker, { waitMs: 1_000 }), { authorization: `Bearer ${credential.rawToken}` });
    await waitForCount(1);
    await new Promise((resolve) => setTimeout(resolve, 110));
    const submitted = await task("after expiry");
    expect((await waiting).statusCode).toBe(401);
    expect(storage.getTask(submitted.task_id)?.status).toBe("pending");
  });

  it("removes a disconnected HTTP worker before subsequent tasks arrive", async () => {
    const worker = await agent();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const waiting = fetch(`${address}/v1/queue/claim`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(claimBody(worker, { waitMs: 10_000 })), signal: controller.signal,
    }).catch((error: Error) => error);
    await waitForCount(1);
    controller.abort();
    expect(await waiting).toBeInstanceOf(Error);
    await waitForCount(0);
    const submitted = await task("no worker remains");
    expect(storage.getTask(submitted.task_id)?.status).toBe("pending");
  });

  it("ends pending waits promptly during daemon shutdown", async () => {
    const worker = await agent();
    const waiting = post("/v1/queue/claim", claimBody(worker, { waitMs: 25_000 }));
    await waitForCount(1);
    await app.close();
    expect((await waiting).statusCode).toBe(503);
    expect(activeWaiters).toBe(0);
  });
});

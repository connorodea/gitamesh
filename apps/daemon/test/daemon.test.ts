import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { buildServer, type BuiltServer } from "../src/server.js";
import { mintToken, type Scope } from "../src/auth.js";

let storage: SqliteStorageAdapter;
let built: BuiltServer;

function auth(rawToken: string) {
  return { authorization: `Bearer ${rawToken}` };
}

function token(scopes: Scope[]): string {
  return mintToken(storage, scopes).rawToken;
}

beforeEach(() => {
  storage = createInMemorySqliteStorage();
  built = buildServer({ storage, logger: false });
});

afterEach(async () => {
  await built.app.close();
  storage.close();
});

describe("health endpoints require no auth", () => {
  it("GET /healthz returns ok with no Authorization header", async () => {
    const res = await built.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /readyz returns ok (storage reachable)", async () => {
    const res = await built.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("auth", () => {
  it("401s a protected route with no Authorization header", async () => {
    const res = await built.app.inject({ method: "GET", url: "/v1/tasks" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json().type).toContain("unauthorized");
  });

  it("403s when the token lacks the required scope", async () => {
    const readOnly = token(["events:read"]);
    const res = await built.app.inject({
      method: "GET",
      url: "/v1/tasks",
      headers: auth(readOnly),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toContain("forbidden");
  });

  it("an admin-scoped token satisfies any scope check", async () => {
    const admin = token(["admin"]);
    const res = await built.app.inject({
      method: "GET",
      url: "/v1/tasks",
      headers: auth(admin),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("full task lifecycle round trip", () => {
  it("register agent -> create task -> claim -> heartbeat -> complete -> GET shows completed", async () => {
    const admin = token(["admin"]);

    const agentRes = await built.app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: auth(admin),
      payload: { display_name: "test-agent", runtime: "custom" },
    });
    expect(agentRes.statusCode).toBe(201);
    const agentId = agentRes.json().agent.agent_id as string;

    const taskRes = await built.app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth(admin),
      payload: {
        repository_id: "repo_1",
        title: "Do the thing",
      },
    });
    expect(taskRes.statusCode).toBe(201);
    const taskId = taskRes.json().task.task_id as string;

    const claimRes = await built.app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/claim`,
      headers: auth(admin),
      payload: { agentId, workspaceSessionId: "ws_1", requiredResources: [] },
    });
    expect(claimRes.statusCode).toBe(200);
    const { attempt, fencingToken } = claimRes.json();

    const heartbeatRes = await built.app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/heartbeat`,
      headers: auth(admin),
      payload: { attemptId: attempt.attempt_id, fencingToken },
    });
    expect(heartbeatRes.statusCode).toBe(200);

    const completeRes = await built.app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/complete`,
      headers: auth(admin),
      payload: { attemptId: attempt.attempt_id, fencingToken, result: { ok: true } },
    });
    expect(completeRes.statusCode).toBe(200);

    const getRes = await built.app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}`,
      headers: auth(admin),
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().task.status).toBe("completed");
  });
});

describe("claim race", () => {
  it("exactly one of two concurrent claims on the same task succeeds", async () => {
    const admin = token(["admin"]);
    const taskRes = await built.app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth(admin),
      payload: { repository_id: "repo_race", title: "Race me" },
    });
    const taskId = taskRes.json().task.task_id as string;

    const [r1, r2] = await Promise.all([
      built.app.inject({
        method: "POST",
        url: `/v1/tasks/${taskId}/claim`,
        headers: auth(admin),
        payload: { agentId: "agent-a", workspaceSessionId: "ws-a", requiredResources: [] },
      }),
      built.app.inject({
        method: "POST",
        url: `/v1/tasks/${taskId}/claim`,
        headers: auth(admin),
        payload: { agentId: "agent-b", workspaceSessionId: "ws-b", requiredResources: [] },
      }),
    ]);

    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const conflictRes = r1.statusCode === 409 ? r1 : r2;
    expect(conflictRes.headers["content-type"]).toContain("application/problem+json");
    const body = conflictRes.json();
    expect(body.status).toBe(409);
    expect(
      ["task-already-claimed", "task-not-claimable"].some((t) => body.type.includes(t)),
    ).toBe(true);
  });
});

describe("idempotency", () => {
  it("the same Idempotency-Key on two POST /v1/tasks calls returns the same task, no duplicate row", async () => {
    const admin = token(["admin"]);
    const payload = { repository_id: "repo_idem", title: "Idempotent task" };
    const headers = { ...auth(admin), "idempotency-key": "fixed-key-1" };

    const first = await built.app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers,
      payload,
    });
    const second = await built.app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers,
      payload,
    });

    expect(first.json().task.task_id).toBe(second.json().task.task_id);
    expect(second.json().replayed).toBe(true);

    const listRes = await built.app.inject({
      method: "GET",
      url: "/v1/tasks?repositoryId=repo_idem",
      headers: auth(admin),
    });
    expect(listRes.json().tasks).toHaveLength(1);
  });

  it("the same Idempotency-Key on two claim calls replays the same attempt", async () => {
    const admin = token(["admin"]);
    const taskRes = await built.app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth(admin),
      payload: { repository_id: "repo_idem2", title: "T" },
    });
    const taskId = taskRes.json().task.task_id as string;
    const headers = { ...auth(admin), "idempotency-key": "claim-key-1" };
    const claimPayload = { agentId: "agent-a", workspaceSessionId: "ws-a", requiredResources: [] };

    const first = await built.app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/claim`,
      headers,
      payload: claimPayload,
    });
    const second = await built.app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/claim`,
      headers,
      payload: claimPayload,
    });

    expect(first.json().attempt.attempt_id).toBe(second.json().attempt.attempt_id);
    expect(second.json().replayed).toBe(true);
  });
});

describe("GET /metrics", () => {
  it("returns valid Prometheus text with a task-count-by-state line", async () => {
    const admin = token(["admin"]);
    await built.app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth(admin),
      payload: { repository_id: "repo_metrics", title: "M" },
    });

    const res = await built.app.inject({ method: "GET", url: "/metrics", headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("# HELP gitamesh_tasks_total");
    expect(res.body).toContain("# TYPE gitamesh_tasks_total gauge");
    expect(res.body).toMatch(/gitamesh_tasks_total\{status="pending"\} \d+/);
  });
});

describe("WebSocket event stream", () => {
  it("streams task lifecycle events live, then replays with no gaps on reconnect", async () => {
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    const address = built.app.server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected server to listen on a TCP address");
    }
    const baseUrl = `ws://127.0.0.1:${address.port}`;
    const httpBaseUrl = `http://127.0.0.1:${address.port}`;
    const admin = token(["admin"]);

    const ws = new WebSocket(`${baseUrl}/v1/events/stream?since=0`, {
      headers: auth(admin),
    });
    const received: { event_type: string; cursor: number }[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.on("message", (data) => {
      received.push(JSON.parse(data.toString()));
    });

    // Drive activity over plain HTTP while the socket is connected.
    const taskRes = await fetch(`${httpBaseUrl}/v1/tasks`, {
      method: "POST",
      headers: { ...auth(admin), "content-type": "application/json" },
      body: JSON.stringify({ repository_id: "repo_ws", title: "WS task" }),
    });
    const taskId = (await taskRes.json()).task.task_id as string;

    const claimRes = await fetch(`${httpBaseUrl}/v1/tasks/${taskId}/claim`, {
      method: "POST",
      headers: { ...auth(admin), "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-ws", workspaceSessionId: "ws-ws", requiredResources: [] }),
    });
    const { attempt, fencingToken } = await claimRes.json();

    await fetch(`${httpBaseUrl}/v1/tasks/${taskId}/complete`, {
      method: "POST",
      headers: { ...auth(admin), "content-type": "application/json" },
      body: JSON.stringify({ attemptId: attempt.attempt_id, fencingToken }),
    });

    // Give the broadcaster a tick to deliver everything over the socket.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const eventTypes = received.map((e) => e.event_type);
    expect(eventTypes).toContain("task.created");
    expect(eventTypes).toContain("task.claimed");
    expect(eventTypes).toContain("attempt.completed");
    // Order preserved: created before claimed before completed.
    expect(eventTypes.indexOf("task.created")).toBeLessThan(eventTypes.indexOf("task.claimed"));
    expect(eventTypes.indexOf("task.claimed")).toBeLessThan(eventTypes.indexOf("attempt.completed"));

    const lastCursor = received[received.length - 1]!.cursor;
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Reconnect from the last cursor we saw and generate one more event.
    const ws2 = new WebSocket(`${baseUrl}/v1/events/stream?since=${lastCursor}`, {
      headers: auth(admin),
    });
    const received2: { event_type: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      ws2.on("open", () => resolve());
      ws2.on("error", reject);
    });
    ws2.on("message", (data) => {
      received2.push(JSON.parse(data.toString()));
    });

    const taskRes2 = await fetch(`${httpBaseUrl}/v1/tasks`, {
      method: "POST",
      headers: { ...auth(admin), "content-type": "application/json" },
      body: JSON.stringify({ repository_id: "repo_ws", title: "second task" }),
    });
    await taskRes2.json();

    await new Promise((resolve) => setTimeout(resolve, 150));

    // Nothing before `lastCursor` was skipped: the only thing that
    // happened after reconnect is the second task's creation, and it must
    // show up. (Re-delivery of the boundary event, if any, is acceptable
    // at-least-once semantics — see events-bus.ts — but nothing is
    // missing.)
    expect(received2.map((e) => e.event_type)).toContain("task.created");

    ws2.close();
  });
});

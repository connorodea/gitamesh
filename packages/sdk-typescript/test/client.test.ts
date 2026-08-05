import { describe, expect, it } from "vitest";
import { GitameshClient } from "../src/client.js";
import { GitameshConflictError, GitameshAuthError } from "../src/errors.js";
import { createFakeFetch } from "./support/fake-fetch.js";

const baseUrl = "http://127.0.0.1:8787";

describe("GitameshClient — successful round trips", () => {
  it("registerAgent posts snake_case fields and returns the created agent", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/agents": {
        status: 201,
        body: {
          agent: { agent_id: "agent_1", display_name: "worker-1", runtime: "claude-code" },
          replayed: false,
        },
      },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    const result = await client.registerAgent({ displayName: "worker-1", runtime: "claude-code" });

    expect(result.agent.agent_id).toBe("agent_1");
    expect(calls[0]?.body).toMatchObject({ display_name: "worker-1", runtime: "claude-code" });
    expect(calls[0]?.headers.Authorization).toBe("Bearer gm_t");
  });

  it("createTask posts snake_case fields and returns the created task", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks": {
        status: 201,
        body: { task: { task_id: "task_1", title: "Do the thing" }, replayed: false },
      },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    const result = await client.createTask({ repositoryId: "repo_1", title: "Do the thing" });

    expect(result.task.task_id).toBe("task_1");
    expect(calls[0]?.body).toMatchObject({ repository_id: "repo_1", title: "Do the thing" });
  });

  it("claimTask posts camelCase fields matching the daemon's ClaimBody schema and returns attempt + fencingToken", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task_1/claim": {
        body: {
          attempt: { attempt_id: "attempt_1", task_id: "task_1" },
          fencingToken: 1,
          resourceClaims: [],
          replayed: false,
        },
      },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    const result = await client.claimTask("task_1", {
      agentId: "agent_1",
      workspaceSessionId: "ws_1",
      requiredResources: [{ resourceType: "path", resourceKey: "src/foo.ts", mode: "write" }],
    });

    expect(result.attempt.attempt_id).toBe("attempt_1");
    expect(result.fencingToken).toBe(1);
    expect(calls[0]?.body).toEqual({
      agentId: "agent_1",
      workspaceSessionId: "ws_1",
      requiredResources: [{ resourceType: "path", resourceKey: "src/foo.ts", mode: "write" }],
    });
  });

  it("heartbeatTaskAttempt posts camelCase fields matching the daemon's HeartbeatBody schema", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task_1/heartbeat": {
        body: { attempt: { attempt_id: "attempt_1" }, resourceClaims: [] },
      },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    await client.heartbeatTaskAttempt("task_1", { attemptId: "attempt_1", fencingToken: 1 });

    expect(calls[0]?.body).toEqual({
      attemptId: "attempt_1",
      fencingToken: 1,
      leaseDurationMs: undefined,
    });
  });

  it("completeTask posts camelCase fields and returns attempt + task", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task_1/complete": {
        body: {
          attempt: { attempt_id: "attempt_1", status: "completed" },
          task: { task_id: "task_1", status: "completed" },
          result: { ok: true },
          replayed: false,
        },
      },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    const result = await client.completeTask("task_1", {
      attemptId: "attempt_1",
      fencingToken: 1,
      result: { ok: true },
    });

    expect(result.task.status).toBe("completed");
    expect(calls[0]?.body).toEqual({ attemptId: "attempt_1", fencingToken: 1, result: { ok: true } });
  });
});

describe("GitameshClient — typed errors", () => {
  it("throws GitameshConflictError with the problem-details body intact on a 409", async () => {
    const problem = {
      type: "https://gitamesh.dev/problems/task-already-claimed",
      title: "Task already claimed",
      status: 409,
      detail: "Task task_1 already has a live attempt and cannot be claimed again.",
      extensions: { task_id: "task_1" },
    };
    const { fetchImpl } = createFakeFetch({
      "POST /v1/tasks/task_1/claim": { status: 409, body: problem },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    const call = client.claimTask("task_1", { agentId: "a", workspaceSessionId: "ws" });
    await expect(call).rejects.toBeInstanceOf(GitameshConflictError);
    try {
      await client.claimTask("task_1", { agentId: "a", workspaceSessionId: "ws" });
      expect.unreachable();
    } catch (error) {
      const err = error as GitameshConflictError;
      expect(err.status).toBe(409);
      expect(err.problem).toEqual(problem);
    }
  });

  it("throws GitameshAuthError on a 401 (missing/invalid token)", async () => {
    const problem = {
      type: "https://gitamesh.dev/problems/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Missing or malformed Authorization: Bearer <token> header.",
    };
    const { fetchImpl } = createFakeFetch({ "GET /v1/tasks": { status: 401, body: problem } });
    const client = new GitameshClient({ baseUrl, token: null, fetchImpl });

    try {
      await client.listTasks();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GitameshAuthError);
      const err = error as GitameshAuthError;
      expect(err.status).toBe(401);
      expect(err.problem?.type).toContain("unauthorized");
    }
  });

  it("throws GitameshAuthError on a 403 (valid token, missing scope)", async () => {
    const problem = {
      type: "https://gitamesh.dev/problems/forbidden",
      title: "Forbidden",
      status: 403,
      detail: 'Token tok_1 lacks required scope "task:read".',
      extensions: { required_scope: "task:read" },
    };
    const { fetchImpl } = createFakeFetch({ "GET /v1/tasks": { status: 403, body: problem } });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    try {
      await client.listTasks();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GitameshAuthError);
      expect((error as GitameshAuthError).status).toBe(403);
    }
  });
});

describe("GitameshClient — idempotency key threading", () => {
  it("sends Idempotency-Key on createTask", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks": { status: 201, body: { task: { task_id: "t1" }, replayed: false } },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    await client.createTask({ repositoryId: "r1", title: "T", idempotencyKey: "key-abc" });

    expect(calls[0]?.headers["Idempotency-Key"]).toBe("key-abc");
  });

  it("sends Idempotency-Key on claimTask", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/t1/claim": {
        body: { attempt: { attempt_id: "a1" }, fencingToken: 1, resourceClaims: [], replayed: false },
      },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    await client.claimTask("t1", { agentId: "a", workspaceSessionId: "ws", idempotencyKey: "claim-key-1" });

    expect(calls[0]?.headers["Idempotency-Key"]).toBe("claim-key-1");
  });

  it("createTask replays the same task on a repeated Idempotency-Key (simulating the daemon's own replay behavior)", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks": {
        body: { task: { task_id: "t-fixed" }, replayed: false },
      },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    const first = await client.createTask({ repositoryId: "r1", title: "T", idempotencyKey: "fixed-key" });
    const second = await client.createTask({ repositoryId: "r1", title: "T", idempotencyKey: "fixed-key" });

    expect(first.task.task_id).toBe(second.task.task_id);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers["Idempotency-Key"]).toBe("fixed-key");
  });
});

describe("GitameshClient — network failure", () => {
  it("throws GitameshNetworkError when fetch itself rejects", async () => {
    const client = new GitameshClient({
      baseUrl,
      token: null,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });

    await expect(client.healthz()).rejects.toMatchObject({ name: "GitameshNetworkError" });
  });

  it("does not send an Authorization header for /healthz", async () => {
    const { fetchImpl, calls } = createFakeFetch({ "GET /healthz": { body: { status: "ok" } } });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    await client.healthz();

    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });
});

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CoordinationEngine, GitameshError } from "@gitamesh/core";
import type { Task } from "@gitamesh/protocol";
import {
  createEmbeddedPostgresStorageForTests,
  PostgresStorageAdapter,
} from "../src/index.js";

/**
 * Runs the exact same behavioral spec as
 * `packages/storage-sqlite/test/adapter.test.ts` against
 * `PostgresStorageAdapter`, backed by an embedded in-process Postgres
 * (`@electric-sql/pglite`) instead of a real server — see this package's
 * README for why pglite was verified and adopted as the default test
 * backend. Every adapter created here is closed in `afterEach`. The
 * embedded Postgres itself is booted once per process and reset for each
 * new adapter (see `embedded` in `src/worker.ts`).
 */

let counter = 0;
function buildTask(overrides: Partial<Task> = {}): Task {
  counter += 1;
  const id = overrides.task_id ?? `task_${counter}`;
  const now = new Date().toISOString();
  return {
    task_id: id,
    workflow_id: overrides.workflow_id ?? `wf_${counter}`,
    repository_id: overrides.repository_id ?? "repo_1",
    parent_task_id: overrides.parent_task_id ?? null,
    title: overrides.title ?? `Task ${id}`,
    description: overrides.description ?? "",
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 0,
    required_capabilities: overrides.required_capabilities ?? [],
    dependencies: overrides.dependencies ?? [],
    join_policy: overrides.join_policy ?? "all",
    base_sha: overrides.base_sha ?? null,
    branch: overrides.branch ?? null,
    idempotency_key: overrides.idempotency_key ?? null,
    deadline_at: overrides.deadline_at ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

const openAdapters: PostgresStorageAdapter[] = [];
function freshStorage(): PostgresStorageAdapter {
  const storage = createEmbeddedPostgresStorageForTests();
  openAdapters.push(storage);
  return storage;
}

// Boot the embedded Postgres here so its cold start (several seconds on a
// loaded CI runner) is not charged to whichever test happens to run first.
beforeAll(() => {
  createEmbeddedPostgresStorageForTests().close();
}, 60_000);

afterEach(() => {
  while (openAdapters.length > 0) {
    openAdapters.pop()!.close();
  }
});

describe("PostgresStorageAdapter: schema + CRUD round-trip", () => {
  it("persists and reloads a task with array/JSON fields intact", () => {
    const storage = freshStorage();
    const task = buildTask({
      required_capabilities: ["typescript", "testing"],
      dependencies: ["task_dep_1"],
    });
    storage.saveTask(task);
    const reloaded = storage.getTask(task.task_id);
    expect(reloaded).toEqual(task);
  });

  it("returns undefined for a task that does not exist", () => {
    const storage = freshStorage();
    expect(storage.getTask("does_not_exist")).toBeUndefined();
  });

  it("listTasks filters by repositoryId and status", () => {
    const storage = freshStorage();
    storage.saveTask(buildTask({ repository_id: "repo_A", status: "pending" }));
    storage.saveTask(buildTask({ repository_id: "repo_A", status: "completed" }));
    storage.saveTask(buildTask({ repository_id: "repo_B", status: "pending" }));

    expect(storage.listTasks({ repositoryId: "repo_A" })).toHaveLength(2);
    expect(
      storage.listTasks({ repositoryId: "repo_A", status: "pending" }),
    ).toHaveLength(1);
    expect(storage.countTasksByStatus()).toEqual({ pending: 2, completed: 1 });
  });
});

describe("invariant #1 (real Postgres adapter): only one concurrent claim wins", () => {
  it("two racing claimTask calls against a real transactional store: exactly one succeeds", async () => {
    const storage = freshStorage();
    const engine = new CoordinationEngine(storage);
    const task = buildTask();
    storage.saveTask(task);

    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        engine.claimTask({
          taskId: task.task_id,
          agentId: "agent-a",
          workspaceSessionId: "ws-a",
          requiredResources: [],
        }),
      ),
      Promise.resolve().then(() =>
        engine.claimTask({
          taskId: task.task_id,
          agentId: "agent-b",
          workspaceSessionId: "ws-b",
          requiredResources: [],
        }),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      GitameshError,
    );
    expect(storage.getActiveAttemptsForTask(task.task_id)).toHaveLength(1);
  });
});

describe("invariant #14 (real Postgres adapter): per-repository event sequences are independent and monotonic", () => {
  it("does not let two repositories' sequences collide or interfere", () => {
    const storage = freshStorage();
    const engine = new CoordinationEngine(storage);

    const taskA1 = buildTask({ repository_id: "repo_A" });
    const taskA2 = buildTask({ repository_id: "repo_A" });
    const taskB1 = buildTask({ repository_id: "repo_B" });
    storage.saveTask(taskA1);
    storage.saveTask(taskA2);
    storage.saveTask(taskB1);

    engine.claimTask({
      taskId: taskA1.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [],
    });
    engine.claimTask({
      taskId: taskB1.task_id,
      agentId: "agent-b",
      workspaceSessionId: "ws-b",
      requiredResources: [],
    });
    engine.claimTask({
      taskId: taskA2.task_id,
      agentId: "agent-c",
      workspaceSessionId: "ws-c",
      requiredResources: [],
    });

    const repoAEvents = storage.listEventsForRepository("repo_A");
    const repoBEvents = storage.listEventsForRepository("repo_B");

    expect(repoAEvents.map((e) => e.repository_sequence)).toEqual([1, 2]);
    expect(repoBEvents.map((e) => e.repository_sequence)).toEqual([1]);

    expect(repoAEvents.every((e) => e.repository_id === "repo_A")).toBe(true);
    expect(repoBEvents.every((e) => e.repository_id === "repo_B")).toBe(true);
  });
});

describe("fencing tokens persist correctly across a full claim -> expire -> reclaim cycle", () => {
  it("second claim after expiry gets a strictly higher token, durable via Postgres", () => {
    const storage = freshStorage();
    const engine = new CoordinationEngine(storage);
    const task = buildTask();
    storage.saveTask(task);

    const first = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [{ resourceType: "path", resourceKey: "f.ts", mode: "write" }],
    });

    const attempt = storage.getAttempt(first.attempt.attempt_id)!;
    storage.saveAttempt({ ...attempt, expires_at: "1999-01-01T00:00:00.000Z" });
    engine.expireStaleLeases("2000-01-01T00:00:00.000Z");

    expect(storage.getActiveResourceClaims(task.repository_id)).toHaveLength(0);

    const second = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-b",
      workspaceSessionId: "ws-b",
      requiredResources: [{ resourceType: "path", resourceKey: "f.ts", mode: "write" }],
    });

    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
  });
});

describe("transaction rollback", () => {
  it("rolls back all writes performed inside a transaction() callback that throws", () => {
    const storage = freshStorage();
    const task = buildTask();
    storage.saveTask(task);

    expect(() =>
      storage.transaction(() => {
        storage.saveTask({ ...task, title: "should not stick" });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(storage.getTask(task.task_id)!.title).toBe(task.title);
  });
});

describe("daemon-facing surface (agents, claims, tokens, events cursor)", () => {
  it("round-trips agents, resource claim manual release, and token lifecycle", () => {
    const storage = freshStorage();

    storage.saveAgent({
      agent_id: "agent_1",
      namespace_id: "default",
      display_name: "Agent One",
      runtime: "custom",
      version: "0.0.1",
      capabilities: ["ts"],
      status: "online",
      last_heartbeat_at: storage.now(),
      metadata: { foo: "bar" },
    });
    expect(storage.getAgent("agent_1")?.capabilities).toEqual(["ts"]);
    expect(storage.listAgents()).toHaveLength(1);

    const task = buildTask();
    storage.saveTask(task);
    storage.saveResourceClaim({
      resource_claim_id: "claim_1",
      repository_id: task.repository_id,
      task_id: task.task_id,
      attempt_id: "attempt_1",
      resource_type: "path",
      resource_key: "f.ts",
      mode: "write",
      lease_id: "lease_1",
      fencing_token: 1,
      expires_at: storage.now(),
    });
    expect(storage.listActiveResourceClaims(task.repository_id)).toHaveLength(1);
    expect(storage.releaseResourceClaim("claim_1")).toBe(true);
    expect(storage.releaseResourceClaim("claim_1")).toBe(false);
    expect(storage.getResourceClaim("claim_1")).toBeDefined();

    storage.saveToken({
      token_id: "token_1",
      token_hash: "hash",
      scopes: ["admin"],
      created_at: storage.now(),
      expires_at: null,
      revoked_at: null,
    });
    expect(storage.getTokenByHash("hash")?.token_id).toBe("token_1");
    expect(storage.listTokens()).toHaveLength(1);
    expect(storage.revokeToken("token_1", storage.now())).toBe(true);
    expect(storage.revokeToken("token_1", storage.now())).toBe(false);
    expect(storage.getTokenByHash("hash")?.revoked_at).not.toBeNull();
  });

  it("listEventsSince advances a monotonic cursor with no gaps or duplicates", () => {
    const storage = freshStorage();
    for (let i = 0; i < 5; i += 1) {
      storage.appendEvent({
        schema_version: 1,
        event_type: "test.event",
        occurred_at: storage.now(),
        namespace_id: "ns",
        repository_id: "repo_1",
        workflow_id: null,
        task_id: null,
        attempt_id: null,
        agent_id: null,
        workspace_session_id: null,
        correlation_id: null,
        causation_id: null,
        idempotency_key: null,
        payload: { i },
        metadata: {},
      });
    }
    expect(storage.latestEventCursor()).toBeGreaterThan(0);
    const first = storage.listEventsSince(0, { limit: 2 });
    expect(first.events).toHaveLength(2);
    const second = storage.listEventsSince(first.nextCursor);
    expect(second.events).toHaveLength(3);
    expect(storage.listAllEvents()).toHaveLength(5);
  });

  it("ping() reports reachability", () => {
    const storage = freshStorage();
    expect(storage.ping()).toBe(true);
  });

  it("idempotency: lookupIdempotentResult round-trips recordIdempotentResult", () => {
    const storage = freshStorage();
    expect(storage.lookupIdempotentResult("k1")).toBeUndefined();
    storage.recordIdempotentResult("k1", { ok: true, n: 3 });
    expect(storage.lookupIdempotentResult("k1")).toEqual({ ok: true, n: 3 });
  });
});

describe("embedded test backend isolation", () => {
  it("a new adapter starts empty even though the embedded Postgres is reused", () => {
    const first = freshStorage();
    first.saveTask(buildTask({ task_id: "left_behind" }));
    expect(first.nextFencingToken("repo_1")).toBe(1);
    expect(first.nextFencingToken("repo_1")).toBe(2);
    first.close();

    const second = freshStorage();
    expect(second.getTask("left_behind")).toBeUndefined();
    expect(second.listTasks()).toEqual([]);
    expect(second.latestEventCursor()).toBe(0);
    // Counters are reset too, not only rows.
    expect(second.nextFencingToken("repo_1")).toBe(1);
  });

  it("close() is safe to call twice", () => {
    const storage = freshStorage();
    storage.close();
    expect(() => storage.close()).not.toThrow();
  });
});

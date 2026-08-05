import { describe, expect, it } from "vitest";
import { CoordinationEngine, GitameshError } from "@gitamesh/core";
import type { Task } from "@gitamesh/protocol";
import { createInMemorySqliteStorage } from "../src/index.js";

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

describe("SqliteStorageAdapter: schema + CRUD round-trip", () => {
  it("persists and reloads a task with array/JSON fields intact", () => {
    const storage = createInMemorySqliteStorage();
    const task = buildTask({
      required_capabilities: ["typescript", "testing"],
      dependencies: ["task_dep_1"],
    });
    storage.saveTask(task);
    const reloaded = storage.getTask(task.task_id);
    expect(reloaded).toEqual(task);
  });
});

describe("invariant #1 (real SQLite adapter): only one concurrent claim wins", () => {
  it("two racing claimTask calls against a real transactional store: exactly one succeeds", async () => {
    const storage = createInMemorySqliteStorage();
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

describe("invariant #14 (real SQLite adapter): per-repository event sequences are independent and monotonic", () => {
  it("does not let two repositories' sequences collide or interfere", () => {
    const storage = createInMemorySqliteStorage();
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

    // Cross-check: no event from repo_B leaked into repo_A's listing and
    // vice versa.
    expect(repoAEvents.every((e) => e.repository_id === "repo_A")).toBe(true);
    expect(repoBEvents.every((e) => e.repository_id === "repo_B")).toBe(true);
  });
});

describe("fencing tokens persist correctly across a full claim -> expire -> reclaim cycle", () => {
  it("second claim after expiry gets a strictly higher token, durable via SQLite", () => {
    const storage = createInMemorySqliteStorage();
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

    expect(storage.getActiveResourceClaims(task.repository_id)).toHaveLength(
      0,
    );

    const second = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-b",
      workspaceSessionId: "ws-b",
      requiredResources: [{ resourceType: "path", resourceKey: "f.ts", mode: "write" }],
    });

    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
  });
});

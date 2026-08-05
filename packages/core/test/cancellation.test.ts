import { describe, expect, it } from "vitest";
import { CoordinationEngine } from "../src/engine.js";
import { MemoryStorageAdapter } from "./support/memory-storage-adapter.js";
import { buildTask } from "./support/fixtures.js";

function setup() {
  const storage = new MemoryStorageAdapter();
  const engine = new CoordinationEngine(storage);
  return { storage, engine };
}

describe("CoordinationEngine.cancelTask: legal-transition guard", () => {
  it("cancels a pending task", () => {
    const { storage, engine } = setup();
    const task = buildTask({ task_id: "t1", status: "pending" });
    storage.saveTask(task);

    const result = engine.cancelTask({ taskId: "t1" });

    expect(result.task.status).toBe("cancelled");
    expect(storage.getTask("t1")?.status).toBe("cancelled");
  });

  it("throws taskNotFound for a nonexistent task", () => {
    const { engine } = setup();
    expect(() => engine.cancelTask({ taskId: "nope" })).toThrow();
  });

  it("rejects cancelling an already-terminal task (completed)", () => {
    const { storage, engine } = setup();
    const task = buildTask({ task_id: "t1", status: "completed" });
    storage.saveTask(task);

    expect(() => engine.cancelTask({ taskId: "t1" })).toThrow();
    expect(storage.getTask("t1")?.status).toBe("completed");
  });

  it("rejects cancelling an already-cancelled task", () => {
    const { storage, engine } = setup();
    const task = buildTask({ task_id: "t1", status: "cancelled" });
    storage.saveTask(task);

    expect(() => engine.cancelTask({ taskId: "t1" })).toThrow();
  });

  it("cancels a running task", () => {
    const { storage, engine } = setup();
    const task = buildTask({ task_id: "t1", status: "running" });
    storage.saveTask(task);

    const result = engine.cancelTask({ taskId: "t1" });
    expect(result.task.status).toBe("cancelled");
  });

  it("appends a task.cancelled event for the root task", () => {
    const { storage, engine } = setup();
    const task = buildTask({ task_id: "t1", status: "pending" });
    storage.saveTask(task);

    engine.cancelTask({ taskId: "t1" });

    const events = storage
      .listAllEvents()
      .filter((e) => e.event_type === "task.cancelled" && e.task_id === "t1");
    expect(events).toHaveLength(1);
  });
});

describe("CoordinationEngine.cancelTask: own attempt/lease cleanup", () => {
  it("cancels the active attempt and releases its lease/resource claims", () => {
    const { storage, engine } = setup();
    const task = buildTask({ task_id: "t1", status: "pending" });
    storage.saveTask(task);

    const claim = engine.claimTask({
      taskId: "t1",
      agentId: "agent-1",
      workspaceSessionId: "ws-1",
      requiredResources: [
        { resourceType: "file", resourceKey: "src/a.ts", mode: "exclusive" },
      ],
    });

    const result = engine.cancelTask({ taskId: "t1" });

    expect(result.task.status).toBe("cancelled");
    const attempt = storage.getAttempt(claim.attempt.attempt_id);
    expect(attempt?.status).toBe("cancelled");

    const lease = storage.getLeaseByAttempt(claim.attempt.attempt_id);
    expect(lease?.status).toBe("released");

    const claims = storage.getResourceClaimsForAttempt(
      claim.attempt.attempt_id,
    );
    expect(claims.every((c) => c.released)).toBe(true);
  });
});

describe("CoordinationEngine.cancelTask: child cascade (parent_task_id)", () => {
  it("cascades to a pending child", () => {
    const { storage, engine } = setup();
    const parent = buildTask({ task_id: "parent", status: "pending" });
    const child = buildTask({
      task_id: "child",
      status: "pending",
      parent_task_id: "parent",
    });
    storage.saveTask(parent);
    storage.saveTask(child);

    const result = engine.cancelTask({ taskId: "parent" });

    expect(storage.getTask("child")?.status).toBe("cancelled");
    expect(result.cancelledChildren.map((t) => t.task_id)).toEqual(["child"]);
  });

  it("cascades to a blocked child", () => {
    const { storage, engine } = setup();
    const parent = buildTask({ task_id: "parent", status: "pending" });
    const child = buildTask({
      task_id: "child",
      status: "blocked",
      parent_task_id: "parent",
    });
    storage.saveTask(parent);
    storage.saveTask(child);

    engine.cancelTask({ taskId: "parent" });

    expect(storage.getTask("child")?.status).toBe("cancelled");
  });

  it("does NOT cascade to a claimed/running child — leaves it alone", () => {
    const { storage, engine } = setup();
    const parent = buildTask({ task_id: "parent", status: "pending" });
    const child = buildTask({
      task_id: "child",
      status: "pending",
      parent_task_id: "parent",
    });
    storage.saveTask(parent);
    storage.saveTask(child);

    // Claim the child before cancelling the parent — it's now "running".
    engine.claimTask({
      taskId: "child",
      agentId: "agent-1",
      workspaceSessionId: "ws-1",
      requiredResources: [],
    });
    expect(storage.getTask("child")?.status).toBe("running");

    const result = engine.cancelTask({ taskId: "parent" });

    expect(storage.getTask("child")?.status).toBe("running");
    expect(result.cancelledChildren).toHaveLength(0);
  });

  it("cascades to nested grandchildren when the child is eligible", () => {
    const { storage, engine } = setup();
    const parent = buildTask({ task_id: "parent", status: "pending" });
    const child = buildTask({
      task_id: "child",
      status: "pending",
      parent_task_id: "parent",
    });
    const grandchild = buildTask({
      task_id: "grandchild",
      status: "pending",
      parent_task_id: "child",
    });
    storage.saveTask(parent);
    storage.saveTask(child);
    storage.saveTask(grandchild);

    const result = engine.cancelTask({ taskId: "parent" });

    expect(storage.getTask("child")?.status).toBe("cancelled");
    expect(storage.getTask("grandchild")?.status).toBe("cancelled");
    expect(result.cancelledChildren.map((t) => t.task_id).sort()).toEqual([
      "child",
      "grandchild",
    ]);
  });

  it("does NOT cascade to a grandchild whose immediate parent (the child) was itself ineligible", () => {
    const { storage, engine } = setup();
    const parent = buildTask({ task_id: "parent", status: "pending" });
    const child = buildTask({
      task_id: "child",
      status: "pending",
      parent_task_id: "parent",
    });
    const grandchild = buildTask({
      task_id: "grandchild",
      status: "pending",
      parent_task_id: "child",
    });
    storage.saveTask(parent);
    storage.saveTask(child);
    storage.saveTask(grandchild);

    // Claim the child so it becomes ineligible for cascade.
    engine.claimTask({
      taskId: "child",
      agentId: "agent-1",
      workspaceSessionId: "ws-1",
      requiredResources: [],
    });

    engine.cancelTask({ taskId: "parent" });

    expect(storage.getTask("child")?.status).toBe("running");
    // The grandchild's parent never actually cancelled, so it must be
    // left untouched too.
    expect(storage.getTask("grandchild")?.status).toBe("pending");
  });

  it("appends a task.cancelled event for every cascaded child", () => {
    const { storage, engine } = setup();
    const parent = buildTask({ task_id: "parent", status: "pending" });
    const child = buildTask({
      task_id: "child",
      status: "pending",
      parent_task_id: "parent",
    });
    storage.saveTask(parent);
    storage.saveTask(child);

    engine.cancelTask({ taskId: "parent" });

    const events = storage
      .listAllEvents()
      .filter((e) => e.event_type === "task.cancelled");
    expect(events.map((e) => e.task_id).sort()).toEqual(["child", "parent"]);
  });
});

describe("CoordinationEngine.cancelTask: dependent cascade via fan-in", () => {
  it("dead-letters an 'all'-policy dependent whose only dependency was cancelled", () => {
    const { storage, engine } = setup();
    const dep = buildTask({ task_id: "dep", status: "pending" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: ["dep"],
      join_policy: "all",
    });
    storage.saveTask(dep);
    storage.saveTask(dependent);

    const result = engine.cancelTask({ taskId: "dep" });

    expect(storage.getTask("dependent")?.status).toBe("dead_letter");
    expect(result.fanInChanged.map((t) => t.task_id)).toEqual(["dependent"]);
  });

  it("does NOT dead-letter an 'any'-policy dependent while another dependency can still complete", () => {
    const { storage, engine } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "pending" });
    const depB = buildTask({ task_id: "dep_b", status: "pending" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: ["dep_a", "dep_b"],
      join_policy: "any",
    });
    storage.saveTask(depA);
    storage.saveTask(depB);
    storage.saveTask(dependent);

    engine.cancelTask({ taskId: "dep_a" });

    expect(storage.getTask("dependent")?.status).toBe("pending");
  });

  it("dead-letters an 'any'-policy dependent once every dependency is permanently unsatisfiable", () => {
    const { storage, engine } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "failed" });
    const depB = buildTask({ task_id: "dep_b", status: "pending" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: ["dep_a", "dep_b"],
      join_policy: "any",
    });
    storage.saveTask(depA);
    storage.saveTask(depB);
    storage.saveTask(dependent);

    engine.cancelTask({ taskId: "dep_b" });

    expect(storage.getTask("dependent")?.status).toBe("dead_letter");
  });

  it("a cascaded (grand)child that is itself a dependency also triggers fan-in dead-lettering", () => {
    const { storage, engine } = setup();
    const parent = buildTask({ task_id: "parent", status: "pending" });
    const child = buildTask({
      task_id: "child",
      status: "pending",
      parent_task_id: "parent",
    });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: ["child"],
      join_policy: "all",
    });
    storage.saveTask(parent);
    storage.saveTask(child);
    storage.saveTask(dependent);

    const result = engine.cancelTask({ taskId: "parent" });

    expect(storage.getTask("child")?.status).toBe("cancelled");
    expect(storage.getTask("dependent")?.status).toBe("dead_letter");
    expect(result.fanInChanged.map((t) => t.task_id)).toEqual(["dependent"]);
  });
});

describe("CoordinationEngine.cancelTask: combined scenario", () => {
  it("cancels the root, cascades an eligible child, dead-letters a dependent, and leaves a running child alone", () => {
    const { storage, engine } = setup();
    const parent = buildTask({ task_id: "parent", status: "pending" });
    const pendingChild = buildTask({
      task_id: "pending_child",
      status: "pending",
      parent_task_id: "parent",
    });
    const runningChild = buildTask({
      task_id: "running_child",
      status: "pending",
      parent_task_id: "parent",
    });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: ["parent"],
      join_policy: "all",
    });
    storage.saveTask(parent);
    storage.saveTask(pendingChild);
    storage.saveTask(runningChild);
    storage.saveTask(dependent);

    engine.claimTask({
      taskId: "running_child",
      agentId: "agent-1",
      workspaceSessionId: "ws-1",
      requiredResources: [],
    });

    const result = engine.cancelTask({ taskId: "parent" });

    expect(result.task.status).toBe("cancelled");
    expect(storage.getTask("pending_child")?.status).toBe("cancelled");
    expect(storage.getTask("running_child")?.status).toBe("running");
    expect(storage.getTask("dependent")?.status).toBe("dead_letter");
  });
});

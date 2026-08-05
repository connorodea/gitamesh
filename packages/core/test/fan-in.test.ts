import { describe, expect, it } from "vitest";
import { CoordinationEngine } from "../src/engine.js";
import { evaluateFanIn } from "../src/fan-in.js";
import { MemoryStorageAdapter } from "./support/memory-storage-adapter.js";
import { buildTask } from "./support/fixtures.js";

function setup() {
  const storage = new MemoryStorageAdapter();
  const engine = new CoordinationEngine(storage);
  return { storage, engine };
}

describe("evaluateFanIn: 'all' join policy", () => {
  it("does NOT unblock a depending task while any dependency is still incomplete", () => {
    const { storage } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "completed" });
    const depB = buildTask({ task_id: "dep_b", status: "pending" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: [depA.task_id, depB.task_id],
      join_policy: "all",
    });
    storage.saveTask(depA);
    storage.saveTask(depB);
    storage.saveTask(dependent);

    const changed = evaluateFanIn(storage, depA.task_id, "2000-01-01T00:00:00.000Z");

    expect(changed).toHaveLength(0);
    expect(storage.getTask(dependent.task_id)?.status).toBe("pending");
  });

  it("unblocks (-> queued) once every dependency is completed", () => {
    const { storage } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "completed" });
    const depB = buildTask({ task_id: "dep_b", status: "completed" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: [depA.task_id, depB.task_id],
      join_policy: "all",
    });
    storage.saveTask(depA);
    storage.saveTask(depB);
    storage.saveTask(dependent);

    const changed = evaluateFanIn(storage, depB.task_id, "2000-01-01T00:00:00.000Z");

    expect(changed).toHaveLength(1);
    expect(changed[0]?.task_id).toBe(dependent.task_id);
    expect(storage.getTask(dependent.task_id)?.status).toBe("queued");
  });

  it("unblocks a 'blocked' depending task (-> queued) too, not just 'pending'", () => {
    const { storage } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "completed" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "blocked",
      dependencies: [depA.task_id],
      join_policy: "all",
    });
    storage.saveTask(depA);
    storage.saveTask(dependent);

    evaluateFanIn(storage, depA.task_id, "2000-01-01T00:00:00.000Z");

    expect(storage.getTask(dependent.task_id)?.status).toBe("queued");
  });

  it("escalates to dead_letter when a dependency is permanently unsatisfiable (cancelled)", () => {
    const { storage } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "cancelled" });
    const depB = buildTask({ task_id: "dep_b", status: "pending" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: [depA.task_id, depB.task_id],
      join_policy: "all",
    });
    storage.saveTask(depA);
    storage.saveTask(depB);
    storage.saveTask(dependent);

    const changed = evaluateFanIn(storage, depA.task_id, "2000-01-01T00:00:00.000Z");

    expect(changed).toHaveLength(1);
    expect(storage.getTask(dependent.task_id)?.status).toBe("dead_letter");
  });

  it("escalates to dead_letter when a dependency is dead_letter itself", () => {
    const { storage } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "dead_letter" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: [depA.task_id],
      join_policy: "all",
    });
    storage.saveTask(depA);
    storage.saveTask(dependent);

    evaluateFanIn(storage, depA.task_id, "2000-01-01T00:00:00.000Z");

    expect(storage.getTask(dependent.task_id)?.status).toBe("dead_letter");
  });
});

describe("evaluateFanIn: 'any' join policy", () => {
  it("unblocks (-> queued) as soon as ONE dependency completes", () => {
    const { storage } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "completed" });
    const depB = buildTask({ task_id: "dep_b", status: "pending" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: [depA.task_id, depB.task_id],
      join_policy: "any",
    });
    storage.saveTask(depA);
    storage.saveTask(depB);
    storage.saveTask(dependent);

    const changed = evaluateFanIn(storage, depA.task_id, "2000-01-01T00:00:00.000Z");

    expect(changed).toHaveLength(1);
    expect(storage.getTask(dependent.task_id)?.status).toBe("queued");
  });

  it("does NOT unblock while some dependencies are still incomplete and none have completed", () => {
    const { storage } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "failed" });
    const depB = buildTask({ task_id: "dep_b", status: "pending" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: [depA.task_id, depB.task_id],
      join_policy: "any",
    });
    storage.saveTask(depA);
    storage.saveTask(depB);
    storage.saveTask(dependent);

    // depA failed, but depB is still pending and could yet complete —
    // "any" is not dead yet.
    const changed = evaluateFanIn(storage, depA.task_id, "2000-01-01T00:00:00.000Z");

    expect(changed).toHaveLength(0);
    expect(storage.getTask(dependent.task_id)?.status).toBe("pending");
  });

  it("escalates to dead_letter only once EVERY dependency is permanently unsatisfiable", () => {
    const { storage } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "failed" });
    const depB = buildTask({ task_id: "dep_b", status: "cancelled" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: [depA.task_id, depB.task_id],
      join_policy: "any",
    });
    storage.saveTask(depA);
    storage.saveTask(depB);
    storage.saveTask(dependent);

    const changed = evaluateFanIn(storage, depB.task_id, "2000-01-01T00:00:00.000Z");

    expect(changed).toHaveLength(1);
    expect(storage.getTask(dependent.task_id)?.status).toBe("dead_letter");
  });
});

describe("evaluateFanIn: 'quorum' join policy (documented no-op)", () => {
  it("never mutates a quorum-policy depending task, even when every dependency completes", () => {
    const { storage } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "completed" });
    const depB = buildTask({ task_id: "dep_b", status: "completed" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: [depA.task_id, depB.task_id],
      join_policy: "quorum",
    });
    storage.saveTask(depA);
    storage.saveTask(depB);
    storage.saveTask(dependent);

    const changed = evaluateFanIn(storage, depB.task_id, "2000-01-01T00:00:00.000Z");

    expect(changed).toHaveLength(0);
    expect(storage.getTask(dependent.task_id)?.status).toBe("pending");
  });
});

describe("evaluateFanIn: scope guards", () => {
  it("leaves an already-claimed/running depending task alone", () => {
    const { storage } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "completed" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "running",
      dependencies: [depA.task_id],
      join_policy: "any",
    });
    storage.saveTask(depA);
    storage.saveTask(dependent);

    const changed = evaluateFanIn(storage, depA.task_id, "2000-01-01T00:00:00.000Z");

    expect(changed).toHaveLength(0);
    expect(storage.getTask(dependent.task_id)?.status).toBe("running");
  });

  it("ignores tasks that don't depend on the trigger task at all", () => {
    const { storage } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "completed" });
    const unrelated = buildTask({
      task_id: "unrelated",
      status: "pending",
      dependencies: [],
      join_policy: "any",
    });
    storage.saveTask(depA);
    storage.saveTask(unrelated);

    const changed = evaluateFanIn(storage, depA.task_id, "2000-01-01T00:00:00.000Z");

    expect(changed).toHaveLength(0);
    expect(storage.getTask(unrelated.task_id)?.status).toBe("pending");
  });

  it("evaluates every dependent task that lists the trigger, not just the first", () => {
    const { storage } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "completed" });
    const dependent1 = buildTask({
      task_id: "dependent_1",
      status: "pending",
      dependencies: [depA.task_id],
      join_policy: "any",
    });
    const dependent2 = buildTask({
      task_id: "dependent_2",
      status: "blocked",
      dependencies: [depA.task_id],
      join_policy: "all",
    });
    storage.saveTask(depA);
    storage.saveTask(dependent1);
    storage.saveTask(dependent2);

    const changed = evaluateFanIn(storage, depA.task_id, "2000-01-01T00:00:00.000Z");

    expect(changed.map((t) => t.task_id).sort()).toEqual([
      "dependent_1",
      "dependent_2",
    ]);
    expect(storage.getTask(dependent1.task_id)?.status).toBe("queued");
    expect(storage.getTask(dependent2.task_id)?.status).toBe("queued");
  });
});

describe("evaluateFanIn wired into CoordinationEngine", () => {
  it("completeAttempt() drives a real 'any' unblock end to end", () => {
    const { storage, engine } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "pending" });
    const depB = buildTask({ task_id: "dep_b", status: "pending" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: [depA.task_id, depB.task_id],
      join_policy: "any",
    });
    storage.saveTask(depA);
    storage.saveTask(depB);
    storage.saveTask(dependent);

    const claim = engine.claimTask({
      taskId: depA.task_id,
      agentId: "agent-1",
      workspaceSessionId: "ws-1",
      requiredResources: [],
    });
    engine.completeAttempt({
      attemptId: claim.attempt.attempt_id,
      fencingToken: claim.fencingToken,
    });

    expect(storage.getTask(dependent.task_id)?.status).toBe("queued");
    // The now-queued dependent must be legitimately claimable through the
    // normal path — this is a real state transition, not a derived
    // read-time value.
    const dependentClaim = engine.claimTask({
      taskId: dependent.task_id,
      agentId: "agent-2",
      workspaceSessionId: "ws-2",
      requiredResources: [],
    });
    expect(dependentClaim.attempt.status).toBe("running");
  });

  it("failAttempt() escalating a dependency to 'failed' (retries exhausted) dead-letters an 'all' dependent", () => {
    const { storage, engine } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "pending" });
    const depB = buildTask({ task_id: "dep_b", status: "pending" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: [depA.task_id, depB.task_id],
      join_policy: "all",
    });
    storage.saveTask(depA);
    storage.saveTask(depB);
    storage.saveTask(dependent);

    const claim = engine.claimTask({
      taskId: depA.task_id,
      agentId: "agent-1",
      workspaceSessionId: "ws-1",
      requiredResources: [],
    });
    // maxAttempts: 1 -> this single failure immediately escalates the
    // TASK (not just the attempt) to "failed", exhausting retries.
    engine.failAttempt({
      attemptId: claim.attempt.attempt_id,
      fencingToken: claim.fencingToken,
      error: "boom",
      maxAttempts: 1,
    });

    expect(storage.getTask(depA.task_id)?.status).toBe("failed");
    expect(storage.getTask(dependent.task_id)?.status).toBe("dead_letter");
  });

  it("failAttempt() that merely requeues (retries remain) does NOT dead-letter dependents", () => {
    const { storage, engine } = setup();
    const depA = buildTask({ task_id: "dep_a", status: "pending" });
    const dependent = buildTask({
      task_id: "dependent",
      status: "pending",
      dependencies: [depA.task_id],
      join_policy: "all",
    });
    storage.saveTask(depA);
    storage.saveTask(dependent);

    const claim = engine.claimTask({
      taskId: depA.task_id,
      agentId: "agent-1",
      workspaceSessionId: "ws-1",
      requiredResources: [],
    });
    // Default maxAttempts (3): attempt_number 1 < 3, so the task is
    // merely requeued to "queued", not escalated to "failed" — fan-in
    // must not treat this as permanent.
    engine.failAttempt({
      attemptId: claim.attempt.attempt_id,
      fencingToken: claim.fencingToken,
      error: "transient",
    });

    expect(storage.getTask(depA.task_id)?.status).toBe("queued");
    expect(storage.getTask(dependent.task_id)?.status).toBe("pending");
  });
});

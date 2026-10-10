import { describe, expect, it } from "vitest";
import { GitameshError } from "@gitamesh/protocol";
import { CoordinationEngine } from "../src/engine.js";
import { assertValidDependencies, dependencyState } from "../src/dependencies.js";
import { MemoryStorageAdapter } from "./support/memory-storage-adapter.js";
import { buildTask } from "./support/fixtures.js";

function setup() {
  const storage = new MemoryStorageAdapter();
  const engine = new CoordinationEngine(storage);
  return { storage, engine };
}

function claim(engine: CoordinationEngine, taskId: string) {
  return engine.claimTask({
    taskId,
    agentId: "agent-a",
    workspaceSessionId: "ws-a",
    requiredResources: [],
  });
}

describe("dependencyState", () => {
  it("is ready with no dependencies", () => {
    const { storage } = setup();
    expect(dependencyState(storage, buildTask())).toEqual({ ready: true, waitingOn: [] });
  });

  it("'all' waits on every incomplete dependency, including a missing one", () => {
    const { storage } = setup();
    storage.saveTask(buildTask({ task_id: "done", status: "completed" }));
    storage.saveTask(buildTask({ task_id: "busy", status: "running" }));
    const task = buildTask({ dependencies: ["done", "busy", "ghost"] });

    expect(dependencyState(storage, task)).toEqual({
      ready: false,
      waitingOn: [
        { task_id: "busy", status: "running" },
        { task_id: "ghost", status: "missing" },
      ],
    });
  });

  it("'any' is ready once one dependency completed", () => {
    const { storage } = setup();
    storage.saveTask(buildTask({ task_id: "done", status: "completed" }));
    storage.saveTask(buildTask({ task_id: "busy", status: "running" }));
    const task = buildTask({ dependencies: ["done", "busy"], join_policy: "any" });

    expect(dependencyState(storage, task).ready).toBe(true);
  });

  it("'quorum' is as strict as 'all'", () => {
    const { storage } = setup();
    storage.saveTask(buildTask({ task_id: "done", status: "completed" }));
    storage.saveTask(buildTask({ task_id: "busy", status: "running" }));
    const task = buildTask({ dependencies: ["done", "busy"], join_policy: "quorum" });

    expect(dependencyState(storage, task).ready).toBe(false);
  });
});

describe("claimTask refuses a task whose dependencies are not complete", () => {
  it("throws task-dependencies-incomplete naming what it waits on, and writes nothing", () => {
    const { storage, engine } = setup();
    storage.saveTask(buildTask({ task_id: "dep", status: "pending" }));
    storage.saveTask(buildTask({ task_id: "blocked", dependencies: ["dep"] }));

    let thrown: unknown;
    try {
      claim(engine, "blocked");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GitameshError);
    const problem = thrown as GitameshError;
    expect(problem.type).toContain("task-dependencies-incomplete");
    expect(problem.status).toBe(409);
    expect(problem.detail).toBe("Task blocked cannot be claimed yet: it waits on dep (pending).");
    expect(storage.getTask("blocked")?.status).toBe("pending");
    expect(storage.getActiveAttemptsForTask("blocked")).toHaveLength(0);
  });

  it("allows the claim once the dependency has completed", () => {
    const { storage, engine } = setup();
    storage.saveTask(buildTask({ task_id: "dep", status: "completed" }));
    storage.saveTask(buildTask({ task_id: "next", dependencies: ["dep"] }));

    expect(claim(engine, "next").attempt.status).toBe("running");
  });
});

describe("assertValidDependencies", () => {
  it("rejects a missing dependency, a self-dependency and another repository's task", () => {
    const { storage } = setup();
    storage.saveTask(buildTask({ task_id: "other", repository_id: "repo_2" }));
    const check = (dependencies: string[]) => () =>
      assertValidDependencies(storage, { taskId: "t", repositoryId: "repo_1", dependencies });

    expect(check(["ghost"])).toThrow(/does not exist/);
    expect(check(["t"])).toThrow(/cannot depend on itself/);
    expect(check(["other"])).toThrow(/belongs to repository repo_2/);
  });

  it("rejects a direct and an indirect cycle", () => {
    const { storage } = setup();
    storage.saveTask(buildTask({ task_id: "a" }));
    storage.saveTask(buildTask({ task_id: "b", dependencies: ["a"] }));
    storage.saveTask(buildTask({ task_id: "c", dependencies: ["b"] }));

    // a -> b would close a <- b; a -> c would close a <- b <- c.
    for (const dep of ["b", "c"]) {
      expect(() =>
        assertValidDependencies(storage, { taskId: "a", repositoryId: "repo_1", dependencies: [dep] }),
      ).toThrow(/cycle/);
    }
  });

  it("accepts a valid chain", () => {
    const { storage } = setup();
    storage.saveTask(buildTask({ task_id: "a" }));
    storage.saveTask(buildTask({ task_id: "b", dependencies: ["a"] }));

    expect(() =>
      assertValidDependencies(storage, { taskId: "c", repositoryId: "repo_1", dependencies: ["a", "b"] }),
    ).not.toThrow();
  });
});

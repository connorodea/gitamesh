import { describe, expect, it } from "vitest";
import { createTestEngine, buildTask, buildRepository } from "../src/index.js";

describe("testkit", () => {
  it("createTestEngine produces a working in-memory engine", () => {
    const { engine, storage } = createTestEngine();
    const repo = buildRepository();
    const task = buildTask({ repository_id: repo.repository_id });
    storage.saveTask(task);

    const claim = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [],
    });

    expect(claim.attempt.status).toBe("running");
    expect(storage.getTask(task.task_id)?.status).toBe("running");
  });
});

import { describe, expect, it } from "vitest";
import { CoordinationEngine } from "../src/engine.js";
import {
  collectSubtaskResults,
  dispatchSubtasks,
  unsettledSubtaskIds,
  waitOutcome,
} from "../src/orchestration.js";
import { MemoryStorageAdapter } from "./support/memory-storage-adapter.js";
import { buildTask } from "./support/fixtures.js";

function setup() {
  const storage = new MemoryStorageAdapter();
  const engine = new CoordinationEngine(storage);
  const parent = buildTask({ task_id: "parent", workflow_id: "wf_parent", status: "running" });
  storage.saveTask(parent);
  return { storage, engine, parent };
}

function dispatch(storage: MemoryStorageAdapter, titles: string[], extra: Partial<Parameters<typeof dispatchSubtasks>[1]> = {}) {
  return storage.transaction(() =>
    dispatchSubtasks(storage, {
      parentTaskId: "parent",
      subtasks: titles.map((title) => ({ title })),
      ...extra,
    }),
  );
}

function runToCompletion(engine: CoordinationEngine, taskId: string, result: Record<string, unknown>) {
  const claim = engine.claimTask({ taskId, agentId: "agent_1", workspaceSessionId: "ws_1", requiredResources: [] });
  engine.completeAttempt({ attemptId: claim.attempt.attempt_id, fencingToken: claim.fencingToken, result });
}

function runToFailure(engine: CoordinationEngine, taskId: string, error: string) {
  const claim = engine.claimTask({ taskId, agentId: "agent_1", workspaceSessionId: "ws_1", requiredResources: [] });
  engine.failAttempt({ attemptId: claim.attempt.attempt_id, fencingToken: claim.fencingToken, error, maxAttempts: 1 });
}

describe("dispatchSubtasks", () => {
  it("creates one child per entry under the parent, in the parent's repository and workflow", () => {
    const { storage } = setup();
    const { subtasks } = dispatch(storage, ["a", "b", "c"]);

    expect(subtasks).toHaveLength(3);
    for (const child of subtasks) {
      expect(child).toMatchObject({
        parent_task_id: "parent",
        repository_id: "repo_1",
        workflow_id: "wf_parent",
        status: "pending",
      });
    }
    expect(subtasks.map((t) => t.title)).toEqual(["a", "b", "c"]);
    expect(storage.getTask(subtasks[0]!.task_id)).toBeDefined();
  });

  it("applies a shared deadline and appends one dispatch event on the parent", () => {
    const { storage } = setup();
    const deadline = "2099-01-01T00:00:00.000Z";
    const { subtasks } = dispatch(storage, ["a", "b"], { deadlineAt: deadline });

    expect(subtasks.every((t) => t.deadline_at === deadline)).toBe(true);
    const events = storage.listEventsForRepository("repo_1");
    const dispatched = events.filter((e) => e.event_type === "task.subtasks_dispatched");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ task_id: "parent" });
    expect(dispatched[0]!.payload).toMatchObject({ subtask_ids: subtasks.map((t) => t.task_id) });
    expect(events.filter((e) => e.event_type === "task.created")).toHaveLength(2);
  });

  it("refuses a missing parent", () => {
    const { storage } = setup();
    expect(() =>
      storage.transaction(() => dispatchSubtasks(storage, { parentTaskId: "nope", subtasks: [{ title: "a" }] })),
    ).toThrow(/nope/);
  });

  it("refuses a parent that is already finished", () => {
    const { storage } = setup();
    storage.saveTask(buildTask({ task_id: "done", status: "completed" }));
    expect(() =>
      storage.transaction(() => dispatchSubtasks(storage, { parentTaskId: "done", subtasks: [{ title: "a" }] })),
    ).toThrow(/completed/);
  });

  it("refuses an empty subtask list", () => {
    const { storage } = setup();
    expect(() => dispatch(storage, [])).toThrow(/at least one/);
  });
});

describe("collectSubtaskResults", () => {
  it("reports an empty fan-in for a parent with no children", () => {
    const { storage } = setup();
    const summary = collectSubtaskResults(storage, "parent");
    expect(summary).toMatchObject({ total: 0, settled: 0, all_settled: true, outcome: "empty" });
  });

  it("collects each completed child's result and counts what is still running", () => {
    const { storage, engine } = setup();
    const { subtasks } = dispatch(storage, ["a", "b"]);
    runToCompletion(engine, subtasks[0]!.task_id, { answer: 42 });

    const summary = collectSubtaskResults(storage, "parent");
    expect(summary).toMatchObject({ total: 2, settled: 1, succeeded: 1, all_settled: false, outcome: "running" });
    const a = summary.subtasks.find((s) => s.task_id === subtasks[0]!.task_id)!;
    const b = summary.subtasks.find((s) => s.task_id === subtasks[1]!.task_id)!;
    expect(a).toMatchObject({ status: "completed", settled: true, result: { answer: 42 }, error: null });
    expect(b).toMatchObject({ status: "pending", settled: false, result: null });
  });

  it("calls a mix of successes and permanent failures a partial outcome and keeps the error", () => {
    const { storage, engine } = setup();
    const { subtasks } = dispatch(storage, ["a", "b"]);
    runToCompletion(engine, subtasks[0]!.task_id, { ok: true });
    runToFailure(engine, subtasks[1]!.task_id, "boom");

    const summary = collectSubtaskResults(storage, "parent");
    expect(summary).toMatchObject({ all_settled: true, succeeded: 1, failed: 1, outcome: "partial" });
    expect(summary.subtasks.find((s) => s.task_id === subtasks[1]!.task_id)).toMatchObject({
      status: "failed",
      settled: true,
      error: "boom",
    });
  });

  it("does not count a failed attempt that was requeued for retry as settled", () => {
    const { storage, engine } = setup();
    const { subtasks } = dispatch(storage, ["a"]);
    const claim = engine.claimTask({ taskId: subtasks[0]!.task_id, agentId: "agent_1", workspaceSessionId: "ws_1", requiredResources: [] });
    engine.failAttempt({ attemptId: claim.attempt.attempt_id, fencingToken: claim.fencingToken, error: "flaky" });

    const summary = collectSubtaskResults(storage, "parent");
    expect(summary).toMatchObject({ settled: 0, all_settled: false, outcome: "running" });
    expect(summary.subtasks[0]).toMatchObject({ status: "queued", error: "flaky" });
  });

  it("reports succeeded, failed and cancelled outcomes when every child ends the same way", () => {
    const ok = setup();
    const okChildren = dispatch(ok.storage, ["a"]).subtasks;
    runToCompletion(ok.engine, okChildren[0]!.task_id, {});
    expect(collectSubtaskResults(ok.storage, "parent").outcome).toBe("succeeded");

    const bad = setup();
    const badChildren = dispatch(bad.storage, ["a"]).subtasks;
    runToFailure(bad.engine, badChildren[0]!.task_id, "x");
    expect(collectSubtaskResults(bad.storage, "parent").outcome).toBe("failed");

    const gone = setup();
    const goneChildren = dispatch(gone.storage, ["a"]).subtasks;
    gone.engine.cancelTask({ taskId: goneChildren[0]!.task_id });
    expect(collectSubtaskResults(gone.storage, "parent").outcome).toBe("cancelled");
  });

  it("flags unsettled children past their deadline as overdue", () => {
    const { storage } = setup();
    dispatch(storage, ["a"], { deadlineAt: "2000-01-01T00:00:00.000Z" });
    const summary = collectSubtaskResults(storage, "parent");
    expect(summary.overdue).toBe(1);
    expect(summary.subtasks[0]!.overdue).toBe(true);
  });
});

describe("waitOutcome", () => {
  it("wakes on all_settled only when every child is settled (until=all)", () => {
    const { storage, engine } = setup();
    const { subtasks } = dispatch(storage, ["a", "b"]);
    runToCompletion(engine, subtasks[0]!.task_id, {});
    expect(waitOutcome(collectSubtaskResults(storage, "parent"), { until: "all" })).toBeNull();
    runToCompletion(engine, subtasks[1]!.task_id, {});
    expect(waitOutcome(collectSubtaskResults(storage, "parent"), { until: "all" })).toBe("all_settled");
  });

  it("wakes on the first success with until=any", () => {
    const { storage, engine } = setup();
    const { subtasks } = dispatch(storage, ["a", "b"]);
    expect(waitOutcome(collectSubtaskResults(storage, "parent"), { until: "any" })).toBeNull();
    runToCompletion(engine, subtasks[1]!.task_id, {});
    expect(waitOutcome(collectSubtaskResults(storage, "parent"), { until: "any" })).toBe("any_succeeded");
  });

  it("wakes on the first permanent failure only with failFast", () => {
    const { storage, engine } = setup();
    const { subtasks } = dispatch(storage, ["a", "b"]);
    runToFailure(engine, subtasks[0]!.task_id, "boom");
    const summary = collectSubtaskResults(storage, "parent");
    expect(waitOutcome(summary, { until: "all" })).toBeNull();
    expect(waitOutcome(summary, { until: "all", failFast: true })).toBe("failure");
  });

  it("returns no_subtasks for a parent with nothing dispatched", () => {
    const { storage } = setup();
    expect(waitOutcome(collectSubtaskResults(storage, "parent"), { until: "all" })).toBe("no_subtasks");
  });
});

describe("unsettledSubtaskIds", () => {
  it("lists only children that can still change, including running ones", () => {
    const { storage, engine } = setup();
    const { subtasks } = dispatch(storage, ["a", "b", "c"]);
    runToCompletion(engine, subtasks[0]!.task_id, {});
    engine.claimTask({ taskId: subtasks[1]!.task_id, agentId: "agent_1", workspaceSessionId: "ws_1", requiredResources: [] });

    expect(unsettledSubtaskIds(storage, "parent").sort()).toEqual(
      [subtasks[1]!.task_id, subtasks[2]!.task_id].sort(),
    );
  });
});

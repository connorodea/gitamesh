import { describe, expect, it } from "vitest";
import { CoordinationEngine } from "../src/engine.js";
import { GitameshError } from "@gitamesh/protocol";
import { MemoryStorageAdapter } from "./support/memory-storage-adapter.js";
import { buildTask } from "./support/fixtures.js";

function setup() {
  const storage = new MemoryStorageAdapter();
  const engine = new CoordinationEngine(storage);
  return { storage, engine };
}

describe("invariant #1: a task may have only one active attempt", () => {
  it("exactly one of two concurrent claim attempts on the same task succeeds", async () => {
    const { engine, storage } = setup();
    const task = buildTask();
    storage.saveTask(task);

    const attempt1 = () =>
      engine.claimTask({
        taskId: task.task_id,
        agentId: "agent-a",
        workspaceSessionId: "ws-a",
        requiredResources: [],
      });
    const attempt2 = () =>
      engine.claimTask({
        taskId: task.task_id,
        agentId: "agent-b",
        workspaceSessionId: "ws-b",
        requiredResources: [],
      });

    const results = await Promise.allSettled([
      Promise.resolve().then(attempt1),
      Promise.resolve().then(attempt2),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = (rejected[0] as PromiseRejectedResult)
      .reason as GitameshError;
    expect(rejection).toBeInstanceOf(GitameshError);
    // Depending on scheduling, the loser sees either "task already has a
    // live attempt" (if it raced before the task left pending/queued) or
    // "task not claimable" (if the winner had already advanced the task's
    // status by the time the loser's synchronous claim ran). Both are
    // correct rejections of the same underlying invariant: the loser must
    // never win a second attempt.
    expect(rejection.status).toBe(409);
    expect(["task-already-claimed", "task-not-claimable"].some((t) =>
      rejection.type.includes(t),
    )).toBe(true);

    // Confirm storage agrees: exactly one live attempt for the task.
    expect(storage.getActiveAttemptsForTask(task.task_id)).toHaveLength(1);
  });
});

describe("invariant #2: task assignment and resource acquisition are atomic", () => {
  it("acquires NEITHER resource when only one of two is available", () => {
    const { engine, storage } = setup();
    const repoId = "repo_atomic";
    const taskA = buildTask({ repository_id: repoId, task_id: "task_a" });
    const taskB = buildTask({ repository_id: repoId, task_id: "task_b" });
    storage.saveTask(taskA);
    storage.saveTask(taskB);

    // First, claim taskA holding "src/fileA.ts" write.
    engine.claimTask({
      taskId: taskA.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [
        { resourceType: "path", resourceKey: "src/fileA.ts", mode: "write" },
      ],
    });

    // Now taskB requests BOTH "src/fileB.ts" (available) AND
    // "src/fileA.ts" (unavailable, held by taskA). The whole claim must
    // fail and fileB must remain unclaimed too.
    expect(() =>
      engine.claimTask({
        taskId: taskB.task_id,
        agentId: "agent-b",
        workspaceSessionId: "ws-b",
        requiredResources: [
          { resourceType: "path", resourceKey: "src/fileB.ts", mode: "write" },
          { resourceType: "path", resourceKey: "src/fileA.ts", mode: "write" },
        ],
      }),
    ).toThrow(GitameshError);

    const activeClaims = storage.getActiveResourceClaims(repoId);
    const keys = activeClaims.map((c) => c.resource_key).sort();
    expect(keys).toEqual(["src/fileA.ts"]); // only taskA's original claim
    expect(activeClaims.some((c) => c.resource_key === "src/fileB.ts")).toBe(
      false,
    );
    expect(storage.getTask(taskB.task_id)?.status).toBe("pending");
  });
});

describe("invariant #7: fencing tokens increase monotonically across attempts on the same task", () => {
  it("second attempt (after expiry + requeue) gets a higher token than the first", () => {
    const { engine, storage } = setup();
    const task = buildTask();
    storage.saveTask(task);

    const first = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [],
    });

    // Force expiry by rewinding the attempt's expires_at into the past.
    const staleAttempt = storage.getAttempt(first.attempt.attempt_id)!;
    storage.saveAttempt({ ...staleAttempt, expires_at: "1999-01-01T00:00:00.000Z" });

    engine.expireStaleLeases("2000-01-01T00:00:00.000Z");

    const second = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-b",
      workspaceSessionId: "ws-b",
      requiredResources: [],
    });

    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
  });
});

describe("invariant #8: a stale fencing token is rejected by heartbeat/complete/fail", () => {
  it("rejects all three operations once the attempt has been superseded", () => {
    const { engine, storage } = setup();
    const task = buildTask();
    storage.saveTask(task);

    const claimA = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [],
    });
    const staleToken = claimA.fencingToken;
    const attemptId = claimA.attempt.attempt_id;

    // Expire A's lease and let a new attempt supersede it.
    const attempt = storage.getAttempt(attemptId)!;
    storage.saveAttempt({ ...attempt, expires_at: "1999-01-01T00:00:00.000Z" });
    engine.expireStaleLeases("2000-01-01T00:00:00.000Z");

    engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-b",
      workspaceSessionId: "ws-b",
      requiredResources: [],
    });

    expect(() =>
      engine.heartbeatAttempt({ attemptId, fencingToken: staleToken }),
    ).toThrow(GitameshError);
    expect(() =>
      engine.completeAttempt({ attemptId, fencingToken: staleToken }),
    ).toThrow(GitameshError);
    expect(() =>
      engine.failAttempt({
        attemptId,
        fencingToken: staleToken,
        error: "boom",
      }),
    ).toThrow(GitameshError);
  });
});

describe("invariant #9: heartbeat renewal is atomic across an attempt's resource claims", () => {
  it("every claim's new expires_at matches the attempt's new expires_at", () => {
    const { engine, storage } = setup();
    const task = buildTask();
    storage.saveTask(task);

    const claim = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [
        { resourceType: "path", resourceKey: "a.ts", mode: "write" },
        { resourceType: "path", resourceKey: "b.ts", mode: "write" },
        { resourceType: "path", resourceKey: "c.ts", mode: "write" },
      ],
    });

    const { attempt } = engine.heartbeatAttempt({
      attemptId: claim.attempt.attempt_id,
      fencingToken: claim.fencingToken,
    });

    const claims = storage.getResourceClaimsForAttempt(attempt.attempt_id);
    expect(claims).toHaveLength(3);
    for (const c of claims) {
      expect(c.expires_at).toBe(attempt.expires_at);
    }
  });
});

describe("invariant #10: idempotent completion", () => {
  it("calling completeAttempt twice does not double-transition or duplicate events, and returns consistent output", () => {
    const { engine, storage } = setup();
    const task = buildTask();
    storage.saveTask(task);

    const claim = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [],
    });

    const first = engine.completeAttempt({
      attemptId: claim.attempt.attempt_id,
      fencingToken: claim.fencingToken,
      result: { ok: true },
    });
    const eventsAfterFirst = storage.listAllEvents().length;

    const second = engine.completeAttempt({
      attemptId: claim.attempt.attempt_id,
      fencingToken: claim.fencingToken,
      result: { ok: true },
    });
    const eventsAfterSecond = storage.listAllEvents().length;

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.task.status).toBe("completed");
    expect(second.attempt.status).toBe("completed");
    expect(eventsAfterSecond).toBe(eventsAfterFirst);
  });
});

describe("invariant #11: lease expiration requeues the task and the next claim gets a fresh, higher token", () => {
  it("crash-recovery path", () => {
    const { engine, storage } = setup();
    const task = buildTask();
    storage.saveTask(task);

    const first = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [],
    });

    const attempt = storage.getAttempt(first.attempt.attempt_id)!;
    storage.saveAttempt({ ...attempt, expires_at: "1999-01-01T00:00:00.000Z" });

    const expireResult = engine.expireStaleLeases("2000-01-01T00:00:00.000Z");
    expect(expireResult.expiredAttemptIds).toContain(first.attempt.attempt_id);
    expect(expireResult.requeuedTaskIds).toContain(task.task_id);
    expect(storage.getTask(task.task_id)?.status).toBe("queued");

    const second = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-b",
      workspaceSessionId: "ws-b",
      requiredResources: [],
    });
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
  });
});

describe("invariant #12: invalid state transitions are rejected and do not mutate state", () => {
  it("a completed attempt cannot transition back to running", () => {
    const { engine, storage } = setup();
    const task = buildTask();
    storage.saveTask(task);

    const claim = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [],
    });
    engine.completeAttempt({
      attemptId: claim.attempt.attempt_id,
      fencingToken: claim.fencingToken,
    });

    const beforeAttempt = storage.getAttempt(claim.attempt.attempt_id)!;
    const beforeTask = storage.getTask(task.task_id)!;

    // Attempting to fail an already-completed attempt with a stale check
    // path: since the attempt is terminal, fencing-token match won't even
    // get to a state-transition check for heartbeat (covered by
    // invariant #8's terminal-state guard); here we exercise the
    // transition validator directly to prove it neither throws a
    // different error type nor mutates.
    expect(() =>
      engine.heartbeatAttempt({
        attemptId: claim.attempt.attempt_id,
        fencingToken: claim.fencingToken,
      }),
    ).toThrow(GitameshError);

    const afterAttempt = storage.getAttempt(claim.attempt.attempt_id)!;
    const afterTask = storage.getTask(task.task_id)!;
    expect(afterAttempt).toEqual(beforeAttempt);
    expect(afterTask).toEqual(beforeTask);
  });
});

describe("invariant #13: idempotency-key replay on claimTask", () => {
  it("two claimTask calls with the same idempotency key return the same result without creating two attempts", () => {
    const { engine, storage } = setup();
    const task = buildTask();
    storage.saveTask(task);

    const first = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [],
      idempotencyKey: "idem-key-1",
    });

    const second = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [],
      idempotencyKey: "idem-key-1",
    });

    expect(second.replayed).toBe(true);
    expect(second.attempt.attempt_id).toBe(first.attempt.attempt_id);
    expect(storage.getActiveAttemptsForTask(task.task_id)).toHaveLength(1);
  });
});

describe("invariant #14: repository event sequences are monotonic and independent per repository", () => {
  it("two repositories' sequences do not collide or interfere", () => {
    const { engine, storage } = setup();
    const taskRepoA = buildTask({ repository_id: "repo_A" });
    const taskRepoB = buildTask({ repository_id: "repo_B" });
    storage.saveTask(taskRepoA);
    storage.saveTask(taskRepoB);

    engine.claimTask({
      taskId: taskRepoA.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [],
    });
    engine.claimTask({
      taskId: taskRepoB.task_id,
      agentId: "agent-b",
      workspaceSessionId: "ws-b",
      requiredResources: [],
    });
    const taskRepoA2 = buildTask({ repository_id: "repo_A" });
    storage.saveTask(taskRepoA2);
    engine.claimTask({
      taskId: taskRepoA2.task_id,
      agentId: "agent-c",
      workspaceSessionId: "ws-c",
      requiredResources: [],
    });

    const events = storage.listAllEvents();
    const repoASeqs = events
      .filter((e) => e.repository_id === "repo_A")
      .map((e) => e.repository_sequence);
    const repoBSeqs = events
      .filter((e) => e.repository_id === "repo_B")
      .map((e) => e.repository_sequence);

    expect(repoASeqs).toEqual([1, 2]);
    expect(repoBSeqs).toEqual([1]);

    // Sequences within a single repo are strictly increasing.
    const { engine: engine2, storage: storage2 } = setup();
    const t1 = buildTask({ repository_id: "repo_X", task_id: "t1" });
    storage2.saveTask(t1);
    const claim = engine2.claimTask({
      taskId: t1.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [],
    });
    engine2.heartbeatAttempt({
      attemptId: claim.attempt.attempt_id,
      fencingToken: claim.fencingToken,
    });
    engine2.completeAttempt({
      attemptId: claim.attempt.attempt_id,
      fencingToken: claim.fencingToken,
    });
    const seqs = storage2
      .listAllEvents()
      .filter((e) => e.repository_id === "repo_X")
      .map((e) => e.repository_sequence);
    expect(seqs).toEqual([1, 2, 3]);
  });
});

describe("failAttempt requeues the task (below retry limit)", () => {
  it("transitions task back to queued and releases resources", () => {
    const { engine, storage } = setup();
    const task = buildTask();
    storage.saveTask(task);

    const claim = engine.claimTask({
      taskId: task.task_id,
      agentId: "agent-a",
      workspaceSessionId: "ws-a",
      requiredResources: [
        { resourceType: "path", resourceKey: "x.ts", mode: "write" },
      ],
    });

    const failResult = engine.failAttempt({
      attemptId: claim.attempt.attempt_id,
      fencingToken: claim.fencingToken,
      error: "agent crashed",
    });

    expect(failResult.task.status).toBe("queued");
    expect(failResult.attempt.status).toBe("failed");
    expect(storage.getActiveResourceClaims(task.repository_id)).toHaveLength(
      0,
    );
  });

  it("escalates to failed once max attempts is exceeded", () => {
    const { engine, storage } = setup();
    const task = buildTask();
    storage.saveTask(task);

    let taskId = task.task_id;
    for (let i = 0; i < 3; i += 1) {
      const claim = engine.claimTask({
        taskId,
        agentId: `agent-${i}`,
        workspaceSessionId: `ws-${i}`,
        requiredResources: [],
      });
      const result = engine.failAttempt({
        attemptId: claim.attempt.attempt_id,
        fencingToken: claim.fencingToken,
        error: "boom",
        maxAttempts: 3,
      });
      if (i < 2) {
        expect(result.task.status).toBe("queued");
      } else {
        expect(result.task.status).toBe("failed");
      }
    }
  });
});

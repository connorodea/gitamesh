import { randInt } from "../prng.js";
import { buildSimTask, syntheticAgentIds } from "../fixtures.js";
import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 4: worker crash simulation.
 *
 * An agent claims a task, sends a PRNG-determined number of healthy
 * heartbeats, then "goes silent" (crashes mid-attempt: no more
 * heartbeats, ever). We advance the clock past the lease's `expires_at`
 * and call `expireStaleLeases`, exactly the sweep a daemon runs
 * periodically in production. A second, healthy agent then claims the
 * requeued task.
 *
 * Invariant asserted: the crashed attempt transitions to `expired`, its
 * resource claims are released, the task is requeued to `queued`, and
 * the next successful claim receives a strictly higher fencing token
 * than the crashed attempt held (`packages/core/test/engine.invariants.test.ts`
 * invariant #11, generalized to a PRNG-chosen crash point and PRNG-chosen
 * "who claims next").
 */
export const workerCrashRequeueScenario: Scenario = {
  name: "worker-crash-requeue",
  title: "Worker crash mid-attempt",
  description:
    "An agent stops heartbeating mid-attempt; its lease must expire and the task must requeue with a fresh, higher fencing token.",
  run(ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    const repositoryId = "repo_worker_crash";
    const agentIds = syntheticAgentIds(Math.max(ctx.agentCount, 2));
    const crashedAgent = agentIds[0]!;
    const rescueAgent = agentIds[randInt(ctx.rng, 1, agentIds.length - 1)]!;

    const task = buildSimTask({
      taskId: "task_worker_crash_1",
      repositoryId,
      workflowId: "wf_worker_crash",
      title: "Crash-prone task",
    });
    ctx.storage.saveTask(task);

    const claim = ctx.engine.claimTask({
      taskId: task.task_id,
      agentId: crashedAgent,
      workspaceSessionId: `ws-${crashedAgent}`,
      requiredResources: [
        { resourceType: "path", resourceKey: "src/crashy.ts", mode: "write" },
      ],
    });
    record({
      action: "claimTask",
      actorAgentId: crashedAgent,
      taskId: task.task_id,
      outcome: "ok",
      detail: `fencing_token=${claim.fencingToken}`,
    });

    const healthyHeartbeats = randInt(ctx.rng, 0, 3);
    let lastFencingToken = claim.fencingToken;
    for (let i = 0; i < healthyHeartbeats; i += 1) {
      const hb = ctx.engine.heartbeatAttempt({
        attemptId: claim.attempt.attempt_id,
        fencingToken: lastFencingToken,
      });
      lastFencingToken = hb.attempt.fencing_token ?? lastFencingToken;
      record({
        action: "heartbeatAttempt",
        actorAgentId: crashedAgent,
        taskId: task.task_id,
        outcome: "ok",
        detail: `healthy heartbeat ${i + 1}/${healthyHeartbeats}`,
      });
    }

    record({
      action: "agent goes silent (simulated crash)",
      actorAgentId: crashedAgent,
      taskId: task.task_id,
      outcome: "info",
      detail: `no further heartbeats after ${healthyHeartbeats} healthy one(s)`,
    });

    // Force the lease past expiry deterministically (no real sleeping).
    const staleAttempt = ctx.storage.getAttempt(claim.attempt.attempt_id)!;
    ctx.storage.saveAttempt({
      ...staleAttempt,
      expires_at: "1999-01-01T00:00:00.000Z",
    });

    const sweepAt = "2000-01-01T00:00:00.000Z";
    const expireResult = ctx.engine.expireStaleLeases(sweepAt);
    record({
      action: "expireStaleLeases sweep",
      outcome: "info",
      detail: `${expireResult.expiredAttemptIds.length} attempt(s) expired; requeued task(s): [${expireResult.requeuedTaskIds.join(", ")}]`,
    });

    const taskAfterExpiry = ctx.storage.getTask(task.task_id);
    const activeClaimsAfterExpiry = ctx.storage.getActiveResourceClaims(repositoryId);

    const rescue = ctx.engine.claimTask({
      taskId: task.task_id,
      agentId: rescueAgent,
      workspaceSessionId: `ws-${rescueAgent}`,
      requiredResources: [
        { resourceType: "path", resourceKey: "src/crashy.ts", mode: "write" },
      ],
    });
    record({
      action: "claimTask (rescue)",
      actorAgentId: rescueAgent,
      taskId: task.task_id,
      outcome: "ok",
      detail: `fencing_token=${rescue.fencingToken}`,
    });

    const pass =
      expireResult.expiredAttemptIds.includes(claim.attempt.attempt_id) &&
      expireResult.requeuedTaskIds.includes(task.task_id) &&
      taskAfterExpiry?.status === "queued" &&
      activeClaimsAfterExpiry.length === 0 &&
      rescue.fencingToken > claim.fencingToken;

    return {
      name: "worker-crash-requeue",
      title: "Worker crash mid-attempt",
      status: pass ? "pass" : "fail",
      reason: pass
        ? `Crashed attempt expired, task requeued, resources released, and rescue claim got a higher fencing token (${claim.fencingToken} -> ${rescue.fencingToken}).`
        : `expired=${expireResult.expiredAttemptIds.includes(claim.attempt.attempt_id)}, requeued=${expireResult.requeuedTaskIds.includes(task.task_id)}, taskStatus=${taskAfterExpiry?.status}, activeClaims=${activeClaimsAfterExpiry.length}, tokens(${claim.fencingToken} -> ${rescue.fencingToken}).`,
      timeline: entries,
    };
  },
};

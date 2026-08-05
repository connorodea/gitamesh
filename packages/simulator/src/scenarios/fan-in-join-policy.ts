import { buildSimTask } from "../fixtures.js";
import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 8: fan-in / join-policy evaluation.
 *
 * `Task.join_policy` (`"all" | "any" | "quorum"`,
 * `packages/protocol/src/entities.ts`) and `Task.dependencies` are real,
 * validated schema fields. `packages/core/src/fan-in.ts`'s
 * `evaluateFanIn` is the reducer behind them, invoked from
 * `CoordinationEngine.completeAttempt` (task -> `completed`) and
 * `failAttempt` (task escalates all the way to `failed`, retries
 * exhausted). This scenario now exercises the REAL evaluator — this used
 * to be an honest "gap" scenario (`fan-in-join-policy-gap.ts`) that
 * confirmed the absence of any fan-in behavior; it has been rewritten to
 * assert genuine correctness now that the evaluator exists.
 *
 * Two independent join-groups are exercised in one run:
 *
 *  - `"any"` group: a task depends on [depA, depB] with `join_policy:
 *    "any"`. Only depA completes; depB is left `pending`. Asserted: the
 *    depending task's status flips `pending -> queued` off of ONE
 *    completed dependency, exactly as the join policy requires.
 *  - `"all"` group: a task depends on [depC, depD] with `join_policy:
 *    "all"`. depC completes first — asserted the depending task is
 *    still `pending` (an "all" policy must NOT unblock on a partial
 *    fan-in). depD then also completes — asserted the depending task
 *    NOW flips to `queued`.
 *
 * `"quorum"` is deliberately not exercised here as a positive case: see
 * `packages/core/src/fan-in.ts`'s doc comment and this package's README
 * for why (`TaskSchema` has no quorum-threshold field to evaluate
 * against, so `evaluateFanIn` treats `"quorum"` as a documented no-op
 * rather than fabricating a default threshold).
 */
export const fanInJoinPolicyScenario: Scenario = {
  name: "fan-in-join-policy",
  title: "Fan-in under a join policy",
  description:
    "packages/core/src/fan-in.ts evaluates Task.join_policy against Task.dependencies on every terminal task transition; verifies real 'any' (unblocks on the first completed dependency) and 'all' (does NOT unblock on a partial fan-in, then does once every dependency completes) behavior.",
  run(ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    const repositoryId = "repo_fan_in";

    // --- "any" group -------------------------------------------------------
    const depA = buildSimTask({
      taskId: "task_fanin_dep_a",
      repositoryId,
      workflowId: "wf_fan_in",
      title: "Dependency A (will complete)",
    });
    const depB = buildSimTask({
      taskId: "task_fanin_dep_b",
      repositoryId,
      workflowId: "wf_fan_in",
      title: "Dependency B (left pending)",
    });
    const joinedAny = buildSimTask({
      taskId: "task_fanin_joined_any",
      repositoryId,
      workflowId: "wf_fan_in",
      title: "Task requiring ANY of [depA, depB]",
      dependencies: [depA.task_id, depB.task_id],
      joinPolicy: "any",
    });
    ctx.storage.saveTask(depA);
    ctx.storage.saveTask(depB);
    ctx.storage.saveTask(joinedAny);

    const anyStatusBefore = ctx.storage.getTask(joinedAny.task_id)?.status;

    const claimA = ctx.engine.claimTask({
      taskId: depA.task_id,
      agentId: "sim-agent-1",
      workspaceSessionId: "ws-sim-agent-1",
      requiredResources: [],
    });
    ctx.engine.completeAttempt({
      attemptId: claimA.attempt.attempt_id,
      fencingToken: claimA.fencingToken,
    });
    record({
      action: "completeAttempt",
      actorAgentId: "sim-agent-1",
      taskId: depA.task_id,
      outcome: "ok",
      detail: `dependency A completed; "any"-policy join on ${joinedAny.task_id} should now be satisfied`,
    });

    const anyStatusAfter = ctx.storage.getTask(joinedAny.task_id)?.status;
    record({
      action: "inspect 'any' joined task after ONE of its dependencies completed",
      taskId: joinedAny.task_id,
      outcome: "info",
      detail: `status before=${anyStatusBefore}, after=${anyStatusAfter} (depB still pending, uncompleted)`,
    });

    // --- "all" group ---------------------------------------------------------
    const depC = buildSimTask({
      taskId: "task_fanin_dep_c",
      repositoryId,
      workflowId: "wf_fan_in",
      title: "Dependency C (completes first)",
    });
    const depD = buildSimTask({
      taskId: "task_fanin_dep_d",
      repositoryId,
      workflowId: "wf_fan_in",
      title: "Dependency D (completes second)",
    });
    const joinedAll = buildSimTask({
      taskId: "task_fanin_joined_all",
      repositoryId,
      workflowId: "wf_fan_in",
      title: "Task requiring ALL of [depC, depD]",
      dependencies: [depC.task_id, depD.task_id],
      joinPolicy: "all",
    });
    ctx.storage.saveTask(depC);
    ctx.storage.saveTask(depD);
    ctx.storage.saveTask(joinedAll);

    const allStatusBefore = ctx.storage.getTask(joinedAll.task_id)?.status;

    const claimC = ctx.engine.claimTask({
      taskId: depC.task_id,
      agentId: "sim-agent-2",
      workspaceSessionId: "ws-sim-agent-2",
      requiredResources: [],
    });
    ctx.engine.completeAttempt({
      attemptId: claimC.attempt.attempt_id,
      fencingToken: claimC.fencingToken,
    });
    record({
      action: "completeAttempt",
      actorAgentId: "sim-agent-2",
      taskId: depC.task_id,
      outcome: "ok",
      detail: `dependency C completed; "all"-policy join on ${joinedAll.task_id} must NOT unblock yet (depD still pending)`,
    });

    const allStatusAfterPartial = ctx.storage.getTask(joinedAll.task_id)?.status;
    record({
      action: "inspect 'all' joined task after ONE of TWO dependencies completed",
      taskId: joinedAll.task_id,
      outcome: "info",
      detail: `status before=${allStatusBefore}, after one dependency=${allStatusAfterPartial} (must remain unchanged under 'all')`,
    });

    const claimD = ctx.engine.claimTask({
      taskId: depD.task_id,
      agentId: "sim-agent-3",
      workspaceSessionId: "ws-sim-agent-3",
      requiredResources: [],
    });
    ctx.engine.completeAttempt({
      attemptId: claimD.attempt.attempt_id,
      fencingToken: claimD.fencingToken,
    });
    record({
      action: "completeAttempt",
      actorAgentId: "sim-agent-3",
      taskId: depD.task_id,
      outcome: "ok",
      detail: `dependency D completed; "all"-policy join on ${joinedAll.task_id} should now be satisfied`,
    });

    const allStatusAfterFull = ctx.storage.getTask(joinedAll.task_id)?.status;
    record({
      action: "inspect 'all' joined task after BOTH dependencies completed",
      taskId: joinedAll.task_id,
      outcome: "info",
      detail: `status after both dependencies=${allStatusAfterFull}`,
    });

    const anyUnblockedOnFirstDependency =
      anyStatusBefore === "pending" && anyStatusAfter === "queued";
    const allDidNotUnblockOnPartialFanIn =
      allStatusBefore === "pending" && allStatusAfterPartial === "pending";
    const allUnblockedOnceEveryDependencyCompleted =
      allStatusAfterFull === "queued";

    const pass =
      anyUnblockedOnFirstDependency &&
      allDidNotUnblockOnPartialFanIn &&
      allUnblockedOnceEveryDependencyCompleted;

    return {
      name: "fan-in-join-policy",
      title: "Fan-in under a join policy",
      status: pass ? "pass" : "fail",
      reason: pass
        ? `"any" unblocked on the first completed dependency (${anyStatusBefore} -> ${anyStatusAfter}); "all" correctly stayed ${allStatusAfterPartial} after only one of two dependencies completed, then unblocked (${allStatusBefore} -> ${allStatusAfterFull}) once both did.`
        : `anyUnblockedOnFirstDependency=${anyUnblockedOnFirstDependency} (before=${anyStatusBefore}, after=${anyStatusAfter}); allDidNotUnblockOnPartialFanIn=${allDidNotUnblockOnPartialFanIn} (before=${allStatusBefore}, afterPartial=${allStatusAfterPartial}); allUnblockedOnceEveryDependencyCompleted=${allUnblockedOnceEveryDependencyCompleted} (afterFull=${allStatusAfterFull}).`,
      timeline: entries,
    };
  },
};

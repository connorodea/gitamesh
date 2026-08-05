import { buildSimTask } from "../fixtures.js";
import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 8: partial fan-in / reducer failure under a join policy.
 *
 * GAP, documented honestly. `Task.join_policy` (`"all" | "any" |
 * "quorum"`, `packages/protocol/src/entities.ts`) is a real, validated
 * schema field, and `Task.dependencies` is a real array of task ids —
 * but nothing in `packages/core/src/engine.ts` ever reads either field.
 * There is no fan-in evaluator: completing one, some, or all of a
 * dependency set has zero effect on the depending task's status: it
 * stays wherever it was left (typically `pending`, since nothing ever
 * moves it to `queued` either). A "some dependencies complete under
 * `any`" join policy should, per the spec, be enough to unblock the
 * dependent — but there is no code path that does that unblocking.
 *
 * What this scenario DOES verify (real, in-scope, not fabricated): a
 * task with `join_policy: "any"` and two dependencies has ONE dependency
 * completed and the other left `pending`; the depending task's status
 * is inspected afterward and shown to be completely unaffected — still
 * whatever it started as. That is the accurate current behavior.
 */
export const fanInJoinPolicyGapScenario: Scenario = {
  name: "fan-in-join-policy-gap",
  title: "Partial fan-in under a join policy",
  description:
    "packages/core never reads Task.join_policy or Task.dependencies; verifies a completed dependency has no observable fan-in effect, rather than fabricating join-policy evaluation.",
  run(ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    const repositoryId = "repo_fan_in";

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
    const joined = buildSimTask({
      taskId: "task_fanin_joined",
      repositoryId,
      workflowId: "wf_fan_in",
      title: "Task requiring ANY of [depA, depB]",
      dependencies: [depA.task_id, depB.task_id],
      joinPolicy: "any",
    });
    ctx.storage.saveTask(depA);
    ctx.storage.saveTask(depB);
    ctx.storage.saveTask(joined);

    const joinedStatusBefore = ctx.storage.getTask(joined.task_id)?.status;

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
      detail: `dependency A completed; join_policy="any" on ${joined.task_id} would, per spec, be satisfiable now`,
    });

    const joinedStatusAfter = ctx.storage.getTask(joined.task_id)?.status;
    record({
      action: "inspect joined task after ONE of its 'any'-policy dependencies completed",
      taskId: joined.task_id,
      outcome: "info",
      detail: `status before=${joinedStatusBefore}, after=${joinedStatusAfter} (depB still pending, uncompleted)`,
    });

    const noObservableFanIn = joinedStatusBefore === joinedStatusAfter;

    return {
      name: "fan-in-join-policy-gap",
      title: "Partial fan-in under a join policy",
      status: "skipped",
      blockedOn:
        "packages/core has no join-policy evaluator — Task.join_policy and Task.dependencies are stored schema fields with no reducer behind them",
      reason: noObservableFanIn
        ? `Confirmed: completing 1 of 2 "any"-policy dependencies left the depending task's status unchanged (${joinedStatusBefore} -> ${joinedStatusAfter}). This is accurate current behavior — there is no fan-in logic to unblock it, so this scenario cannot assert real join-policy correctness yet.`
        : `Unexpected: the joined task's status changed (${joinedStatusBefore} -> ${joinedStatusAfter}) despite no known fan-in evaluator — worth investigating.`,
      timeline: entries,
    };
  },
};

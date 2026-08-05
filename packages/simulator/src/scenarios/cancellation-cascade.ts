import { buildSimTask } from "../fixtures.js";
import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 7: cancellation propagation to child/dependent tasks.
 *
 * `packages/core/src/engine.ts`'s `CoordinationEngine.cancelTask` and
 * `packages/core/src/cancellation.ts`'s `cascadeCancelChildren` are the
 * reducers behind this scenario. This used to be an honest "gap"
 * scenario (`cancellation-cascade-gap.ts`) that confirmed no cancellation
 * cascade existed anywhere in `packages/core`; it has been rewritten to
 * assert genuine correctness now that `cancelTask` exists.
 *
 * Two relations are exercised, matching the two distinct cascade
 * mechanisms `cancelTask` drives:
 *
 *  - `parent_task_id` (children): a still-`pending` child cascades to
 *    `cancelled` alongside its parent. A SEPARATE child that has already
 *    been claimed (status `running`) is left untouched — this is the
 *    documented scope boundary in `cancellation.ts`'s doc comment,
 *    mirroring `evaluateFanIn`'s own scope guard: once claimed, a
 *    child's lifecycle is driven by attempt outcomes, not by its
 *    parent's fate.
 *  - `dependencies` (dependents): a task depending on the cancelled
 *    parent under `join_policy: "all"` reaches `dead_letter` — not via
 *    any cancellation-specific logic, but because `cancelTask` calls the
 *    EXISTING `evaluateFanIn` reducer (`packages/core/src/fan-in.ts`),
 *    which already treats `cancelled` as one of its
 *    `NEVER_COMPLETES_STATES`. This scenario is the first one to prove
 *    that wiring actually fires end to end for a genuinely-cancelled
 *    task (`fan-in-join-policy.ts` only ever exercises `completed`/
 *    `failed` dependencies).
 */
export const cancellationCascadeScenario: Scenario = {
  name: "cancellation-cascade",
  title: "Cancellation propagation to child tasks",
  description:
    "CoordinationEngine.cancelTask cascades to pending/blocked children (parent_task_id) and, via the existing evaluateFanIn reducer, dead-letters 'all'/'any' dependents that can never complete; a claimed/running child is left untouched by design.",
  run(ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    const repositoryId = "repo_cancellation_cascade";

    const parent = buildSimTask({
      taskId: "task_cancel_parent",
      repositoryId,
      workflowId: "wf_cancel_cascade",
      title: "Parent task (about to be cancelled)",
    });
    const pendingChild = buildSimTask({
      taskId: "task_cancel_pending_child",
      repositoryId,
      workflowId: "wf_cancel_cascade",
      title: "Pending child (still parent-driven — should cascade)",
      parentTaskId: parent.task_id,
    });
    const runningChild = buildSimTask({
      taskId: "task_cancel_running_child",
      repositoryId,
      workflowId: "wf_cancel_cascade",
      title: "Running child (already claimed — should be left alone)",
      parentTaskId: parent.task_id,
    });
    const dependent = buildSimTask({
      taskId: "task_cancel_dependent",
      repositoryId,
      workflowId: "wf_cancel_cascade",
      title: "Task depending on the parent (join_policy: all)",
      dependencies: [parent.task_id],
      joinPolicy: "all",
    });
    ctx.storage.saveTask(parent);
    ctx.storage.saveTask(pendingChild);
    ctx.storage.saveTask(runningChild);
    ctx.storage.saveTask(dependent);

    // Claim the "running child" BEFORE the parent is cancelled, so it is
    // genuinely out of the "still parent-driven" scope by the time
    // cancelTask runs.
    const runningChildClaim = ctx.engine.claimTask({
      taskId: runningChild.task_id,
      agentId: "sim-agent-1",
      workspaceSessionId: "ws-sim-agent-1",
      requiredResources: [],
    });
    record({
      action: "claimTask on running_child (before parent cancellation)",
      actorAgentId: "sim-agent-1",
      taskId: runningChild.task_id,
      outcome: "ok",
      detail: `succeeded with fencing_token=${runningChildClaim.fencingToken}; this child is now out of scope for the parent's cascade`,
    });

    const cancelResult = ctx.engine.cancelTask({ taskId: parent.task_id });
    record({
      action: "engine.cancelTask(parent)",
      taskId: parent.task_id,
      outcome: "ok",
      detail: `parent.status=${cancelResult.task.status}; cascadedChildren=${cancelResult.cancelledChildren.map((t) => t.task_id).join(",") || "(none)"}; fanInChanged=${cancelResult.fanInChanged.map((t) => t.task_id).join(",") || "(none)"}`,
    });

    const parentAfter = ctx.storage.getTask(parent.task_id);
    const pendingChildAfter = ctx.storage.getTask(pendingChild.task_id);
    const runningChildAfter = ctx.storage.getTask(runningChild.task_id);
    const dependentAfter = ctx.storage.getTask(dependent.task_id);

    record({
      action: "inspect family after parent cancellation",
      outcome: "info",
      detail: `parent=${parentAfter?.status}, pending_child=${pendingChildAfter?.status}, running_child=${runningChildAfter?.status}, dependent=${dependentAfter?.status}`,
    });

    const parentCancelled = parentAfter?.status === "cancelled";
    const pendingChildCascaded = pendingChildAfter?.status === "cancelled";
    const runningChildLeftAlone = runningChildAfter?.status === "running";
    const dependentDeadLettered = dependentAfter?.status === "dead_letter";

    const pass =
      parentCancelled &&
      pendingChildCascaded &&
      runningChildLeftAlone &&
      dependentDeadLettered;

    return {
      name: "cancellation-cascade",
      title: "Cancellation propagation to child tasks",
      status: pass ? "pass" : "fail",
      reason: pass
        ? `Parent cancelled (${parentAfter?.status}); pending child cascaded to cancelled as expected (parent-driven, not yet claimed); running child was left at "running" (already claimed — out of cascade scope by design); dependent ("all" policy on the now-cancelled parent) escalated to dead_letter via the existing evaluateFanIn reducer, which already treats "cancelled" as permanently unsatisfiable.`
        : `parentCancelled=${parentCancelled} (${parentAfter?.status}); pendingChildCascaded=${pendingChildCascaded} (${pendingChildAfter?.status}); runningChildLeftAlone=${runningChildLeftAlone} (${runningChildAfter?.status}); dependentDeadLettered=${dependentDeadLettered} (${dependentAfter?.status}).`,
      timeline: entries,
    };
  },
};

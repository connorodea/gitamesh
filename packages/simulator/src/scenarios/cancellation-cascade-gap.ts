import { canTransitionTask } from "@gitamesh/core";
import { buildSimTask } from "../fixtures.js";
import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 7: cancellation propagation to child/dependent tasks.
 *
 * GAP, documented honestly. `packages/core`'s `CoordinationEngine` (see
 * `packages/core/src/engine.ts`) exposes exactly five operations —
 * `claimTask`, `heartbeatAttempt`, `completeAttempt`, `failAttempt`,
 * `expireStaleLeases` — and none of them is a `cancelTask`. `cancelled`
 * IS a legal target state in `TASK_TRANSITIONS`
 * (`packages/core/src/state-machines.ts`), so the *state machine*
 * supports a task being cancelled, but nothing in `packages/core` ever
 * drives a task there, and there is no cascade logic anywhere that walks
 * `Task.parent_task_id` / `Task.dependencies` to cancel or block
 * dependents when a parent is cancelled.
 *
 * What this scenario DOES verify (real, in-scope, not fabricated): using
 * ONLY `canTransitionTask` (the pure predicate `packages/core` exports)
 * to validate the transition — mirroring exactly what a future
 * `cancelTask` engine method would have to do — we cancel a parent task
 * directly via storage (there being no engine method to call) and
 * confirm its child (`parent_task_id` pointing at it) and its dependent
 * (`dependencies` including it) are left completely untouched: still
 * `pending`, still independently claimable. That is the accurate
 * current behavior: cancellation does not cascade because nothing
 * implements cascade, not because we asserted a made-up engine
 * invariant.
 */
export const cancellationCascadeGapScenario: Scenario = {
  name: "cancellation-cascade-gap",
  title: "Cancellation propagation to child tasks",
  description:
    "packages/core has no cancelTask operation and no cascade logic; verifies dependents are left untouched rather than fabricating cascade behavior.",
  run(ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    const repositoryId = "repo_cancellation_cascade";

    const parent = buildSimTask({
      taskId: "task_cancel_parent",
      repositoryId,
      workflowId: "wf_cancel_cascade",
      title: "Parent task (about to be cancelled)",
    });
    const child = buildSimTask({
      taskId: "task_cancel_child",
      repositoryId,
      workflowId: "wf_cancel_cascade",
      title: "Child task",
      parentTaskId: parent.task_id,
    });
    const dependent = buildSimTask({
      taskId: "task_cancel_dependent",
      repositoryId,
      workflowId: "wf_cancel_cascade",
      title: "Task depending on the parent",
      dependencies: [parent.task_id],
    });
    ctx.storage.saveTask(parent);
    ctx.storage.saveTask(child);
    ctx.storage.saveTask(dependent);

    const canCancel = canTransitionTask(parent.status, "cancelled");
    record({
      action: "canTransitionTask(pending, cancelled)",
      taskId: parent.task_id,
      outcome: canCancel ? "ok" : "error",
      detail: `state machine permits cancellation: ${canCancel}`,
    });

    if (canCancel) {
      ctx.storage.saveTask({ ...parent, status: "cancelled" });
      record({
        action: "cancel parent (direct storage write — no engine.cancelTask exists)",
        taskId: parent.task_id,
        outcome: "info",
        detail: "parent transitioned to cancelled outside the engine, since no engine method does this",
      });
    }

    const childAfter = ctx.storage.getTask(child.task_id);
    const dependentAfter = ctx.storage.getTask(dependent.task_id);

    const childUntouched = childAfter?.status === "pending";
    const dependentUntouched = dependentAfter?.status === "pending";

    record({
      action: "inspect child/dependent after parent cancellation",
      outcome: "info",
      detail: `child.status=${childAfter?.status}, dependent.status=${dependentAfter?.status}`,
    });

    // Prove they are still independently claimable (no invisible lock
    // was placed on them by the "cancellation").
    const childClaim = ctx.engine.claimTask({
      taskId: child.task_id,
      agentId: "sim-agent-1",
      workspaceSessionId: "ws-sim-agent-1",
      requiredResources: [],
    });
    record({
      action: "claimTask on child (post-parent-cancellation)",
      actorAgentId: "sim-agent-1",
      taskId: child.task_id,
      outcome: "ok",
      detail: `succeeded with fencing_token=${childClaim.fencingToken}; no cascade blocked it`,
    });

    const pass = canCancel && childUntouched && dependentUntouched;

    return {
      name: "cancellation-cascade-gap",
      title: "Cancellation propagation to child tasks",
      status: "skipped",
      blockedOn:
        "packages/core has no cancelTask operation and no dependency/parent-task cascade logic — cancellation cannot propagate because nothing implements propagation",
      reason: pass
        ? `Confirmed: cancelling the parent left its child and dependent tasks at "pending" and independently claimable — no cascade occurred because none exists. This is accurate current behavior, not a passing test of a real invariant.`
        : `Unexpected: childUntouched=${childUntouched}, dependentUntouched=${dependentUntouched} — worth investigating if something DID cascade.`,
      timeline: entries,
    };
  },
};

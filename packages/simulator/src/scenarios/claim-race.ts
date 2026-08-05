import { GitameshError } from "@gitamesh/protocol";
import { shuffle } from "../prng.js";
import { buildSimTask, syntheticAgentIds } from "../fixtures.js";
import { describeError } from "./error-detail.js";
import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 1: simultaneous task-claim races.
 *
 * `packages/core`'s `CoordinationEngine.claimTask` is synchronous and
 * transactional, so there is no real thread interleaving to simulate —
 * the adversarial condition we care about is "N agents all decide, in
 * the same scheduling tick, to claim the same pending task." We simulate
 * that by generating a PRNG-shuffled attempt order for every agent in
 * the fleet against a single shared task and firing `claimTask` for each
 * in that order within the same synchronous pass (mirroring
 * `packages/core/test/engine.invariants.test.ts`'s invariant #1 test,
 * generalized from 2 agents to the full configured fleet).
 *
 * Invariant asserted: exactly one claim succeeds; every other agent is
 * rejected with a 409 GitameshError (`task-already-claimed` or
 * `task-not-claimable`); storage agrees there is exactly one active
 * attempt for the task afterward.
 */
export const claimRaceScenario: Scenario = {
  name: "claim-race",
  title: "Simultaneous task-claim races",
  description:
    "N agents race to claim the same pending task in one tick; exactly one must win.",
  run(ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    const repositoryId = "repo_claim_race";
    const task = buildSimTask({
      taskId: "task_claim_race_1",
      repositoryId,
      workflowId: "wf_claim_race",
      title: "Contended task",
    });
    ctx.storage.saveTask(task);

    const agentIds = syntheticAgentIds(ctx.agentCount);
    const attemptOrder = shuffle(ctx.rng, agentIds);

    let winners = 0;
    let rejections = 0;
    let unexpectedErrors = 0;

    for (const agentId of attemptOrder) {
      try {
        const result = ctx.engine.claimTask({
          taskId: task.task_id,
          agentId,
          workspaceSessionId: `ws-${agentId}`,
          requiredResources: [],
        });
        winners += 1;
        record({
          action: "claimTask",
          actorAgentId: agentId,
          taskId: task.task_id,
          outcome: "ok",
          detail: `won the race, fencing_token=${result.fencingToken}`,
        });
      } catch (error) {
        if (error instanceof GitameshError && error.status === 409) {
          rejections += 1;
          record({
            action: "claimTask",
            actorAgentId: agentId,
            taskId: task.task_id,
            outcome: "error",
            errorType: error.type.split("/").pop(),
            detail: "correctly rejected: task already has a live attempt",
          });
        } else {
          unexpectedErrors += 1;
          record({
            action: "claimTask",
            actorAgentId: agentId,
            taskId: task.task_id,
            outcome: "error",
            detail: `unexpected error: ${describeError(error)}`,
          });
        }
      }
    }

    const activeAttempts = ctx.storage.getActiveAttemptsForTask(task.task_id);

    const pass =
      winners === 1 &&
      rejections === agentIds.length - 1 &&
      unexpectedErrors === 0 &&
      activeAttempts.length === 1;

    return {
      name: "claim-race",
      title: "Simultaneous task-claim races",
      status: pass ? "pass" : "fail",
      reason: pass
        ? `Exactly 1 of ${agentIds.length} agents won the claim race; storage shows exactly 1 active attempt.`
        : `Expected exactly 1 winner and ${agentIds.length - 1} clean rejections; got ${winners} winner(s), ${rejections} clean rejection(s), ${unexpectedErrors} unexpected error(s), ${activeAttempts.length} active attempt(s) in storage.`,
      timeline: entries,
    };
  },
};

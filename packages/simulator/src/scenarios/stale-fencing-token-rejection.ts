import { GitameshError } from "@gitamesh/protocol";
import { pick } from "../prng.js";
import { buildSimTask, syntheticAgentIds } from "../fixtures.js";
import { describeError } from "./error-detail.js";
import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 5: expired lease + stale fencing token rejection.
 *
 * The crashed-and-superseded agent from a `worker-crash` situation
 * doesn't know it has been superseded — it wakes back up and tries to
 * `heartbeatAttempt` / `completeAttempt` / `failAttempt` with its
 * now-stale fencing token, AFTER a second agent has already claimed the
 * requeued task and holds a fresh, higher token. Which operation the
 * zombie agent tries first is PRNG-chosen per run.
 *
 * Invariant asserted (mirrors `packages/core/test/engine.invariants.test.ts`
 * invariant #8, which itself only asserts `toThrow(GitameshError)`
 * generically — NOT a single fixed status code): all three operations
 * are rejected with SOME 4xx `GitameshError`, and none of them mutate
 * the current (superseding) attempt or task state.
 *
 * A genuine nuance this scenario surfaces (not a defect it invents):
 * `heartbeatAttempt` has an explicit terminal-status guard
 * (`packages/core/src/engine.ts`) that throws the specific 409
 * `stale-attempt-token` error for a non-leased/running attempt.
 * `completeAttempt` / `failAttempt` do not have that same guard for the
 * `"expired"` status (only for `"completed"`/`"failed"` replay) — once
 * `expireStaleLeases` has already flipped the zombie's attempt to
 * `"expired"`, its own `fencing_token` field is untouched, so
 * `assertFencingTokenCurrent` (which compares the provided token against
 * THAT SAME attempt's own token) passes, and the rejection instead comes
 * from `assertAttemptTransition` as a 422 `invalid-state-transition`
 * (`expired` -> `completed`/`failed` is not a legal edge in
 * `ATTEMPT_TRANSITIONS`). Both are correct rejections of the zombie's
 * request under the SAME underlying invariant (state must not mutate);
 * they just surface through a different one of core's two guard
 * mechanisms depending on which operation is called.
 */
export const staleFencingTokenRejectionScenario: Scenario = {
  name: "stale-fencing-token-rejection",
  title: "Stale fencing token rejected after supersession",
  description:
    "A superseded (zombie) agent's fencing token must be rejected by heartbeat/complete/fail, in whichever order the run picks.",
  run(ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    const repositoryId = "repo_stale_token";
    const agentIds = syntheticAgentIds(Math.max(ctx.agentCount, 2));
    const zombieAgent = agentIds[0]!;
    const supersedingAgent = agentIds[1]!;

    const task = buildSimTask({
      taskId: "task_stale_token_1",
      repositoryId,
      workflowId: "wf_stale_token",
      title: "Zombie-prone task",
    });
    ctx.storage.saveTask(task);

    const zombieClaim = ctx.engine.claimTask({
      taskId: task.task_id,
      agentId: zombieAgent,
      workspaceSessionId: `ws-${zombieAgent}`,
      requiredResources: [],
    });
    const staleToken = zombieClaim.fencingToken;
    const attemptId = zombieClaim.attempt.attempt_id;
    record({
      action: "claimTask",
      actorAgentId: zombieAgent,
      taskId: task.task_id,
      outcome: "ok",
      detail: `fencing_token=${staleToken} (will go stale)`,
    });

    const attempt = ctx.storage.getAttempt(attemptId)!;
    ctx.storage.saveAttempt({
      ...attempt,
      expires_at: "1999-01-01T00:00:00.000Z",
    });
    ctx.engine.expireStaleLeases("2000-01-01T00:00:00.000Z");
    record({
      action: "expireStaleLeases sweep",
      outcome: "info",
      detail: `${zombieAgent}'s lease expired; task requeued`,
    });

    const supersedingClaim = ctx.engine.claimTask({
      taskId: task.task_id,
      agentId: supersedingAgent,
      workspaceSessionId: `ws-${supersedingAgent}`,
      requiredResources: [],
    });
    record({
      action: "claimTask (superseding)",
      actorAgentId: supersedingAgent,
      taskId: task.task_id,
      outcome: "ok",
      detail: `fencing_token=${supersedingClaim.fencingToken}`,
    });

    const attemptedOps = pick(ctx.rng, [
      ["heartbeat", "complete", "fail"],
      ["complete", "fail", "heartbeat"],
      ["fail", "heartbeat", "complete"],
    ] as const);

    let rejectedCount = 0;
    let unexpectedCount = 0;

    for (const op of attemptedOps) {
      try {
        if (op === "heartbeat") {
          ctx.engine.heartbeatAttempt({ attemptId, fencingToken: staleToken });
        } else if (op === "complete") {
          ctx.engine.completeAttempt({ attemptId, fencingToken: staleToken });
        } else {
          ctx.engine.failAttempt({
            attemptId,
            fencingToken: staleToken,
            error: "zombie retry",
          });
        }
        unexpectedCount += 1;
        record({
          action: `${op}Attempt (zombie, stale token)`,
          actorAgentId: zombieAgent,
          taskId: task.task_id,
          outcome: "error",
          detail: "UNEXPECTED: stale token was accepted",
        });
      } catch (error) {
        if (
          error instanceof GitameshError &&
          (error.status === 409 || error.status === 422)
        ) {
          rejectedCount += 1;
          record({
            action: `${op}Attempt (zombie, stale token)`,
            actorAgentId: zombieAgent,
            taskId: task.task_id,
            outcome: "error",
            errorType: error.type.split("/").pop(),
            detail: `correctly rejected (${describeError(error)})`,
          });
        } else {
          unexpectedCount += 1;
          record({
            action: `${op}Attempt (zombie, stale token)`,
            actorAgentId: zombieAgent,
            taskId: task.task_id,
            outcome: "error",
            detail: `unexpected error type: ${describeError(error)}`,
          });
        }
      }
    }

    const supersedingAttempt = ctx.storage.getAttempt(
      supersedingClaim.attempt.attempt_id,
    );
    const pass =
      rejectedCount === 3 &&
      unexpectedCount === 0 &&
      supersedingAttempt?.status === "running" &&
      supersedingAttempt.fencing_token === supersedingClaim.fencingToken;

    return {
      name: "stale-fencing-token-rejection",
      title: "Stale fencing token rejected after supersession",
      status: pass ? "pass" : "fail",
      reason: pass
        ? `All 3 zombie operations (order: ${attemptedOps.join(", ")}) were rejected; the superseding attempt's state was untouched.`
        : `rejected=${rejectedCount}/3, unexpected=${unexpectedCount}, supersedingAttemptStatus=${supersedingAttempt?.status}.`,
      timeline: entries,
    };
  },
};

import { buildSimTask, syntheticAgentIds } from "../fixtures.js";
import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 3: duplicate/replayed commands.
 *
 * Simulates a flaky network causing the same `claimTask` request (same
 * `idempotencyKey`) to be delivered twice — once by the original caller,
 * once by an at-least-once retry layer above it. This exercises
 * `CoordinationEngine.claimTask`'s idempotency-key replay path directly
 * (`packages/core/src/engine.ts`'s `lookupIdempotentResult` /
 * `recordIdempotentResult`), the same mechanism proved once in
 * `packages/core/test/engine.invariants.test.ts` invariant #13, here
 * driven by the PRNG so the "when" of the duplicate delivery (how many
 * unrelated claims happen in between) varies with seed while the
 * assertion stays the same.
 *
 * Invariant asserted: the second delivery is a replay (no new attempt,
 * no new event, same attempt_id returned) and the task still has exactly
 * one active attempt.
 */
export const duplicateClaimIdempotencyScenario: Scenario = {
  name: "duplicate-claim-idempotency",
  title: "Duplicate/replayed claimTask commands",
  description:
    "The same idempotency key is submitted twice for claimTask; the replay must not create a second attempt.",
  run(ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    const repositoryId = "repo_dup_claim";
    const agentIds = syntheticAgentIds(ctx.agentCount);
    const agentId = agentIds[0]!;

    const task = buildSimTask({
      taskId: "task_dup_claim_1",
      repositoryId,
      workflowId: "wf_dup_claim",
      title: "Idempotent claim target",
    });
    ctx.storage.saveTask(task);

    const idempotencyKey = "idem-claim-replay-1";

    const eventsBefore = ctx.storage.listAllEvents().length;

    const first = ctx.engine.claimTask({
      taskId: task.task_id,
      agentId,
      workspaceSessionId: `ws-${agentId}`,
      requiredResources: [],
      idempotencyKey,
    });
    record({
      action: "claimTask (first delivery)",
      actorAgentId: agentId,
      taskId: task.task_id,
      outcome: "ok",
      detail: `replayed=${first.replayed}`,
    });

    const eventsAfterFirst = ctx.storage.listAllEvents().length;

    // Simulate a burst of unrelated network noise between the two
    // deliveries so "replayed later" is exercised, not just "replayed
    // immediately next call" — deterministic count driven by the PRNG.
    const noiseCount = Math.floor(ctx.rng() * 3);
    for (let i = 0; i < noiseCount; i += 1) {
      record({
        action: "network noise (no-op)",
        outcome: "info",
        detail: `simulated delay tick ${i + 1}/${noiseCount}`,
      });
    }

    const second = ctx.engine.claimTask({
      taskId: task.task_id,
      agentId,
      workspaceSessionId: `ws-${agentId}`,
      requiredResources: [],
      idempotencyKey,
    });
    record({
      action: "claimTask (replayed delivery)",
      actorAgentId: agentId,
      taskId: task.task_id,
      outcome: "ok",
      detail: `replayed=${second.replayed}, sameAttemptAsFirst=${second.attempt.attempt_id === first.attempt.attempt_id}`,
    });

    const eventsAfterSecond = ctx.storage.listAllEvents().length;
    const activeAttempts = ctx.storage.getActiveAttemptsForTask(task.task_id);

    const pass =
      eventsBefore === 0 &&
      eventsAfterFirst === 1 &&
      second.replayed === true &&
      second.attempt.attempt_id === first.attempt.attempt_id &&
      eventsAfterSecond === eventsAfterFirst &&
      activeAttempts.length === 1;

    return {
      name: "duplicate-claim-idempotency",
      title: "Duplicate/replayed claimTask commands",
      status: pass ? "pass" : "fail",
      reason: pass
        ? "Replayed claimTask returned the same attempt without appending a duplicate event or creating a second active attempt."
        : `first.replayed=${first.replayed}, second.replayed=${second.replayed}, sameAttempt=${second.attempt.attempt_id === first.attempt.attempt_id}, events(first=${eventsAfterFirst}, second=${eventsAfterSecond}), activeAttempts=${activeAttempts.length}.`,
      timeline: entries,
    };
  },
};

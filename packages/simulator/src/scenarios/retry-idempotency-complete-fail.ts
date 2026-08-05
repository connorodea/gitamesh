import { chance } from "../prng.js";
import { buildSimTask, syntheticAgentIds } from "../fixtures.js";
import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 11: retry safety / idempotency under duplicate delivery.
 *
 * Distinct from scenario 3 (`duplicate-claim-idempotency`, which covers
 * `claimTask`'s explicit `idempotencyKey` path): `completeAttempt` and
 * `failAttempt` are idempotent WITHOUT requiring a caller-supplied key —
 * `packages/core/src/engine.ts` keys their idempotent-result cache on
 * the attempt id itself (`completeAttempt:${attempt.attempt_id}` /
 * `failAttempt:${attempt.attempt_id}`), because an attempt can only be
 * completed or failed once, ever. This scenario simulates an
 * at-least-once delivery layer redelivering whichever terminal call
 * "succeeded but the ack was lost" — a PRNG coin flip per run decides
 * whether the attempt's outcome is a success or a failure, and the
 * terminal call is then replayed.
 *
 * Invariant asserted (mirrors invariant #10 in
 * `packages/core/test/engine.invariants.test.ts`, generalized to also
 * cover `failAttempt`): the replayed call returns `replayed: true` with
 * a result identical to the first call, and the event log does not grow.
 */
export const retryIdempotencyCompleteFailScenario: Scenario = {
  name: "retry-idempotency-complete-fail",
  title: "Retry safety for completeAttempt/failAttempt",
  description:
    "A redelivered completeAttempt or failAttempt call (no ack received the first time) must not double-mutate or duplicate events.",
  run(ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    const repositoryId = "repo_retry_idempotency";
    const agentId = syntheticAgentIds(ctx.agentCount)[0]!;
    const outcomeIsSuccess = chance(ctx.rng, 0.5);

    const task = buildSimTask({
      taskId: "task_retry_idem_1",
      repositoryId,
      workflowId: "wf_retry_idem",
      title: "Terminal-op redelivery target",
    });
    ctx.storage.saveTask(task);

    const claim = ctx.engine.claimTask({
      taskId: task.task_id,
      agentId,
      workspaceSessionId: `ws-${agentId}`,
      requiredResources: [],
    });
    record({
      action: "claimTask",
      actorAgentId: agentId,
      taskId: task.task_id,
      outcome: "ok",
      detail: `fencing_token=${claim.fencingToken}`,
    });

    const eventsBeforeTerminal = ctx.storage.listAllEvents().length;

    const call = () =>
      outcomeIsSuccess
        ? ctx.engine.completeAttempt({
            attemptId: claim.attempt.attempt_id,
            fencingToken: claim.fencingToken,
            result: { ok: true },
          })
        : ctx.engine.failAttempt({
            attemptId: claim.attempt.attempt_id,
            fencingToken: claim.fencingToken,
            error: "simulated terminal failure",
          });

    const first = call();
    record({
      action: outcomeIsSuccess ? "completeAttempt (first delivery)" : "failAttempt (first delivery)",
      actorAgentId: agentId,
      taskId: task.task_id,
      outcome: "ok",
      detail: `replayed=${first.replayed}, task.status=${first.task.status}`,
    });
    const eventsAfterFirst = ctx.storage.listAllEvents().length;

    const second = call();
    record({
      action: outcomeIsSuccess ? "completeAttempt (redelivered)" : "failAttempt (redelivered)",
      actorAgentId: agentId,
      taskId: task.task_id,
      outcome: "ok",
      detail: `replayed=${second.replayed}, task.status=${second.task.status}`,
    });
    const eventsAfterSecond = ctx.storage.listAllEvents().length;

    const pass =
      eventsAfterFirst === eventsBeforeTerminal + 1 &&
      first.replayed === false &&
      second.replayed === true &&
      second.task.status === first.task.status &&
      second.attempt.status === first.attempt.status &&
      eventsAfterSecond === eventsAfterFirst;

    return {
      name: "retry-idempotency-complete-fail",
      title: "Retry safety for completeAttempt/failAttempt",
      status: pass ? "pass" : "fail",
      reason: pass
        ? `Redelivered ${outcomeIsSuccess ? "completeAttempt" : "failAttempt"} was correctly recognized as a replay: identical result, no duplicate event appended.`
        : `first.replayed=${first.replayed}, second.replayed=${second.replayed}, events(before=${eventsBeforeTerminal}, afterFirst=${eventsAfterFirst}, afterSecond=${eventsAfterSecond}).`,
      timeline: entries,
    };
  },
};

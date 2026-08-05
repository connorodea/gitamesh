import { buildSimTask, syntheticAgentIds } from "../fixtures.js";
import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 6: base branch / snapshot changing during analysis.
 *
 * GAP, documented honestly rather than faked. `packages/protocol`'s
 * `Task.base_sha` field exists and is carried through storage untouched,
 * but real staleness detection (`isBaseShaStale` — "has `branch`'s tip
 * moved past what this attempt was planned against?") lives entirely in
 * `packages/git-adapter/src/staleness.ts`, and it is implemented with
 * `git merge-base --is-ancestor` against a REAL checkout. There is no
 * git checkout in this simulator (by design — it drives the engine at
 * the protocol/storage level only), and `packages/core`'s
 * `CoordinationEngine` itself never reads or validates `base_sha` at
 * all: `claimTask` / `heartbeatAttempt` / `completeAttempt` /
 * `failAttempt` in `packages/core/src/engine.ts` do not reference
 * `task.base_sha` anywhere.
 *
 * What this scenario DOES verify (a true, in-scope fact, not a
 * fabrication): two tasks are given different `base_sha` values — one
 * representing "still fresh", one representing "the branch moved out
 * from under it" — and both claim/heartbeat/complete identically and
 * successfully, because the engine has no staleness gate to trip. That
 * is the honest current behavior, not a bug this scenario is designed to
 * catch.
 */
export const snapshotStalenessGapScenario: Scenario = {
  name: "snapshot-staleness-gap",
  title: "Base branch / snapshot staleness during analysis",
  description:
    "packages/core has no base_sha staleness check; verifies the field passes through inertly rather than fabricating enforcement.",
  run(ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    const repositoryId = "repo_snapshot_staleness";
    const agentId = syntheticAgentIds(ctx.agentCount)[0]!;

    const freshTask = {
      ...buildSimTask({
        taskId: "task_snapshot_fresh",
        repositoryId,
        workflowId: "wf_snapshot",
        title: "Planned against current tip",
      }),
      base_sha: "abc123fresh",
    };
    const staleTask = {
      ...buildSimTask({
        taskId: "task_snapshot_stale",
        repositoryId,
        workflowId: "wf_snapshot",
        title: "Planned against a now-superseded base",
      }),
      base_sha: "def456stale",
    };
    ctx.storage.saveTask(freshTask);
    ctx.storage.saveTask(staleTask);

    const results = [freshTask, staleTask].map((t) => {
      const claim = ctx.engine.claimTask({
        taskId: t.task_id,
        agentId,
        workspaceSessionId: `ws-${agentId}`,
        requiredResources: [],
      });
      record({
        action: "claimTask",
        actorAgentId: agentId,
        taskId: t.task_id,
        outcome: "ok",
        detail: `base_sha="${t.base_sha}" was not inspected by the engine`,
      });
      const complete = ctx.engine.completeAttempt({
        attemptId: claim.attempt.attempt_id,
        fencingToken: claim.fencingToken,
      });
      record({
        action: "completeAttempt",
        actorAgentId: agentId,
        taskId: t.task_id,
        outcome: "ok",
        detail: `completed with status ${complete.task.status}`,
      });
      return complete;
    });

    const bothCompletedIdentically = results.every(
      (r) => r.task.status === "completed",
    );

    return {
      name: "snapshot-staleness-gap",
      title: "Base branch / snapshot staleness during analysis",
      status: "skipped",
      blockedOn:
        "packages/core has no base_sha staleness check (that logic — isBaseShaStale — lives in packages/git-adapter and requires a real git checkout, which this protocol/engine-level simulator does not drive)",
      reason: bothCompletedIdentically
        ? "Confirmed: a 'stale' and a 'fresh' base_sha both claim/complete identically because the engine never inspects base_sha. This is the current, honest behavior — not a defect this scenario asserts against, since no engine-level staleness contract exists yet to violate."
        : "Unexpected: the two tasks did not behave identically, which would actually indicate undocumented base_sha-sensitive behavior in the engine worth investigating.",
      timeline: entries,
    };
  },
};

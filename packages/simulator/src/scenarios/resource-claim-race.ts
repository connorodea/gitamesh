import { GitameshError } from "@gitamesh/protocol";
import { shuffle } from "../prng.js";
import { buildSimTask, syntheticAgentIds } from "../fixtures.js";
import { describeError } from "./error-detail.js";
import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 2: overlapping resource-claim races.
 *
 * Several distinct, independently-claimable tasks each require a
 * `path`-mode-`write` resource. Some of those resource keys overlap
 * hierarchically (e.g. `src/pkg` and `src/pkg/file.ts`) with each other;
 * some are fully disjoint (`docs/readme.md`). Agents attempt to claim
 * every task in a PRNG-shuffled order, in one pass, so two tasks whose
 * resource keys overlap are contending in the same tick.
 *
 * Invariant asserted (mirrors `packages/core/src/resource-keys.ts`'s
 * `claimsConflict`): of any group of tasks whose resource keys overlap
 * and are not both `read`, at most one task's claim succeeds; tasks with
 * fully disjoint resource keys all succeed independently, regardless of
 * PRNG order.
 */
export const resourceClaimRaceScenario: Scenario = {
  name: "resource-claim-race",
  title: "Overlapping resource-claim races",
  description:
    "Tasks with overlapping resource keys contend for the same path; only non-conflicting claims succeed.",
  run(ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    const repositoryId = "repo_resource_race";

    // Group A: three tasks whose resource keys hierarchically overlap
    // (only one may hold a write claim at a time).
    const groupA = [
      { taskId: "task_res_a1", key: "src/pkg" },
      { taskId: "task_res_a2", key: "src/pkg/file.ts" },
      { taskId: "task_res_a3", key: "src/pkg/file.ts/nested" },
    ];
    // Group B: fully disjoint keys — every one of these must succeed.
    const groupB = [
      { taskId: "task_res_b1", key: "docs/readme.md" },
      { taskId: "task_res_b2", key: "infra/terraform" },
      { taskId: "task_res_b3", key: "packages/other-pkg" },
    ];

    const allTasks = [...groupA, ...groupB];
    for (const t of allTasks) {
      ctx.storage.saveTask(
        buildSimTask({
          taskId: t.taskId,
          repositoryId,
          workflowId: "wf_resource_race",
          title: `Claim ${t.key}`,
        }),
      );
    }

    const agentIds = syntheticAgentIds(ctx.agentCount);
    const order = shuffle(ctx.rng, allTasks);

    const succeeded = new Set<string>();
    const rejected = new Set<string>();
    let unexpectedErrors = 0;

    order.forEach((t, i) => {
      const agentId = agentIds[i % agentIds.length]!;
      try {
        ctx.engine.claimTask({
          taskId: t.taskId,
          agentId,
          workspaceSessionId: `ws-${agentId}`,
          requiredResources: [
            { resourceType: "path", resourceKey: t.key, mode: "write" },
          ],
        });
        succeeded.add(t.taskId);
        record({
          action: "claimTask",
          actorAgentId: agentId,
          taskId: t.taskId,
          outcome: "ok",
          detail: `acquired write on "${t.key}"`,
        });
      } catch (error) {
        if (error instanceof GitameshError && error.status === 409) {
          rejected.add(t.taskId);
          record({
            action: "claimTask",
            actorAgentId: agentId,
            taskId: t.taskId,
            outcome: "error",
            errorType: error.type.split("/").pop(),
            detail: `correctly rejected: "${t.key}" conflicts with an active claim`,
          });
        } else {
          unexpectedErrors += 1;
          record({
            action: "claimTask",
            actorAgentId: agentId,
            taskId: t.taskId,
            outcome: "error",
            detail: `unexpected error: ${describeError(error)}`,
          });
        }
      }
    });

    const groupASucceeded = groupA.filter((t) => succeeded.has(t.taskId));
    const groupBSucceeded = groupB.filter((t) => succeeded.has(t.taskId));
    const groupBRejected = groupB.filter((t) => rejected.has(t.taskId));

    const pass =
      unexpectedErrors === 0 &&
      groupASucceeded.length === 1 &&
      groupBSucceeded.length === groupB.length &&
      groupBRejected.length === 0;

    return {
      name: "resource-claim-race",
      title: "Overlapping resource-claim races",
      status: pass ? "pass" : "fail",
      reason: pass
        ? `Overlapping group: exactly 1/${groupA.length} claims succeeded. Disjoint group: all ${groupB.length} succeeded independently.`
        : `Overlapping group succeeded=${groupASucceeded.length} (want 1); disjoint group succeeded=${groupBSucceeded.length}/${groupB.length}, unexpectedErrors=${unexpectedErrors}.`,
      timeline: entries,
    };
  },
};

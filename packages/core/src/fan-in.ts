import type { Task, TaskState } from "@gitamesh/protocol";
import type { StorageAdapter } from "./storage-adapter.js";
import { canTransitionTask } from "./state-machines.js";

/**
 * Fan-in / join-policy evaluator.
 *
 * `Task.join_policy` and `Task.dependencies` are real, validated schema
 * fields (`packages/protocol/src/entities.ts`) that, until this module,
 * nothing in `packages/core` ever read. This is the reducer behind them:
 * whenever a task reaches a terminal-for-fan-in-purposes status
 * (`completed`, or `failed` once its retries are exhausted), every OTHER
 * task that lists it in `dependencies` is re-evaluated against its own
 * `join_policy`.
 *
 * Policy semantics implemented here:
 *
 *  - `"all"`: the depending task unblocks (-> `queued`) only once EVERY
 *    task in `dependencies` has status `completed`.
 *  - `"any"`: the depending task unblocks (-> `queued`) as soon as ONE
 *    task in `dependencies` has status `completed`.
 *  - `"quorum"`: **not implemented, by design, not by oversight.**
 *    `TaskSchema` (`packages/protocol/src/entities.ts`) has no threshold,
 *    quorum-size, or minimum-count field anywhere — there is nothing to
 *    evaluate a quorum against. Inventing a default (e.g. "51%" or "at
 *    least 2") would be fabricating semantics the schema does not
 *    specify. `"quorum"`-policy tasks are therefore left exactly as they
 *    are: this evaluator never transitions them. This is a documented
 *    gap, matching the honest-gap spirit of
 *    `packages/simulator/src/scenarios/fan-in-join-policy-gap.ts`'s
 *    original doc comment — until a companion threshold field is added
 *    to the schema, quorum fan-in cannot be implemented without guessing.
 *
 * Permanently-failed-dependency handling: a dependency that reaches
 * `cancelled` or `dead_letter`, or reaches `failed` with its retries
 * exhausted (i.e. `packages/core/src/engine.ts`'s `failAttempt` escalated
 * the TASK itself to `failed`, not just the attempt), can never become
 * `completed` again without a human manually reviving it. For `"all"`,
 * that means the policy can never be satisfied; for `"any"`, it only
 * matters if EVERY dependency has reached such a state (otherwise another
 * dependency can still complete and satisfy `"any"`). In both of those
 * cases the depending task is escalated to `dead_letter` — the "operator
 * escape hatch" state `packages/core/src/state-machines.ts` already
 * documents for exactly this situation — rather than left to wait forever
 * on a dependency that will never complete. `dead_letter` is reachable
 * from every non-terminal task status per `TASK_TRANSITIONS`, so this is
 * always a legal transition once the guard conditions below hold.
 *
 * Scope guard: only depending tasks currently in `"pending"` or
 * `"blocked"` are considered. Those are the only two statuses that (a)
 * plausibly mean "still waiting on its dependencies" and (b) have a
 * state-machine-legal transition straight to `"queued"`
 * (`pending -> queued`, `blocked -> queued`) or `"dead_letter"`. A
 * depending task that has already been claimed/is running/etc. is left
 * alone even if its dependency situation changes underneath it — once
 * claimed, its lifecycle is driven by attempt outcomes, not fan-in.
 *
 * This function performs real storage writes (via `storage.saveTask`)
 * inside whatever transaction the caller (`CoordinationEngine`) already
 * has open — it does not open its own transaction.
 */

const NEVER_COMPLETES_STATES: ReadonlySet<TaskState> = new Set([
  "failed",
  "cancelled",
  "dead_letter",
]);

export function evaluateFanIn(
  storage: StorageAdapter,
  triggerTaskId: string,
  nowIso: string,
): Task[] {
  const trigger = storage.getTask(triggerTaskId);
  if (!trigger) return [];

  const dependents = storage
    .listTasks({ repositoryId: trigger.repository_id })
    .filter(
      (t) =>
        t.dependencies.includes(triggerTaskId) &&
        (t.status === "pending" || t.status === "blocked"),
    );

  const changed: Task[] = [];

  for (const dependent of dependents) {
    if (dependent.join_policy === "quorum") {
      // Documented no-op — see module doc comment.
      continue;
    }

    const depStatuses = dependent.dependencies.map(
      (depId) => storage.getTask(depId)?.status,
    );

    const allCompleted =
      depStatuses.length > 0 && depStatuses.every((s) => s === "completed");
    const anyCompleted = depStatuses.some((s) => s === "completed");
    const allNeverComplete =
      depStatuses.length > 0 &&
      depStatuses.every(
        (s) => s !== undefined && NEVER_COMPLETES_STATES.has(s),
      );
    const anyNeverComplete = depStatuses.some(
      (s) => s !== undefined && NEVER_COMPLETES_STATES.has(s),
    );

    let target: TaskState | undefined;
    if (dependent.join_policy === "all") {
      if (allCompleted) {
        target = "queued";
      } else if (anyNeverComplete) {
        target = "dead_letter";
      }
    } else if (dependent.join_policy === "any") {
      if (anyCompleted) {
        target = "queued";
      } else if (allNeverComplete) {
        target = "dead_letter";
      }
    }

    if (target && canTransitionTask(dependent.status, target)) {
      const updated: Task = {
        ...dependent,
        status: target,
        updated_at: nowIso,
      };
      storage.saveTask(updated);
      changed.push(updated);
    }
  }

  return changed;
}

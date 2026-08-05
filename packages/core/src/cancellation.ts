import type { Task, TaskState } from "@gitamesh/protocol";
import type { StorageAdapter } from "./storage-adapter.js";
import { canTransitionTask } from "./state-machines.js";

/**
 * Cancellation cascade to children.
 *
 * `Task.parent_task_id` is a real, validated schema field
 * (`packages/protocol/src/entities.ts`) that, until this module, nothing
 * in `packages/core` ever read (dependents via `Task.dependencies` are
 * handled by the separate, existing `evaluateFanIn` reducer in
 * `packages/core/src/fan-in.ts` — `parent_task_id` and `dependencies` are
 * two distinct relations and this module only concerns itself with the
 * former).
 *
 * Judgment call, documented rather than silently decided: when a parent
 * task is cancelled, should EVERY child auto-cancel, or only children
 * still in a "not yet actively worked" status? This module takes the
 * same position `evaluateFanIn` already takes for dependents (see that
 * module's doc comment): only children currently `"pending"` or
 * `"blocked"` are cascaded. Those are the only two statuses that (a)
 * plausibly mean "this child's lifecycle is still entirely
 * parent-driven — no agent has started acting on it" and (b) have a
 * state-machine-legal transition straight to `"cancelled"`
 * (`pending -> cancelled`, `blocked -> cancelled` per `TASK_TRANSITIONS`
 * in `packages/core/src/state-machines.ts`). A child that has already
 * been claimed (`claiming`/`running`/`awaiting_approval`/etc.) is left
 * alone even though cancellation is state-machine-legal from most of
 * those statuses too — once claimed, an agent may already be doing real
 * work against it, and unilaterally yanking it out from under that
 * attempt is a bigger behavioral change than this milestone should make
 * silently. (`cancelTask` in `packages/core/src/engine.ts` still lets a
 * human/operator directly cancel an in-flight child themselves via its
 * own `cancelTask` call — this scope guard only concerns the *automatic*
 * cascade.) This mirrors `evaluateFanIn`'s own scope guard exactly, for
 * consistency between the two cascade mechanisms.
 *
 * Nesting: this module cascades to arbitrary depth (children of children
 * of children, ...), not just one level. A cancelled child that was
 * itself `pending`/`blocked` re-enters the same walk as a new parent, so
 * its own eligible children are cancelled too, and so on. A `visited`
 * guard prevents infinite loops if a malformed data set ever contained a
 * `parent_task_id` cycle (which should never happen through normal
 * task-creation paths, but the walk must not hang if it does).
 *
 * This function performs real storage writes (via `storage.saveTask`)
 * inside whatever transaction the caller (`CoordinationEngine.cancelTask`)
 * already has open — it does not open its own transaction, exactly like
 * `evaluateFanIn`.
 */

const CASCADABLE_CHILD_STATUSES: ReadonlySet<TaskState> = new Set([
  "pending",
  "blocked",
]);

export function cascadeCancelChildren(
  storage: StorageAdapter,
  rootTaskId: string,
  repositoryId: string,
  nowIso: string,
): Task[] {
  const cancelled: Task[] = [];
  const visited = new Set<string>([rootTaskId]);
  const queue: string[] = [rootTaskId];

  while (queue.length > 0) {
    const currentParentId = queue.shift()!;

    const children = storage
      .listTasks({ repositoryId })
      .filter((t) => t.parent_task_id === currentParentId);

    for (const child of children) {
      if (visited.has(child.task_id)) continue; // cycle guard
      visited.add(child.task_id);

      if (!CASCADABLE_CHILD_STATUSES.has(child.status)) {
        // Once claimed, this child's lifecycle is driven by attempt
        // outcomes, not by its parent's fate — see module doc comment.
        continue;
      }
      if (!canTransitionTask(child.status, "cancelled")) continue;

      const updated: Task = {
        ...child,
        status: "cancelled",
        updated_at: nowIso,
      };
      storage.saveTask(updated);
      cancelled.push(updated);

      // Recurse: this child just became cancelled, so ITS eligible
      // children cascade too.
      queue.push(child.task_id);
    }
  }

  return cancelled;
}

import type { Task } from "@gitamesh/protocol";
import { invalidDependencies } from "@gitamesh/protocol";
import type { StorageAdapter } from "./storage-adapter.js";

export interface DependencyState {
  /** True when the task's `join_policy` is satisfied (always true with no dependencies). */
  ready: boolean;
  /** Dependencies that are not `completed` yet. Empty when `ready` under "all". */
  waitingOn: Array<{ task_id: string; status: string }>;
}

/**
 * Evaluates a task's `dependencies` against its `join_policy`.
 *
 *  - `"all"`: every dependency is `completed`.
 *  - `"any"`: at least one dependency is `completed`.
 *  - `"quorum"`: treated as `"all"`. The schema has no threshold field
 *    (see `fan-in.ts`), so the only reading that can never release a task
 *    too early is the strictest one.
 *
 * A dependency id with no stored task counts as not complete, with status
 * `"missing"`.
 */
export function dependencyState(storage: StorageAdapter, task: Task): DependencyState {
  if (task.dependencies.length === 0) return { ready: true, waitingOn: [] };

  const waitingOn: DependencyState["waitingOn"] = [];
  for (const depId of task.dependencies) {
    const status = storage.getTask(depId)?.status ?? "missing";
    if (status !== "completed") waitingOn.push({ task_id: depId, status });
  }

  const ready =
    task.join_policy === "any"
      ? waitingOn.length < task.dependencies.length
      : waitingOn.length === 0;
  return { ready, waitingOn };
}

/**
 * Rejects a dependency list that names a missing task, a task in another
 * repository, the task itself, or that would close a dependency cycle.
 * `taskId` is undefined when the task is still being created (a new task
 * cannot be part of a cycle: nothing depends on it yet).
 */
export function assertValidDependencies(
  storage: StorageAdapter,
  params: { taskId?: string; repositoryId: string; dependencies: string[] },
): void {
  const { taskId, repositoryId, dependencies } = params;

  for (const depId of dependencies) {
    if (depId === taskId) {
      throw invalidDependencies({ taskId, reason: `Task ${depId} cannot depend on itself.` });
    }
    const dep = storage.getTask(depId);
    if (!dep) {
      throw invalidDependencies({ taskId, reason: `Dependency ${depId} does not exist.` });
    }
    if (dep.repository_id !== repositoryId) {
      throw invalidDependencies({
        taskId,
        reason: `Dependency ${depId} belongs to repository ${dep.repository_id}, not ${repositoryId}.`,
      });
    }
  }

  if (taskId === undefined) return;

  // Depth-first walk from each new dependency; reaching `taskId` is a cycle.
  const seen = new Set<string>();
  const stack = [...dependencies];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const next = storage.getTask(current)?.dependencies ?? [];
    if (next.includes(taskId)) {
      throw invalidDependencies({
        taskId,
        reason: `Depending on ${dependencies.join(", ")} would create a cycle: ${current} already depends on ${taskId}.`,
      });
    }
    stack.push(...next);
  }
}

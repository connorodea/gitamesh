import { GitameshError, type Task, type TaskAttempt } from "@gitamesh/protocol";
import type { StorageAdapter } from "./storage-adapter.js";

export function coordinationConflict(detail: string): never {
  throw new GitameshError({
    type: "https://gitamesh.dev/problems/coordination-conflict",
    title: "Coordination conflict", status: 409, detail,
  });
}

/** Used inside the claim transaction, before allocating an attempt or resource. */
export function assertDependenciesReady(storage: StorageAdapter, task: Task): void {
  if (!task.dependencies.length) return;
  const dependencies = task.dependencies.map((id) => storage.getTask(id));
  if (dependencies.some((dependency) => !dependency || dependency.repository_id !== task.repository_id)) {
    coordinationConflict("A dependency is missing or belongs to another repository.");
  }
  const complete = dependencies.map((dependency) => dependency!.status === "completed");
  const ready = task.join_policy === "all" ? complete.every(Boolean)
    : task.join_policy === "any" ? complete.some(Boolean) : false;
  if (!ready) coordinationConflict("Task dependencies are not satisfied; quorum requires an explicit supported policy.");
}

/** Updates only unclaimed tasks. The caller supplies the exact previous dependency set. */
export function setTaskDependencies(
  storage: StorageAdapter, taskId: string, dependencies: string[], expectedDependencies: string[],
): Task {
  const task = storage.getTask(taskId);
  if (!task) coordinationConflict("Task does not exist.");
  if (!["pending", "queued"].includes(task.status) || storage.getActiveAttemptsForTask(taskId).length) {
    coordinationConflict("Dependencies can only change before a task is claimed.");
  }
  const sorted = (ids: string[]) => [...new Set(ids)].sort();
  if (JSON.stringify(sorted(task.dependencies)) !== JSON.stringify(sorted(expectedDependencies))) {
    coordinationConflict("Dependencies changed since they were read; read the task and retry.");
  }
  const next = sorted(dependencies);
  const visited = new Set<string>();
  const visiting = new Set<string>([taskId]);
  function visit(id: string): void {
    if (visiting.has(id)) coordinationConflict("Dependencies would contain a cycle.");
    if (visited.has(id)) return;
    const dependency = storage.getTask(id);
    if (!dependency || dependency.repository_id !== task!.repository_id) {
      coordinationConflict("Every dependency must exist in the same repository.");
    }
    visiting.add(id);
    dependency.dependencies.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  next.forEach(visit);
  const updated = { ...task, dependencies: next, updated_at: storage.now() };
  storage.saveTask(updated);
  return updated;
}

/** A progress report is accepted only from the task's current unexpired attempt. */
export function currentProgressAttempt(
  storage: StorageAdapter, taskId: string, attemptId: string, fencingToken: number,
): TaskAttempt {
  const task = storage.getTask(taskId);
  const attempt = storage.getAttempt(attemptId);
  const lease = storage.getLeaseByAttempt(attemptId);
  if (!task || !attempt || attempt.task_id !== taskId ||
      !["leased", "running"].includes(attempt.status) ||
      !["running", "blocked", "awaiting_approval"].includes(task.status) ||
      attempt.fencing_token !== fencingToken || !lease || lease.status !== "active" ||
      lease.fencing_token !== fencingToken || lease.owner_agent_id !== attempt.agent_id ||
      Date.parse(lease.expires_at) <= Date.parse(storage.now()) ||
      Date.parse(attempt.expires_at) <= Date.parse(storage.now())) {
    coordinationConflict("Progress requires this task's current attempt and unexpired fencing token.");
  }
  return attempt;
}

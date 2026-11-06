import {
  GitameshError,
  taskNotFound,
  type Task,
  type TaskState,
} from "@gitamesh/protocol";
import type { StorageAdapter } from "./storage-adapter.js";

/**
 * Async multi-agent orchestration (ADR-0002).
 *
 * An orchestrator holds a parent task, dispatches N child tasks under it
 * (`parent_task_id`), returns at once, and later collects the children's
 * results. Workers claim and complete children with the ordinary
 * claim/heartbeat/complete/fail calls. This module adds only the pieces the
 * existing primitives lacked: creating N children atomically, reading their
 * results back as one fan-in summary, and the condition a waiting
 * orchestrator wakes on. Cancelling children reuses `CoordinationEngine.cancelTask`.
 */

/**
 * Child statuses that will not change again without an operator. `failed`
 * counts because the engine only leaves a task `failed` once its retries are
 * exhausted; a retryable failure goes back to `queued`.
 */
export const SETTLED_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "dead_letter",
]);

/** Parent statuses that can no longer take new children. */
const FINISHED_PARENT_STATES: ReadonlySet<TaskState> = new Set(["completed", "cancelled", "dead_letter"]);

export const MAX_SUBTASKS_PER_DISPATCH = 100;

export interface SubtaskSpec {
  title: string;
  description?: string;
  priority?: number;
  required_capabilities?: string[];
  branch?: string | null;
  base_sha?: string | null;
}

export interface DispatchSubtasksParams {
  parentTaskId: string;
  subtasks: SubtaskSpec[];
  /** Defaults to the parent's workflow. */
  workflowId?: string;
  /** Shared deadline for every child; reported as `overdue` once passed. */
  deadlineAt?: string | null;
  /** Recorded on the dispatch event; route-level replay uses the daemon's idempotency table. */
  idempotencyKey?: string | null;
}

export interface DispatchSubtasksResult {
  parent: Task;
  subtasks: Task[];
}

export function invalidDispatch(params: { taskId: string; reason: string }): GitameshError {
  return new GitameshError({
    type: "https://gitamesh.dev/problems/invalid-dispatch",
    title: "Subtasks cannot be dispatched",
    status: 409,
    detail: params.reason,
    extensions: { task_id: params.taskId },
  });
}

/**
 * Creates every child in `params.subtasks` under the parent. Performs
 * storage writes inside the caller's transaction and opens none of its own,
 * so either every child exists afterwards or none does.
 */
export function dispatchSubtasks(storage: StorageAdapter, params: DispatchSubtasksParams): DispatchSubtasksResult {
  const parent = storage.getTask(params.parentTaskId);
  if (!parent) throw taskNotFound(params.parentTaskId);
  if (FINISHED_PARENT_STATES.has(parent.status)) {
    throw invalidDispatch({
      taskId: parent.task_id,
      reason: `Parent task ${parent.task_id} is "${parent.status}"; finished tasks cannot take new subtasks.`,
    });
  }
  if (params.subtasks.length === 0) {
    throw invalidDispatch({ taskId: parent.task_id, reason: "Dispatch needs at least one subtask." });
  }
  if (params.subtasks.length > MAX_SUBTASKS_PER_DISPATCH) {
    throw invalidDispatch({
      taskId: parent.task_id,
      reason: `Dispatch takes at most ${MAX_SUBTASKS_PER_DISPATCH} subtasks, got ${params.subtasks.length}.`,
    });
  }

  const now = storage.now();
  const workflowId = params.workflowId ?? parent.workflow_id;
  const subtasks: Task[] = params.subtasks.map((spec) => {
    const child: Task = {
      task_id: storage.generateId("task"),
      workflow_id: workflowId,
      repository_id: parent.repository_id,
      parent_task_id: parent.task_id,
      title: spec.title,
      description: spec.description ?? "",
      status: "pending",
      priority: spec.priority ?? parent.priority,
      required_capabilities: spec.required_capabilities ?? [],
      dependencies: [],
      join_policy: "all",
      base_sha: spec.base_sha ?? null,
      branch: spec.branch ?? null,
      idempotency_key: null,
      deadline_at: params.deadlineAt ?? null,
      created_at: now,
      updated_at: now,
    };
    storage.saveTask(child);
    storage.appendEvent({
      schema_version: 1,
      event_type: "task.created",
      occurred_at: now,
      namespace_id: child.repository_id,
      repository_id: child.repository_id,
      workflow_id: child.workflow_id,
      task_id: child.task_id,
      attempt_id: null,
      agent_id: null,
      workspace_session_id: null,
      correlation_id: parent.task_id,
      causation_id: null,
      idempotency_key: null,
      payload: { title: child.title, parent_task_id: parent.task_id },
      metadata: {},
    });
    return child;
  });

  storage.appendEvent({
    schema_version: 1,
    event_type: "task.subtasks_dispatched",
    occurred_at: now,
    namespace_id: parent.repository_id,
    repository_id: parent.repository_id,
    workflow_id: parent.workflow_id,
    task_id: parent.task_id,
    attempt_id: null,
    agent_id: null,
    workspace_session_id: null,
    correlation_id: parent.task_id,
    causation_id: null,
    idempotency_key: params.idempotencyKey ?? null,
    payload: { subtask_ids: subtasks.map((t) => t.task_id), deadline_at: params.deadlineAt ?? null },
    metadata: {},
  });

  return { parent, subtasks };
}

export interface SubtaskResult {
  task_id: string;
  title: string;
  status: TaskState;
  settled: boolean;
  /** `result` from the latest completed attempt, or null. */
  result: Record<string, unknown> | null;
  /** `error` from the latest failed attempt, or null. Set on a retried child too. */
  error: string | null;
  deadline_at: string | null;
  overdue: boolean;
}

export type FanInOutcome = "empty" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

export interface FanInSummary {
  parent_task_id: string;
  total: number;
  settled: number;
  succeeded: number;
  /** `failed` plus `dead_letter`. */
  failed: number;
  cancelled: number;
  overdue: number;
  all_settled: boolean;
  outcome: FanInOutcome;
  subtasks: SubtaskResult[];
}

function childrenOf(storage: StorageAdapter, parent: Task): Task[] {
  return storage
    .listTasks({ repositoryId: parent.repository_id })
    .filter((t) => t.parent_task_id === parent.task_id);
}

/**
 * The fan-in view of a parent's children: each child's status and result
 * plus counts and an overall outcome. Results come from the
 * `attempt.completed` / `attempt.failed` events the engine already writes,
 * so no new storage is needed. Throws `taskNotFound` for an unknown parent.
 */
export function collectSubtaskResults(storage: StorageAdapter, parentTaskId: string): FanInSummary {
  const parent = storage.getTask(parentTaskId);
  if (!parent) throw taskNotFound(parentTaskId);
  const children = childrenOf(storage, parent);

  const results = new Map<string, Record<string, unknown> | null>();
  const errors = new Map<string, string>();
  if (children.length > 0) {
    const ids = new Set(children.map((c) => c.task_id));
    for (const event of storage.listEventsForRepository(parent.repository_id)) {
      if (!event.task_id || !ids.has(event.task_id)) continue;
      if (event.event_type === "attempt.completed") {
        const result = (event.payload as { result?: unknown }).result;
        results.set(event.task_id, result && typeof result === "object" ? (result as Record<string, unknown>) : null);
      } else if (event.event_type === "attempt.failed") {
        const error = (event.payload as { error?: unknown }).error;
        if (typeof error === "string") errors.set(event.task_id, error);
      }
    }
  }

  const now = Date.parse(storage.now());
  const subtasks: SubtaskResult[] = children.map((child) => {
    const settled = SETTLED_TASK_STATES.has(child.status);
    return {
      task_id: child.task_id,
      title: child.title,
      status: child.status,
      settled,
      result: child.status === "completed" ? (results.get(child.task_id) ?? null) : null,
      error: errors.get(child.task_id) ?? null,
      deadline_at: child.deadline_at,
      overdue: !settled && child.deadline_at !== null && Date.parse(child.deadline_at) <= now,
    };
  });

  const count = (pred: (s: SubtaskResult) => boolean) => subtasks.filter(pred).length;
  const settled = count((s) => s.settled);
  const succeeded = count((s) => s.status === "completed");
  const failed = count((s) => s.status === "failed" || s.status === "dead_letter");
  const cancelled = count((s) => s.status === "cancelled");
  const allSettled = settled === subtasks.length;

  let outcome: FanInOutcome;
  if (subtasks.length === 0) outcome = "empty";
  else if (!allSettled) outcome = "running";
  else if (succeeded === subtasks.length) outcome = "succeeded";
  else if (succeeded > 0) outcome = "partial";
  else if (cancelled === subtasks.length) outcome = "cancelled";
  else outcome = "failed";

  return {
    parent_task_id: parent.task_id,
    total: subtasks.length,
    settled,
    succeeded,
    failed,
    cancelled,
    overdue: count((s) => s.overdue),
    all_settled: allSettled,
    outcome,
    subtasks,
  };
}

export interface WaitPolicy {
  /** "all": wake once every child is settled. "any": wake on the first completed child. */
  until: "all" | "any";
  /** Also wake on the first child that failed for good (`failed`/`dead_letter`). */
  failFast?: boolean;
}

export type WaitWake = "no_subtasks" | "all_settled" | "any_succeeded" | "failure";

/** Why a waiting orchestrator should wake now, or null to keep waiting. */
export function waitOutcome(summary: FanInSummary, policy: WaitPolicy): WaitWake | null {
  if (summary.total === 0) return "no_subtasks";
  if (policy.failFast && summary.failed > 0) return "failure";
  if (policy.until === "any" && summary.succeeded > 0) return "any_succeeded";
  if (summary.all_settled) return "all_settled";
  return null;
}

/** Children that can still change state, including claimed and running ones. */
export function unsettledSubtaskIds(storage: StorageAdapter, parentTaskId: string): string[] {
  const parent = storage.getTask(parentTaskId);
  if (!parent) throw taskNotFound(parentTaskId);
  return childrenOf(storage, parent)
    .filter((t) => !SETTLED_TASK_STATES.has(t.status))
    .map((t) => t.task_id);
}

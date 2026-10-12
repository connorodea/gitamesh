/**
 * Typed error envelope following RFC 9457 ("Problem Details for HTTP APIs")
 * shape. This is the canonical error format returned by `packages/core`
 * operations and (in a later milestone) the daemon's HTTP API.
 *
 * Design note on `idempotencyReplay`: a replayed idempotent request is NOT
 * a failure — the caller already got what they wanted, we're just handing
 * back the same result instead of re-applying the operation. Modeling it as
 * a thrown ProblemDetails would force every caller to wrap idempotent calls
 * in try/catch even on the common "first call" path, and would conflate a
 * real conflict (someone else's claim) with a benign replay of the caller's
 * OWN prior request. Instead, operations that accept an `idempotencyKey`
 * return a discriminated result: `{ replayed: true, result } | { replayed:
 * false, result }`. See `packages/core`'s `IdempotentResult<T>` type.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  extensions?: Record<string, unknown>;
}

export class GitameshError extends Error implements ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly extensions?: Record<string, unknown>;

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = "GitameshError";
    this.type = problem.type;
    this.title = problem.title;
    this.status = problem.status;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.extensions = problem.extensions;
  }

  toProblemDetails(): ProblemDetails {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.detail,
      instance: this.instance,
      extensions: this.extensions,
    };
  }
}

const PROBLEM_BASE = "https://gitamesh.dev/problems";

export function taskAlreadyClaimed(params: {
  taskId: string;
  existingAttemptId?: string;
  detail?: string;
}): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/task-already-claimed`,
    title: "Task already claimed",
    status: 409,
    detail:
      params.detail ??
      `Task ${params.taskId} already has a live attempt and cannot be claimed again.`,
    extensions: {
      task_id: params.taskId,
      existing_attempt_id: params.existingAttemptId,
    },
  });
}

export function resourceConflict(params: {
  resourceKey: string;
  mode: string;
  conflictingResourceKey?: string;
  detail?: string;
}): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/resource-conflict`,
    title: "Resource conflict",
    status: 409,
    detail:
      params.detail ??
      `Resource "${params.resourceKey}" (mode: ${params.mode}) conflicts with an active claim.`,
    extensions: {
      resource_key: params.resourceKey,
      mode: params.mode,
      conflicting_resource_key: params.conflictingResourceKey,
    },
  });
}

export function staleAttemptToken(params: {
  attemptId: string;
  providedToken?: number | null;
  currentToken?: number | null;
  detail?: string;
}): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/stale-attempt-token`,
    title: "Stale fencing token",
    status: 409,
    detail:
      params.detail ??
      `Fencing token for attempt ${params.attemptId} is stale; this worker's lease was superseded.`,
    extensions: {
      attempt_id: params.attemptId,
      provided_token: params.providedToken,
      current_token: params.currentToken,
    },
  });
}

export function invalidStateTransition(params: {
  entity: string;
  entityId: string;
  from: string;
  to: string;
  detail?: string;
}): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/invalid-state-transition`,
    title: "Invalid state transition",
    status: 422,
    detail:
      params.detail ??
      `${params.entity} ${params.entityId} cannot transition from "${params.from}" to "${params.to}".`,
    extensions: {
      entity: params.entity,
      entity_id: params.entityId,
      from: params.from,
      to: params.to,
    },
  });
}

export function invalidResourceKey(params: {
  resourceKey: string;
  reason: string;
}): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/invalid-resource-key`,
    title: "Invalid resource key",
    status: 400,
    detail: `Resource key "${params.resourceKey}" is invalid: ${params.reason}`,
    extensions: {
      resource_key: params.resourceKey,
      reason: params.reason,
    },
  });
}

export function taskNotClaimable(params: {
  taskId: string;
  currentStatus: string;
  detail?: string;
}): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/task-not-claimable`,
    title: "Task not claimable",
    status: 409,
    detail:
      params.detail ??
      `Task ${params.taskId} is in status "${params.currentStatus}" and cannot be claimed.`,
    extensions: {
      task_id: params.taskId,
      current_status: params.currentStatus,
    },
  });
}

export function attemptNotFound(attemptId: string): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/attempt-not-found`,
    title: "Attempt not found",
    status: 404,
    detail: `No attempt exists with id ${attemptId}.`,
    extensions: { attempt_id: attemptId },
  });
}

export function taskNotFound(taskId: string): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/task-not-found`,
    title: "Task not found",
    status: 404,
    detail: `No task exists with id ${taskId}.`,
    extensions: { task_id: taskId },
  });
}

export function taskDependenciesIncomplete(params: {
  taskId: string;
  joinPolicy: string;
  waitingOn: Array<{ task_id: string; status: string }>;
}): GitameshError {
  const list = params.waitingOn
    .map((dep) => `${dep.task_id} (${dep.status})`)
    .join(", ");
  return new GitameshError({
    type: `${PROBLEM_BASE}/task-dependencies-incomplete`,
    title: "Task dependencies not complete",
    status: 409,
    detail: `Task ${params.taskId} cannot be claimed yet: it waits on ${list}.`,
    extensions: {
      task_id: params.taskId,
      join_policy: params.joinPolicy,
      waiting_on: params.waitingOn,
    },
  });
}

export function invalidDependencies(params: {
  taskId?: string;
  reason: string;
}): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/invalid-dependencies`,
    title: "Invalid task dependencies",
    status: 422,
    detail: params.reason,
    extensions: { task_id: params.taskId },
  });
}

export function pathLockConflict(params: {
  path: string;
  conflictingPath: string;
  lockId: string;
  holderAgentId: string;
  holderDisplayName: string;
  expiresAt: string;
}): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/path-lock-conflict`,
    title: "Path already locked",
    status: 409,
    detail: `Path "${params.path}" overlaps "${params.conflictingPath}", locked by ${params.holderDisplayName} (${params.holderAgentId}) until ${params.expiresAt} (lock ${params.lockId}).`,
    extensions: {
      path: params.path,
      conflicting_path: params.conflictingPath,
      lock_id: params.lockId,
      holder_agent_id: params.holderAgentId,
      holder_display_name: params.holderDisplayName,
      expires_at: params.expiresAt,
    },
  });
}

export function invalidPathGlob(params: { path: string; reason: string }): GitameshError {
  return new GitameshError({
    type: `${PROBLEM_BASE}/invalid-path-glob`,
    title: "Invalid lock path",
    status: 400,
    detail: `Lock path "${params.path}" is invalid: ${params.reason}`,
    extensions: { path: params.path, reason: params.reason },
  });
}

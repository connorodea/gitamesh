import { assertDependenciesReady } from "./coordination-updates.js";
import type {
  Task,
  TaskAttempt,
  ResourceClaim,
  Lease,
  ResourceType,
  ResourceMode,
} from "@gitamesh/protocol";
import {
  taskAlreadyClaimed,
  taskNotClaimable,
  taskNotFound,
  attemptNotFound,
  resourceConflict,
  staleAttemptToken,
  invalidStateTransition,
} from "@gitamesh/protocol";
import type { StorageAdapter } from "./storage-adapter.js";
import { canTransitionTask, canTransitionAttempt } from "./state-machines.js";
import { validateResourceKey, claimsConflict } from "./resource-keys.js";
import { evaluateFanIn } from "./fan-in.js";
import { cascadeCancelChildren } from "./cancellation.js";

export { validateResourceKey } from "./resource-keys.js";

export interface RequiredResource {
  resourceType: ResourceType;
  resourceKey: string;
  mode: ResourceMode;
}

export interface ClaimTaskParams {
  taskId: string;
  agentId: string;
  workspaceSessionId: string;
  requiredResources: RequiredResource[];
  idempotencyKey?: string;
}

export interface ClaimTaskResult {
  attempt: TaskAttempt;
  fencingToken: number;
  resourceClaims: ResourceClaim[];
  replayed: boolean;
}

export interface HeartbeatParams {
  attemptId: string;
  fencingToken: number;
  leaseDurationMs?: number;
}

export interface HeartbeatResult {
  attempt: TaskAttempt;
  resourceClaims: ResourceClaim[];
}

export interface CompleteAttemptParams {
  attemptId: string;
  fencingToken: number;
  result?: Record<string, unknown>;
}

export interface CompleteAttemptResult {
  attempt: TaskAttempt;
  task: Task;
  result: Record<string, unknown> | undefined;
  replayed: boolean;
}

export interface FailAttemptParams {
  attemptId: string;
  fencingToken: number;
  error: string;
  /** Maximum attempts before the task is escalated to `failed` instead of requeued. Default 3. */
  maxAttempts?: number;
}

export interface FailAttemptResult {
  attempt: TaskAttempt;
  task: Task;
  replayed: boolean;
}

export interface ExpireStaleLeasesResult {
  expiredAttemptIds: string[];
  requeuedTaskIds: string[];
}

export interface CancelTaskParams {
  taskId: string;
}

export interface CancelTaskResult {
  task: Task;
  /** Every child task (any depth) that cascaded to `cancelled` alongside it. */
  cancelledChildren: Task[];
  /**
   * Dependent tasks (`Task.dependencies` includes this task) whose status
   * changed as a result — normally to `dead_letter` via `evaluateFanIn`,
   * since a cancelled dependency can never become `completed`.
   */
  fanInChanged: Task[];
}

const DEFAULT_LEASE_DURATION_MS = 30_000;

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/**
 * The CoordinationEngine implements the concurrency-control invariants
 * documented in the Gitamesh spec on top of any `StorageAdapter`. It
 * contains no storage-engine-specific code; all atomicity guarantees are
 * delegated to `storage.transaction()`.
 */
export class CoordinationEngine {
  constructor(private readonly storage: StorageAdapter) {}

  // -------------------------------------------------------------------------
  claimTask(params: ClaimTaskParams): ClaimTaskResult {
    return this.storage.transaction(() => {
      if (params.idempotencyKey) {
        const cached = this.storage.lookupIdempotentResult<ClaimTaskResult>(
          `claimTask:${params.idempotencyKey}`,
        );
        if (cached) {
          return { ...cached, replayed: true };
        }
      }

      const task = this.storage.getTask(params.taskId);
      if (!task) {
        throw taskNotFound(params.taskId);
      }

      if (task.status !== "pending" && task.status !== "queued") {
        throw taskNotClaimable({
          taskId: task.task_id,
          currentStatus: task.status,
        });
      }

      assertDependenciesReady(this.storage, task);

      const activeAttempts = this.storage.getActiveAttemptsForTask(
        task.task_id,
      );
      if (activeAttempts.length > 0) {
        throw taskAlreadyClaimed({
          taskId: task.task_id,
          existingAttemptId: activeAttempts[0]?.attempt_id,
        });
      }

      // Canonicalize + validate every required resource key up front. Any
      // invalid key aborts the whole claim before anything is touched.
      const canonicalized = params.requiredResources.map((r) => ({
        ...r,
        resourceKey: validateResourceKey(r.resourceKey),
      }));

      // Check every required resource against active claims in this
      // repository AND against the other resources requested in this same
      // call (so a caller can't sidestep the check by bundling two
      // conflicting requests together). ALL-OR-NOTHING: if any one
      // conflicts, we acquire NONE of them.
      const activeClaims = this.storage.getActiveResourceClaims(
        task.repository_id,
      );

      for (let i = 0; i < canonicalized.length; i += 1) {
        const candidate = canonicalized[i]!;
        for (const existing of activeClaims) {
          if (
            claimsConflict(
              candidate.resourceKey,
              candidate.mode,
              existing.resource_key,
              existing.mode,
            )
          ) {
            throw resourceConflict({
              resourceKey: candidate.resourceKey,
              mode: candidate.mode,
              conflictingResourceKey: existing.resource_key,
            });
          }
        }
        for (let j = 0; j < canonicalized.length; j += 1) {
          if (i === j) continue;
          const other = canonicalized[j]!;
          if (
            claimsConflict(
              candidate.resourceKey,
              candidate.mode,
              other.resourceKey,
              other.mode,
            )
          ) {
            throw resourceConflict({
              resourceKey: candidate.resourceKey,
              mode: candidate.mode,
              conflictingResourceKey: other.resourceKey,
              detail: `Resource "${candidate.resourceKey}" conflicts with another resource requested in the same claim ("${other.resourceKey}").`,
            });
          }
        }
      }

      // All clear — acquire everything.
      const now = this.storage.now();
      const fencingToken = this.storage.nextFencingToken(task.repository_id);
      const attemptNumber =
        this.storage.countAttemptsForTask(task.task_id) + 1;
      const attemptId = this.storage.generateId("attempt");
      const leaseId = this.storage.generateId("lease");
      const expiresAt = addMs(now, DEFAULT_LEASE_DURATION_MS);

      const lease: Lease = {
        lease_id: leaseId,
        owner_agent_id: params.agentId,
        attempt_id: attemptId,
        status: "active",
        fencing_token: fencingToken,
        acquired_at: now,
        renewed_at: now,
        expires_at: expiresAt,
        released_at: null,
      };
      this.storage.saveLease(lease);

      // Attempt walks created -> leased -> running within this single
      // claim call (a later milestone's daemon may expose "leased" as an
      // externally observable step; for this engine, claim = immediate
      // hand-off to a running attempt).
      let attempt: TaskAttempt = {
        attempt_id: attemptId,
        task_id: task.task_id,
        agent_id: params.agentId,
        workspace_session_id: params.workspaceSessionId,
        attempt_number: attemptNumber,
        status: "created",
        lease_id: leaseId,
        fencing_token: fencingToken,
        started_at: now,
        heartbeat_at: now,
        expires_at: expiresAt,
        completed_at: null,
        error: null,
      };
      attempt = this.assertAttemptTransition(attempt, "leased");
      attempt = this.assertAttemptTransition(attempt, "running");
      this.storage.saveAttempt(attempt);

      const resourceClaims: ResourceClaim[] = canonicalized.map((r) => {
        const claim: ResourceClaim = {
          resource_claim_id: this.storage.generateId("claim"),
          repository_id: task.repository_id,
          task_id: task.task_id,
          attempt_id: attemptId,
          resource_type: r.resourceType,
          resource_key: r.resourceKey,
          mode: r.mode,
          lease_id: leaseId,
          fencing_token: fencingToken,
          expires_at: expiresAt,
        };
        this.storage.saveResourceClaim(claim);
        return claim;
      });

      let updatedTask = task;
      if (updatedTask.status === "pending") {
        updatedTask = this.assertTaskTransition(updatedTask, "queued");
      }
      updatedTask = this.assertTaskTransition(updatedTask, "claiming");
      updatedTask = this.assertTaskTransition(updatedTask, "running");
      updatedTask = { ...updatedTask, updated_at: now };
      this.storage.saveTask(updatedTask);

      this.storage.appendEvent({
        schema_version: 1,
        event_type: "task.claimed",
        occurred_at: now,
        namespace_id: this.namespaceOf(task),
        repository_id: task.repository_id,
        workflow_id: task.workflow_id,
        task_id: task.task_id,
        attempt_id: attemptId,
        agent_id: params.agentId,
        workspace_session_id: params.workspaceSessionId,
        correlation_id: null,
        causation_id: null,
        idempotency_key: params.idempotencyKey ?? null,
        payload: { fencing_token: fencingToken },
        metadata: {},
      });

      const result: ClaimTaskResult = {
        attempt,
        fencingToken,
        resourceClaims,
        replayed: false,
      };

      if (params.idempotencyKey) {
        this.storage.recordIdempotentResult(
          `claimTask:${params.idempotencyKey}`,
          result,
        );
      }

      return result;
    });
  }

  // -------------------------------------------------------------------------
  heartbeatAttempt(params: HeartbeatParams): HeartbeatResult {
    return this.storage.transaction(() => {
      const attempt = this.storage.getAttempt(params.attemptId);
      if (!attempt) {
        throw attemptNotFound(params.attemptId);
      }

      this.assertFencingTokenCurrent(attempt, params.fencingToken);

      if (attempt.status !== "leased" && attempt.status !== "running") {
        throw staleAttemptToken({
          attemptId: attempt.attempt_id,
          providedToken: params.fencingToken,
          currentToken: attempt.fencing_token,
          detail: `Attempt ${attempt.attempt_id} is in terminal status "${attempt.status}" and cannot be renewed.`,
        });
      }

      const now = this.storage.now();
      const newExpiresAt = addMs(
        now,
        params.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      );

      const updatedAttempt: TaskAttempt = {
        ...attempt,
        heartbeat_at: now,
        expires_at: newExpiresAt,
      };
      this.storage.saveAttempt(updatedAttempt);

      // Atomic-with-attempt: every resource claim held by this attempt is
      // renewed to the SAME new expiry in the same transaction.
      this.storage.renewResourceClaimsForAttempt(
        attempt.attempt_id,
        newExpiresAt,
      );

      const lease = this.storage.getLeaseByAttempt(attempt.attempt_id);
      if (lease && lease.status === "active") {
        this.storage.saveLease({
          ...lease,
          renewed_at: now,
          expires_at: newExpiresAt,
        });
      }

      const heartbeatTask = this.storage.getTask(attempt.task_id);
      this.storage.appendEvent({
        schema_version: 1,
        event_type: "attempt.heartbeat",
        occurred_at: now,
        namespace_id: heartbeatTask ? this.namespaceOf(heartbeatTask) : "unknown",
        repository_id: heartbeatTask?.repository_id ?? null,
        workflow_id: heartbeatTask?.workflow_id ?? null,
        task_id: attempt.task_id,
        attempt_id: attempt.attempt_id,
        agent_id: attempt.agent_id,
        workspace_session_id: attempt.workspace_session_id,
        correlation_id: null,
        causation_id: null,
        idempotency_key: null,
        payload: { fencing_token: attempt.fencing_token },
        metadata: {},
      });

      const resourceClaims = this.storage.getResourceClaimsForAttempt(
        attempt.attempt_id,
      );

      return { attempt: updatedAttempt, resourceClaims };
    });
  }

  // -------------------------------------------------------------------------
  completeAttempt(params: CompleteAttemptParams): CompleteAttemptResult {
    return this.storage.transaction(() => {
      const attempt = this.storage.getAttempt(params.attemptId);
      if (!attempt) {
        throw attemptNotFound(params.attemptId);
      }

      // Idempotent replay: this exact attempt, already completed, called
      // again with its own (correct) fencing token. Return the stored
      // result rather than re-applying or erroring. Invariant #14.
      if (attempt.status === "completed") {
        if (params.fencingToken !== attempt.fencing_token) {
          throw staleAttemptToken({
            attemptId: attempt.attempt_id,
            providedToken: params.fencingToken,
            currentToken: attempt.fencing_token,
          });
        }
        const cached = this.storage.lookupIdempotentResult<CompleteAttemptResult>(
          `completeAttempt:${attempt.attempt_id}`,
        );
        if (cached) {
          return { ...cached, replayed: true };
        }
        // Should not normally happen (completed implies a cached result
        // was recorded), but fail closed rather than re-mutating state.
        const task = this.storage.getTask(attempt.task_id);
        if (!task) throw taskNotFound(attempt.task_id);
        return {
          attempt,
          task,
          result: params.result,
          replayed: true,
        };
      }

      this.assertFencingTokenCurrent(attempt, params.fencingToken);

      const updatedAttempt = this.assertAttemptTransition(
        attempt,
        "completed",
      );
      const now = this.storage.now();
      const finalAttempt: TaskAttempt = {
        ...updatedAttempt,
        completed_at: now,
        error: null,
      };
      this.storage.saveAttempt(finalAttempt);

      this.storage.releaseResourceClaimsForAttempt(attempt.attempt_id);

      const lease = this.storage.getLeaseByAttempt(attempt.attempt_id);
      if (lease) {
        this.storage.saveLease({
          ...lease,
          status: "released",
          released_at: now,
        });
      }

      const task = this.storage.getTask(attempt.task_id);
      if (!task) {
        throw taskNotFound(attempt.task_id);
      }
      const updatedTask = this.assertTaskTransition(task, "completed");
      const finalTask: Task = { ...updatedTask, updated_at: now };
      this.storage.saveTask(finalTask);

      // Fan-in: a task completing may satisfy the join_policy of any
      // OTHER task that lists it as a dependency (unblock -> queued for
      // "all"/"any"; see packages/core/src/fan-in.ts for full semantics,
      // including the documented "quorum" no-op).
      evaluateFanIn(this.storage, finalTask.task_id, now);

      this.storage.appendEvent({
        schema_version: 1,
        event_type: "attempt.completed",
        occurred_at: now,
        namespace_id: this.namespaceOf(finalTask),
        repository_id: finalTask.repository_id,
        workflow_id: finalTask.workflow_id,
        task_id: finalTask.task_id,
        attempt_id: attempt.attempt_id,
        agent_id: attempt.agent_id,
        workspace_session_id: attempt.workspace_session_id,
        correlation_id: null,
        causation_id: null,
        idempotency_key: null,
        payload: { result: params.result ?? null },
        metadata: {},
      });

      const result: CompleteAttemptResult = {
        attempt: finalAttempt,
        task: finalTask,
        result: params.result,
        replayed: false,
      };
      this.storage.recordIdempotentResult(
        `completeAttempt:${attempt.attempt_id}`,
        result,
      );
      return result;
    });
  }

  // -------------------------------------------------------------------------
  failAttempt(params: FailAttemptParams): FailAttemptResult {
    return this.storage.transaction(() => {
      const attempt = this.storage.getAttempt(params.attemptId);
      if (!attempt) {
        throw attemptNotFound(params.attemptId);
      }

      if (attempt.status === "failed") {
        const cached = this.storage.lookupIdempotentResult<FailAttemptResult>(
          `failAttempt:${attempt.attempt_id}`,
        );
        if (cached) {
          return { ...cached, replayed: true };
        }
      }

      this.assertFencingTokenCurrent(attempt, params.fencingToken);

      const updatedAttempt = this.assertAttemptTransition(attempt, "failed");
      const now = this.storage.now();
      const finalAttempt: TaskAttempt = {
        ...updatedAttempt,
        completed_at: now,
        error: params.error,
      };
      this.storage.saveAttempt(finalAttempt);

      this.storage.releaseResourceClaimsForAttempt(attempt.attempt_id);

      const lease = this.storage.getLeaseByAttempt(attempt.attempt_id);
      if (lease) {
        this.storage.saveLease({
          ...lease,
          status: "released",
          released_at: now,
        });
      }

      const task = this.storage.getTask(attempt.task_id);
      if (!task) {
        throw taskNotFound(attempt.task_id);
      }

      // TODO(retry-policy): this is a minimal, non-configurable-per-task
      // retry policy (fixed max attempt count). A real retry policy
      // (backoff, per-task overrides, failure-classification-aware
      // retry) is out of scope for this milestone.
      const maxAttempts = params.maxAttempts ?? 3;
      const targetTaskState =
        attempt.attempt_number >= maxAttempts ? "failed" : "queued";
      const updatedTask = this.assertTaskTransition(task, targetTaskState);
      const finalTask: Task = { ...updatedTask, updated_at: now };
      this.storage.saveTask(finalTask);

      // Fan-in: only re-evaluate dependents when this task's own retries
      // are exhausted (it escalated all the way to "failed", not merely
      // requeued to "queued" for another attempt) — that is the point at
      // which it becomes a permanently-unsatisfiable dependency for any
      // "all"/"any" policy depending on it. See packages/core/src/fan-in.ts.
      if (targetTaskState === "failed") {
        evaluateFanIn(this.storage, finalTask.task_id, now);
      }

      this.storage.appendEvent({
        schema_version: 1,
        event_type: "attempt.failed",
        occurred_at: now,
        namespace_id: this.namespaceOf(finalTask),
        repository_id: finalTask.repository_id,
        workflow_id: finalTask.workflow_id,
        task_id: finalTask.task_id,
        attempt_id: attempt.attempt_id,
        agent_id: attempt.agent_id,
        workspace_session_id: attempt.workspace_session_id,
        correlation_id: null,
        causation_id: null,
        idempotency_key: null,
        payload: { error: params.error },
        metadata: {},
      });

      const result: FailAttemptResult = {
        attempt: finalAttempt,
        task: finalTask,
        replayed: false,
      };
      this.storage.recordIdempotentResult(
        `failAttempt:${attempt.attempt_id}`,
        result,
      );
      return result;
    });
  }

  // -------------------------------------------------------------------------
  /**
   * Cancels a task and cascades the consequences to its family:
   *
   *  - The task itself: validated via `assertTaskTransition` (reusing the
   *    same `canTransitionTask` state-machine predicate every other
   *    engine method uses — no second, hand-rolled check). Any active
   *    attempt on it is cancelled and its lease/resource claims released,
   *    mirroring exactly the cleanup `apps/daemon/src/routes/tasks.ts`'s
   *    `/v1/tasks/:taskId/cancel` route already performs directly via
   *    storage (that route is out of scope to modify here — see this
   *    method's own doc for the follow-up note).
   *  - Children (`Task.parent_task_id` === this task): cascaded via
   *    `cascadeCancelChildren` (`packages/core/src/cancellation.ts`),
   *    which documents its own scope guard (only `pending`/`blocked`
   *    children auto-cancel; claimed/running children are left alone) and
   *    cascades to arbitrary nesting depth.
   *  - Dependents (`Task.dependencies` includes this task): this task
   *    becoming `cancelled` is one of `evaluateFanIn`'s
   *    `NEVER_COMPLETES_STATES` (`packages/core/src/fan-in.ts`), so
   *    calling `evaluateFanIn` here — the exact same call
   *    `completeAttempt`/`failAttempt` already make — naturally escalates
   *    any dependent whose join policy can no longer be satisfied to
   *    `dead_letter`, with no second parallel mechanism needed.
   *
   * All of the above happens inside one `storage.transaction()`, and one
   * `task.cancelled` event is appended per task that actually changed
   * state (the root, every cascaded child, and — implicitly, via
   * `evaluateFanIn`'s own writes — every dead-lettered dependent, though
   * `evaluateFanIn` itself does not append events; see note below).
   */
  cancelTask(params: CancelTaskParams): CancelTaskResult {
    return this.storage.transaction(() => {
      const task = this.storage.getTask(params.taskId);
      if (!task) {
        throw taskNotFound(params.taskId);
      }

      const now = this.storage.now();

      // Cancel any active attempt on the task itself, mirroring the
      // daemon route's existing per-attempt cleanup exactly.
      for (const attempt of this.storage.getActiveAttemptsForTask(
        task.task_id,
      )) {
        if (canTransitionAttempt(attempt.status, "cancelled")) {
          const cancelledAttempt: TaskAttempt = {
            ...attempt,
            status: "cancelled",
            completed_at: now,
            error: "task cancelled",
          };
          this.storage.saveAttempt(cancelledAttempt);
          this.storage.releaseResourceClaimsForAttempt(attempt.attempt_id);
          const lease = this.storage.getLeaseByAttempt(attempt.attempt_id);
          if (lease) {
            this.storage.saveLease({
              ...lease,
              status: "released",
              released_at: now,
            });
          }
        }
      }

      const updatedTask = this.assertTaskTransition(task, "cancelled");
      const finalTask: Task = { ...updatedTask, updated_at: now };
      this.storage.saveTask(finalTask);
      this.appendCancelledEvent(finalTask, now);

      // Cascade to children (parent_task_id relation — new logic, not
      // covered by evaluateFanIn, which only understands `dependencies`).
      const cancelledChildren = cascadeCancelChildren(
        this.storage,
        finalTask.task_id,
        finalTask.repository_id,
        now,
      );
      for (const child of cancelledChildren) {
        this.appendCancelledEvent(child, now);
      }

      // Cascade to dependents (dependencies relation — reuse the
      // existing fan-in reducer; `cancelled` is already one of its
      // NEVER_COMPLETES_STATES). Must run once for the root task AND
      // once per cascaded child, since each one is itself a potential
      // dependency of some other task.
      let fanInChanged: Task[] = evaluateFanIn(
        this.storage,
        finalTask.task_id,
        now,
      );
      for (const child of cancelledChildren) {
        fanInChanged = fanInChanged.concat(
          evaluateFanIn(this.storage, child.task_id, now),
        );
      }

      return { task: finalTask, cancelledChildren, fanInChanged };
    });
  }

  private appendCancelledEvent(task: Task, nowIso: string): void {
    this.storage.appendEvent({
      schema_version: 1,
      event_type: "task.cancelled",
      occurred_at: nowIso,
      namespace_id: this.namespaceOf(task),
      repository_id: task.repository_id,
      workflow_id: task.workflow_id,
      task_id: task.task_id,
      attempt_id: null,
      agent_id: null,
      workspace_session_id: null,
      correlation_id: null,
      causation_id: null,
      idempotency_key: null,
      payload: {},
      metadata: {},
    });
  }

  // -------------------------------------------------------------------------
  expireStaleLeases(now?: string): ExpireStaleLeasesResult {
    return this.storage.transaction(() => {
      const nowIso = now ?? this.storage.now();
      const expired = this.storage.listExpiredAttempts(nowIso);

      const expiredAttemptIds: string[] = [];
      const requeuedTaskIds: string[] = [];

      for (const attempt of expired) {
        const updatedAttempt = this.assertAttemptTransition(
          attempt,
          "expired",
        );
        const finalAttempt: TaskAttempt = {
          ...updatedAttempt,
          completed_at: nowIso,
          error: "lease expired",
        };
        this.storage.saveAttempt(finalAttempt);
        expiredAttemptIds.push(attempt.attempt_id);

        this.storage.releaseResourceClaimsForAttempt(attempt.attempt_id);

        const lease = this.storage.getLeaseByAttempt(attempt.attempt_id);
        if (lease) {
          this.storage.saveLease({
            ...lease,
            status: "expired",
            released_at: nowIso,
          });
        }

        const task = this.storage.getTask(attempt.task_id);
        if (!task) continue;
        if (canTransitionTask(task.status, "queued")) {
          const updatedTask = this.assertTaskTransition(task, "queued");
          this.storage.saveTask({ ...updatedTask, updated_at: nowIso });
          requeuedTaskIds.push(task.task_id);
        }

        this.storage.appendEvent({
          schema_version: 1,
          event_type: "attempt.expired",
          occurred_at: nowIso,
          namespace_id: this.namespaceOfTaskId(attempt.task_id),
          repository_id: task?.repository_id ?? null,
          workflow_id: task?.workflow_id ?? null,
          task_id: attempt.task_id,
          attempt_id: attempt.attempt_id,
          agent_id: attempt.agent_id,
          workspace_session_id: attempt.workspace_session_id,
          correlation_id: null,
          causation_id: null,
          idempotency_key: null,
          payload: {},
          metadata: {},
        });
      }

      return { expiredAttemptIds, requeuedTaskIds };
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private assertFencingTokenCurrent(
    attempt: TaskAttempt,
    providedToken: number,
  ): void {
    if (attempt.fencing_token !== providedToken) {
      throw staleAttemptToken({
        attemptId: attempt.attempt_id,
        providedToken,
        currentToken: attempt.fencing_token,
      });
    }
  }

  private assertAttemptTransition(
    attempt: TaskAttempt,
    to: TaskAttempt["status"],
  ): TaskAttempt {
    if (!canTransitionAttempt(attempt.status, to)) {
      throw invalidStateTransition({
        entity: "TaskAttempt",
        entityId: attempt.attempt_id,
        from: attempt.status,
        to,
      });
    }
    return { ...attempt, status: to };
  }

  private assertTaskTransition(task: Task, to: Task["status"]): Task {
    if (!canTransitionTask(task.status, to)) {
      throw invalidStateTransition({
        entity: "Task",
        entityId: task.task_id,
        from: task.status,
        to,
      });
    }
    return { ...task, status: to };
  }

  private namespaceOf(task: Task): string {
    // Tasks don't carry namespace_id directly (it lives on Repository/
    // Agent); for event-envelope purposes we scope by repository_id,
    // which is sufficient for this milestone's single-tenant-per-repo
    // assumption. A later milestone threads namespace_id through
    // explicitly once multi-tenancy lands in the daemon.
    return task.repository_id;
  }

  private namespaceOfTaskId(taskId: string): string {
    const task = this.storage.getTask(taskId);
    return task ? task.repository_id : "unknown";
  }
}

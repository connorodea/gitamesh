import type {
  Task,
  TaskAttempt,
  ResourceClaim,
  Lease,
  EventEnvelope,
} from "@gitamesh/protocol";

/**
 * Storage-agnostic persistence contract. `packages/core`'s
 * `CoordinationEngine` is written entirely against this interface and
 * never imports a concrete storage implementation. `packages/storage-sqlite`
 * provides the first implementation (SQLite/better-sqlite3); a future
 * Postgres adapter implements the same interface for multi-process/
 * multi-daemon production deployments.
 *
 * Every method that performs a "check-then-write" (claim, heartbeat,
 * complete, fail, expire) MUST be called from within a single
 * `transaction()` callback by the engine so the adapter can make the
 * whole sequence atomic using its underlying storage's transaction
 * primitive.
 */
export interface StorageAdapter {
  /**
   * Runs `fn` inside a single atomic transaction and returns its result.
   * If `fn` throws, the adapter must roll back any writes performed
   * during the callback.
   */
  transaction<T>(fn: () => T): T;

  // --- Tasks --------------------------------------------------------------
  getTask(taskId: string): Task | undefined;
  saveTask(task: Task): void;

  // --- Attempts -------------------------------------------------------------
  getAttempt(attemptId: string): TaskAttempt | undefined;
  saveAttempt(attempt: TaskAttempt): void;
  /** Attempts for a task whose status is one of created/leased/running. */
  getActiveAttemptsForTask(taskId: string): TaskAttempt[];
  /** Total attempts ever created for a task (used for attempt_number + retry counting). */
  countAttemptsForTask(taskId: string): number;
  /** Attempts with status leased/running whose expires_at <= nowIso. */
  listExpiredAttempts(nowIso: string): TaskAttempt[];

  // --- Resource claims ------------------------------------------------------
  /** All claims with status "active" (i.e. not yet released/expired) for a repository. */
  getActiveResourceClaims(repositoryId: string): ResourceClaim[];
  saveResourceClaim(claim: ResourceClaim): void;
  getResourceClaimsForAttempt(attemptId: string): ResourceClaim[];
  releaseResourceClaimsForAttempt(attemptId: string): void;
  renewResourceClaimsForAttempt(attemptId: string, newExpiresAtIso: string): void;

  // --- Leases -----------------------------------------------------------
  getLease(leaseId: string): Lease | undefined;
  getLeaseByAttempt(attemptId: string): Lease | undefined;
  saveLease(lease: Lease): void;

  // --- Fencing tokens -----------------------------------------------------
  /** Returns a fresh, monotonically increasing fencing token scoped to a repository. */
  nextFencingToken(repositoryId: string): number;

  // --- Events ---------------------------------------------------------------
  /**
   * Appends an event, assigning `event_id` (if not already set) and the
   * next monotonic `repository_sequence` for `event.repository_id`
   * (falling back to a global/namespace sequence when `repository_id` is
   * null). Returns the stored envelope.
   */
  appendEvent(
    event: Omit<EventEnvelope, "event_id" | "repository_sequence"> & {
      event_id?: string;
    },
  ): EventEnvelope;

  // --- Idempotency ------------------------------------------------------
  lookupIdempotentResult<T>(key: string): T | undefined;
  recordIdempotentResult<T>(key: string, result: T): void;

  // --- Utilities --------------------------------------------------------
  generateId(prefix: string): string;
  /** Current time as an ISO-8601 datetime string. Injectable for deterministic tests. */
  now(): string;
}

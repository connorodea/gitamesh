import type {
  Task,
  TaskAttempt,
  ResourceClaim,
  Lease,
  EventEnvelope,
  Agent,
  Message,
  TaskRevision,
  TaskNote,
  PathLock,
} from "@gitamesh/protocol";

/**
 * A stored bearer token record. Daemon-only concern — auth/token
 * management is a daemon-layer responsibility, not a coordination
 * invariant, but it is part of the shared `StorageAdapter` contract so
 * that every implementation (SQLite, Postgres, ...) can back
 * `apps/daemon` interchangeably. `token_hash` is a SHA-256 hex digest of
 * the raw token; the raw value is never persisted.
 */
export interface StoredToken {
  token_id: string;
  token_hash: string;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface EventWithCursor extends EventEnvelope {
  /**
   * Monotonic, globally-ordered insertion cursor. Opaque — treat as an
   * opaque string/number token to pass back as `since`, never as a
   * semantic value (e.g. do not assume gaps mean anything).
   */
  cursor: number;
}

/**
 * Storage-agnostic persistence contract. `packages/core`'s
 * `CoordinationEngine` is written entirely against this interface and
 * never imports a concrete storage implementation. `apps/daemon` is also
 * written entirely against this interface (not any concrete adapter
 * class), so any implementation can be selected at daemon startup via
 * `GITAMESH_STORAGE_DRIVER`. `packages/storage-sqlite` provides the
 * embedded/single-process implementation (SQLite/better-sqlite3);
 * `packages/storage-postgres` provides the multi-process/multi-daemon
 * production implementation (node-postgres).
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
  /** All events for a repository, in repository_sequence order. */
  listEventsForRepository(repositoryId: string): EventEnvelope[];
  /** Every event ever appended, in global insertion order. */
  listAllEvents(): EventEnvelope[];
  /**
   * Daemon-facing cursor read: events with cursor > `cursor` (0 = from the
   * beginning), in global insertion order, optionally filtered to one
   * repository, capped at `limit` (adapter-defined default). Backs
   * `GET /v1/events` and the replay phase of `GET /v1/events/stream`.
   */
  listEventsSince(
    cursor: number,
    opts?: { repositoryId?: string; limit?: number },
  ): { events: EventWithCursor[]; nextCursor: number };
  /** Current maximum event cursor, or 0 if no events exist yet. */
  latestEventCursor(): number;

  // --- Agents (daemon-facing) ---------------------------------------------
  getAgent(agentId: string): Agent | undefined;
  saveAgent(agent: Agent): void;
  listAgents(): Agent[];

  // --- Tasks: daemon-facing listing (core only needs get/save) ---------------
  listTasks(filter?: { repositoryId?: string; status?: string }): Task[];
  countTasksByStatus(): Record<string, number>;

  // --- Resource claims: daemon-facing listing/manual release ------------------
  listActiveResourceClaims(repositoryId?: string): ResourceClaim[];
  getResourceClaim(claimId: string): ResourceClaim | undefined;
  /** Manually releases a single claim. Returns false if it did not exist or was already released. */
  releaseResourceClaim(claimId: string): boolean;

  // --- Attempts: daemon-facing listing (owner visibility) -----------------
  /** Every attempt whose status is created/leased/running, across all tasks. */
  listActiveAttempts(): TaskAttempt[];

  // --- Messages (append-only: no update, no delete) -----------------------
  /** Inserts a new message. `message.acked_by` is ignored; acks go through `ackMessage`. */
  appendMessage(message: Message): void;
  getMessage(messageId: string): Message | undefined;
  /** Messages in creation order, optionally limited to a repository and/or `created_at > since`. */
  listMessages(filter?: { repositoryId?: string; since?: string }): Message[];
  /** Records that `agentId` read the message. Returns false if that agent had already acked it. */
  ackMessage(messageId: string, agentId: string, ackedAtIso: string): boolean;

  // --- Task history (append-only: no update, no delete) -------------------
  appendTaskRevision(revision: TaskRevision): void;
  /** Revisions for a task, oldest first. */
  listTaskRevisions(taskId: string): TaskRevision[];
  appendTaskNote(note: TaskNote): void;
  /** Notes for a task, oldest first. */
  listTaskNotes(taskId: string): TaskNote[];

  // --- Path locks ----------------------------------------------------------
  /** Inserts or updates a lock. Locks are never deleted: release sets `released_at`. */
  savePathLock(lock: PathLock): void;
  getPathLock(lockId: string): PathLock | undefined;
  /** Locks with `released_at` null (expired ones included — the caller compares `expires_at`). */
  listUnreleasedPathLocks(repositoryId?: string): PathLock[];

  // --- Tokens (daemon-only auth) ----------------------------------------
  saveToken(token: StoredToken): void;
  getTokenByHash(tokenHash: string): StoredToken | undefined;
  listTokens(): StoredToken[];
  revokeToken(tokenId: string, revokedAtIso: string): boolean;

  /** Cheap reachability check, e.g. for `GET /readyz`. */
  ping(): boolean;

  // --- Idempotency ------------------------------------------------------
  lookupIdempotentResult<T>(key: string): T | undefined;
  recordIdempotentResult<T>(key: string, result: T): void;

  // --- Utilities --------------------------------------------------------
  generateId(prefix: string): string;
  /** Current time as an ISO-8601 datetime string. Injectable for deterministic tests. */
  now(): string;
  /** Releases underlying connection(s)/resources. Idempotent. */
  close(): void;
}

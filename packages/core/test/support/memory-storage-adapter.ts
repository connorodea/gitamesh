import type {
  Task,
  TaskAttempt,
  ResourceClaim,
  Lease,
  EventEnvelope,
} from "@gitamesh/protocol";
import type { StorageAdapter } from "../../src/storage-adapter.js";

/**
 * A pure in-memory implementation of StorageAdapter, used ONLY by
 * packages/core's own unit tests. It mirrors the semantics
 * `packages/storage-sqlite` implements against real SQLite (see that
 * package's own tests for the SQLite-specific behavior, e.g. per-repository
 * event sequence assignment against a real transactional store).
 *
 * `transaction()` snapshots all maps before running `fn` and restores them
 * if `fn` throws, so tests can rely on the same "no mutation on failure"
 * guarantee the real adapter provides via a genuine SQL transaction.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private tasks = new Map<string, Task>();
  private attempts = new Map<string, TaskAttempt>();
  private claims = new Map<string, ResourceClaim & { released: boolean }>();
  private leases = new Map<string, Lease>();
  private events: EventEnvelope[] = [];
  private repoSequences = new Map<string, number>();
  private fencingCounters = new Map<string, number>();
  private idempotencyStore = new Map<string, unknown>();
  private idCounters = new Map<string, number>();
  private clock = 0;

  transaction<T>(fn: () => T): T {
    const snapshot = {
      tasks: new Map(this.tasks),
      attempts: new Map(this.attempts),
      claims: new Map(this.claims),
      leases: new Map(this.leases),
      events: [...this.events],
      repoSequences: new Map(this.repoSequences),
      fencingCounters: new Map(this.fencingCounters),
      idempotencyStore: new Map(this.idempotencyStore),
      idCounters: new Map(this.idCounters),
    };
    try {
      return fn();
    } catch (err) {
      this.tasks = snapshot.tasks;
      this.attempts = snapshot.attempts;
      this.claims = snapshot.claims;
      this.leases = snapshot.leases;
      this.events = snapshot.events;
      this.repoSequences = snapshot.repoSequences;
      this.fencingCounters = snapshot.fencingCounters;
      this.idempotencyStore = snapshot.idempotencyStore;
      this.idCounters = snapshot.idCounters;
      throw err;
    }
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }
  saveTask(task: Task): void {
    this.tasks.set(task.task_id, task);
  }

  getAttempt(attemptId: string): TaskAttempt | undefined {
    return this.attempts.get(attemptId);
  }
  saveAttempt(attempt: TaskAttempt): void {
    this.attempts.set(attempt.attempt_id, attempt);
  }
  getActiveAttemptsForTask(taskId: string): TaskAttempt[] {
    return [...this.attempts.values()].filter(
      (a) =>
        a.task_id === taskId &&
        (a.status === "created" ||
          a.status === "leased" ||
          a.status === "running"),
    );
  }
  countAttemptsForTask(taskId: string): number {
    return [...this.attempts.values()].filter((a) => a.task_id === taskId)
      .length;
  }
  listExpiredAttempts(nowIso: string): TaskAttempt[] {
    return [...this.attempts.values()].filter(
      (a) =>
        (a.status === "leased" || a.status === "running") &&
        a.expires_at <= nowIso,
    );
  }

  getActiveResourceClaims(repositoryId: string): ResourceClaim[] {
    return [...this.claims.values()].filter(
      (c) => c.repository_id === repositoryId && !c.released,
    );
  }
  saveResourceClaim(claim: ResourceClaim): void {
    this.claims.set(claim.resource_claim_id, { ...claim, released: false });
  }
  getResourceClaimsForAttempt(attemptId: string): ResourceClaim[] {
    return [...this.claims.values()].filter((c) => c.attempt_id === attemptId);
  }
  releaseResourceClaimsForAttempt(attemptId: string): void {
    for (const claim of this.claims.values()) {
      if (claim.attempt_id === attemptId) {
        claim.released = true;
      }
    }
  }
  renewResourceClaimsForAttempt(attemptId: string, newExpiresAtIso: string): void {
    for (const claim of this.claims.values()) {
      if (claim.attempt_id === attemptId && !claim.released) {
        claim.expires_at = newExpiresAtIso;
      }
    }
  }

  getLease(leaseId: string): Lease | undefined {
    return this.leases.get(leaseId);
  }
  getLeaseByAttempt(attemptId: string): Lease | undefined {
    return [...this.leases.values()]
      .filter((l) => l.attempt_id === attemptId)
      .sort((a, b) => (a.acquired_at < b.acquired_at ? 1 : -1))[0];
  }
  saveLease(lease: Lease): void {
    this.leases.set(lease.lease_id, lease);
  }

  nextFencingToken(repositoryId: string): number {
    const current = this.fencingCounters.get(repositoryId) ?? 0;
    const next = current + 1;
    this.fencingCounters.set(repositoryId, next);
    return next;
  }

  appendEvent(
    event: Omit<EventEnvelope, "event_id" | "repository_sequence"> & {
      event_id?: string;
    },
  ): EventEnvelope {
    const scopeKey = event.repository_id ?? `ns:${event.namespace_id}`;
    const current = this.repoSequences.get(scopeKey) ?? 0;
    const next = current + 1;
    this.repoSequences.set(scopeKey, next);
    const full: EventEnvelope = {
      ...event,
      event_id: event.event_id ?? this.generateId("event"),
      repository_sequence: next,
    };
    this.events.push(full);
    return full;
  }

  listAllEvents(): EventEnvelope[] {
    return [...this.events];
  }

  lookupIdempotentResult<T>(key: string): T | undefined {
    return this.idempotencyStore.get(key) as T | undefined;
  }
  recordIdempotentResult<T>(key: string, result: T): void {
    this.idempotencyStore.set(key, result);
  }

  generateId(prefix: string): string {
    const current = this.idCounters.get(prefix) ?? 0;
    const next = current + 1;
    this.idCounters.set(prefix, next);
    return `${prefix}_${next}`;
  }

  now(): string {
    this.clock += 1;
    // Deterministic, strictly increasing ISO timestamps so ordering-
    // sensitive assertions (expiry, sequence) are reproducible without
    // relying on wall-clock resolution.
    return new Date(1_700_000_000_000 + this.clock).toISOString();
  }
}

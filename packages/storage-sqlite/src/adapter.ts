import Database from "better-sqlite3";
import type {
  Task,
  TaskAttempt,
  ResourceClaim,
  Lease,
  EventEnvelope,
} from "@gitamesh/protocol";
import type { StorageAdapter } from "@gitamesh/core";
import { SCHEMA_SQL } from "./schema.js";

type TaskRow = {
  task_id: string;
  workflow_id: string;
  repository_id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  status: string;
  priority: number;
  required_capabilities: string;
  dependencies: string;
  join_policy: string;
  base_sha: string | null;
  branch: string | null;
  idempotency_key: string | null;
  deadline_at: string | null;
  created_at: string;
  updated_at: string;
};

type AttemptRow = {
  attempt_id: string;
  task_id: string;
  agent_id: string;
  workspace_session_id: string;
  attempt_number: number;
  status: string;
  lease_id: string | null;
  fencing_token: number | null;
  started_at: string;
  heartbeat_at: string;
  expires_at: string;
  completed_at: string | null;
  error: string | null;
};

type ClaimRow = {
  resource_claim_id: string;
  repository_id: string;
  task_id: string;
  attempt_id: string;
  resource_type: string;
  resource_key: string;
  mode: string;
  lease_id: string;
  fencing_token: number;
  expires_at: string;
  released: number;
};

type LeaseRow = {
  lease_id: string;
  owner_agent_id: string;
  attempt_id: string;
  status: string;
  fencing_token: number;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
  released_at: string | null;
};

type EventRow = {
  event_id: string;
  schema_version: number;
  event_type: string;
  repository_sequence: number;
  occurred_at: string;
  namespace_id: string;
  repository_id: string | null;
  workflow_id: string | null;
  task_id: string | null;
  attempt_id: string | null;
  agent_id: string | null;
  workspace_session_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  idempotency_key: string | null;
  payload: string;
  metadata: string;
};

function taskFromRow(row: TaskRow): Task {
  return {
    task_id: row.task_id,
    workflow_id: row.workflow_id,
    repository_id: row.repository_id,
    parent_task_id: row.parent_task_id,
    title: row.title,
    description: row.description,
    status: row.status as Task["status"],
    priority: row.priority,
    required_capabilities: JSON.parse(row.required_capabilities),
    dependencies: JSON.parse(row.dependencies),
    join_policy: row.join_policy as Task["join_policy"],
    base_sha: row.base_sha,
    branch: row.branch,
    idempotency_key: row.idempotency_key,
    deadline_at: row.deadline_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function attemptFromRow(row: AttemptRow): TaskAttempt {
  return {
    attempt_id: row.attempt_id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    workspace_session_id: row.workspace_session_id,
    attempt_number: row.attempt_number,
    status: row.status as TaskAttempt["status"],
    lease_id: row.lease_id,
    fencing_token: row.fencing_token,
    started_at: row.started_at,
    heartbeat_at: row.heartbeat_at,
    expires_at: row.expires_at,
    completed_at: row.completed_at,
    error: row.error,
  };
}

function claimFromRow(row: ClaimRow): ResourceClaim {
  return {
    resource_claim_id: row.resource_claim_id,
    repository_id: row.repository_id,
    task_id: row.task_id,
    attempt_id: row.attempt_id,
    resource_type: row.resource_type as ResourceClaim["resource_type"],
    resource_key: row.resource_key,
    mode: row.mode as ResourceClaim["mode"],
    lease_id: row.lease_id,
    fencing_token: row.fencing_token,
    expires_at: row.expires_at,
  };
}

function leaseFromRow(row: LeaseRow): Lease {
  return {
    lease_id: row.lease_id,
    owner_agent_id: row.owner_agent_id,
    attempt_id: row.attempt_id,
    status: row.status as Lease["status"],
    fencing_token: row.fencing_token,
    acquired_at: row.acquired_at,
    renewed_at: row.renewed_at,
    expires_at: row.expires_at,
    released_at: row.released_at,
  };
}

function eventFromRow(row: EventRow): EventEnvelope {
  return {
    event_id: row.event_id,
    schema_version: row.schema_version,
    event_type: row.event_type,
    repository_sequence: row.repository_sequence,
    occurred_at: row.occurred_at,
    namespace_id: row.namespace_id,
    repository_id: row.repository_id,
    workflow_id: row.workflow_id,
    task_id: row.task_id,
    attempt_id: row.attempt_id,
    agent_id: row.agent_id,
    workspace_session_id: row.workspace_session_id,
    correlation_id: row.correlation_id,
    causation_id: row.causation_id,
    idempotency_key: row.idempotency_key,
    payload: JSON.parse(row.payload),
    metadata: JSON.parse(row.metadata),
  };
}

let idCounter = 0;

export class SqliteStorageAdapter implements StorageAdapter {
  private readonly db: Database.Database;
  private inTransaction = false;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      // Support re-entrant calls (an engine method calling another
      // storage-transaction-wrapped helper) by just running inline —
      // the outermost transaction() call still owns the atomic boundary.
      return fn();
    }
    const runner = this.db.transaction(() => {
      this.inTransaction = true;
      try {
        return fn();
      } finally {
        this.inTransaction = false;
      }
    });
    return runner();
  }

  // --- Tasks ----------------------------------------------------------------
  getTask(taskId: string): Task | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE task_id = ?")
      .get(taskId) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  saveTask(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, workflow_id, repository_id, parent_task_id, title, description, status, priority, required_capabilities, dependencies, join_policy, base_sha, branch, idempotency_key, deadline_at, created_at, updated_at)
         VALUES (@task_id, @workflow_id, @repository_id, @parent_task_id, @title, @description, @status, @priority, @required_capabilities, @dependencies, @join_policy, @base_sha, @branch, @idempotency_key, @deadline_at, @created_at, @updated_at)
         ON CONFLICT(task_id) DO UPDATE SET
           workflow_id=excluded.workflow_id, repository_id=excluded.repository_id,
           parent_task_id=excluded.parent_task_id, title=excluded.title,
           description=excluded.description, status=excluded.status,
           priority=excluded.priority, required_capabilities=excluded.required_capabilities,
           dependencies=excluded.dependencies, join_policy=excluded.join_policy,
           base_sha=excluded.base_sha, branch=excluded.branch,
           idempotency_key=excluded.idempotency_key, deadline_at=excluded.deadline_at,
           created_at=excluded.created_at, updated_at=excluded.updated_at`,
      )
      .run({
        ...task,
        required_capabilities: JSON.stringify(task.required_capabilities),
        dependencies: JSON.stringify(task.dependencies),
      });
  }

  // --- Attempts ---------------------------------------------------------------
  getAttempt(attemptId: string): TaskAttempt | undefined {
    const row = this.db
      .prepare("SELECT * FROM task_attempts WHERE attempt_id = ?")
      .get(attemptId) as AttemptRow | undefined;
    return row ? attemptFromRow(row) : undefined;
  }

  saveAttempt(attempt: TaskAttempt): void {
    this.db
      .prepare(
        `INSERT INTO task_attempts (attempt_id, task_id, agent_id, workspace_session_id, attempt_number, status, lease_id, fencing_token, started_at, heartbeat_at, expires_at, completed_at, error)
         VALUES (@attempt_id, @task_id, @agent_id, @workspace_session_id, @attempt_number, @status, @lease_id, @fencing_token, @started_at, @heartbeat_at, @expires_at, @completed_at, @error)
         ON CONFLICT(attempt_id) DO UPDATE SET
           status=excluded.status, lease_id=excluded.lease_id, fencing_token=excluded.fencing_token,
           heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at,
           completed_at=excluded.completed_at, error=excluded.error`,
      )
      .run(attempt);
  }

  getActiveAttemptsForTask(taskId: string): TaskAttempt[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_attempts WHERE task_id = ? AND status IN ('created','leased','running')`,
      )
      .all(taskId) as AttemptRow[];
    return rows.map(attemptFromRow);
  }

  countAttemptsForTask(taskId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as c FROM task_attempts WHERE task_id = ?`)
      .get(taskId) as { c: number };
    return row.c;
  }

  listExpiredAttempts(nowIso: string): TaskAttempt[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_attempts WHERE status IN ('leased','running') AND expires_at <= ?`,
      )
      .all(nowIso) as AttemptRow[];
    return rows.map(attemptFromRow);
  }

  // --- Resource claims ----------------------------------------------------------
  getActiveResourceClaims(repositoryId: string): ResourceClaim[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM resource_claims WHERE repository_id = ? AND released = 0`,
      )
      .all(repositoryId) as ClaimRow[];
    return rows.map(claimFromRow);
  }

  saveResourceClaim(claim: ResourceClaim): void {
    this.db
      .prepare(
        `INSERT INTO resource_claims (resource_claim_id, repository_id, task_id, attempt_id, resource_type, resource_key, mode, lease_id, fencing_token, expires_at, released)
         VALUES (@resource_claim_id, @repository_id, @task_id, @attempt_id, @resource_type, @resource_key, @mode, @lease_id, @fencing_token, @expires_at, 0)
         ON CONFLICT(resource_claim_id) DO UPDATE SET expires_at=excluded.expires_at`,
      )
      .run(claim);
  }

  getResourceClaimsForAttempt(attemptId: string): ResourceClaim[] {
    const rows = this.db
      .prepare(`SELECT * FROM resource_claims WHERE attempt_id = ?`)
      .all(attemptId) as ClaimRow[];
    return rows.map(claimFromRow);
  }

  releaseResourceClaimsForAttempt(attemptId: string): void {
    this.db
      .prepare(`UPDATE resource_claims SET released = 1 WHERE attempt_id = ?`)
      .run(attemptId);
  }

  renewResourceClaimsForAttempt(
    attemptId: string,
    newExpiresAtIso: string,
  ): void {
    this.db
      .prepare(
        `UPDATE resource_claims SET expires_at = ? WHERE attempt_id = ? AND released = 0`,
      )
      .run(newExpiresAtIso, attemptId);
  }

  // --- Leases -------------------------------------------------------------
  getLease(leaseId: string): Lease | undefined {
    const row = this.db
      .prepare(`SELECT * FROM leases WHERE lease_id = ?`)
      .get(leaseId) as LeaseRow | undefined;
    return row ? leaseFromRow(row) : undefined;
  }

  getLeaseByAttempt(attemptId: string): Lease | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM leases WHERE attempt_id = ? ORDER BY acquired_at DESC LIMIT 1`,
      )
      .get(attemptId) as LeaseRow | undefined;
    return row ? leaseFromRow(row) : undefined;
  }

  saveLease(lease: Lease): void {
    this.db
      .prepare(
        `INSERT INTO leases (lease_id, owner_agent_id, attempt_id, status, fencing_token, acquired_at, renewed_at, expires_at, released_at)
         VALUES (@lease_id, @owner_agent_id, @attempt_id, @status, @fencing_token, @acquired_at, @renewed_at, @expires_at, @released_at)
         ON CONFLICT(lease_id) DO UPDATE SET
           status=excluded.status, renewed_at=excluded.renewed_at,
           expires_at=excluded.expires_at, released_at=excluded.released_at`,
      )
      .run(lease);
  }

  // --- Fencing tokens -------------------------------------------------------
  nextFencingToken(repositoryId: string): number {
    this.db
      .prepare(
        `INSERT INTO fencing_counters (repository_id, next_token) VALUES (?, 1)
         ON CONFLICT(repository_id) DO UPDATE SET next_token = next_token + 1`,
      )
      .run(repositoryId);
    const row = this.db
      .prepare(`SELECT next_token FROM fencing_counters WHERE repository_id = ?`)
      .get(repositoryId) as { next_token: number };
    return row.next_token;
  }

  // --- Events -----------------------------------------------------------
  appendEvent(
    event: Omit<EventEnvelope, "event_id" | "repository_sequence"> & {
      event_id?: string;
    },
  ): EventEnvelope {
    const scopeKey = event.repository_id ?? `ns:${event.namespace_id}`;
    this.db
      .prepare(
        `INSERT INTO event_sequences (scope_key, next_seq) VALUES (?, 1)
         ON CONFLICT(scope_key) DO UPDATE SET next_seq = next_seq + 1`,
      )
      .run(scopeKey);
    const seqRow = this.db
      .prepare(`SELECT next_seq FROM event_sequences WHERE scope_key = ?`)
      .get(scopeKey) as { next_seq: number };

    const eventId = event.event_id ?? this.generateId("event");
    const full: EventEnvelope = {
      ...event,
      event_id: eventId,
      repository_sequence: seqRow.next_seq,
    };

    this.db
      .prepare(
        `INSERT INTO events (event_id, schema_version, event_type, repository_sequence, occurred_at, namespace_id, repository_id, workflow_id, task_id, attempt_id, agent_id, workspace_session_id, correlation_id, causation_id, idempotency_key, payload, metadata)
         VALUES (@event_id, @schema_version, @event_type, @repository_sequence, @occurred_at, @namespace_id, @repository_id, @workflow_id, @task_id, @attempt_id, @agent_id, @workspace_session_id, @correlation_id, @causation_id, @idempotency_key, @payload, @metadata)`,
      )
      .run({
        ...full,
        payload: JSON.stringify(full.payload),
        metadata: JSON.stringify(full.metadata),
      });

    return full;
  }

  listEventsForRepository(repositoryId: string): EventEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE repository_id = ? ORDER BY repository_sequence ASC`,
      )
      .all(repositoryId) as EventRow[];
    return rows.map(eventFromRow);
  }

  // --- Idempotency --------------------------------------------------------
  lookupIdempotentResult<T>(key: string): T | undefined {
    const row = this.db
      .prepare(`SELECT result_json FROM idempotency_keys WHERE idempotency_key = ?`)
      .get(key) as { result_json: string } | undefined;
    return row ? (JSON.parse(row.result_json) as T) : undefined;
  }

  recordIdempotentResult<T>(key: string, result: T): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_keys (idempotency_key, result_json, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET result_json = excluded.result_json`,
      )
      .run(key, JSON.stringify(result), new Date().toISOString());
  }

  // --- Utilities ----------------------------------------------------------
  generateId(prefix: string): string {
    idCounter += 1;
    const row = this.db
      .prepare(
        `INSERT INTO id_counters (prefix, next_value) VALUES (?, 1)
         ON CONFLICT(prefix) DO UPDATE SET next_value = next_value + 1
         RETURNING next_value`,
      )
      .get(prefix) as { next_value: number };
    return `${prefix}_${row.next_value.toString(36)}_${idCounter.toString(36)}`;
  }

  now(): string {
    return new Date().toISOString();
  }

  close(): void {
    this.db.close();
  }
}

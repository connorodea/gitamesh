import type {
  Task,
  TaskAttempt,
  ResourceClaim,
  Lease,
  EventEnvelope,
  Agent,
  Message,
  MessageAck,
  TaskRevision,
  TaskNote,
  PathLock,
} from "@gitamesh/protocol";
import type {
  StorageAdapter,
  StoredToken,
  EventWithCursor,
} from "@gitamesh/core";
import { SyncPostgresClient } from "./sync-client.js";
import { SCHEMA_SQL } from "./schema.js";
import type { PostgresWorkerInitOptions } from "./worker.js";

type TaskRow = {
  task_id: string;
  workflow_id: string;
  repository_id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  status: string;
  priority: number;
  required_capabilities: string[];
  dependencies: string[];
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
  fencing_token: number | string | null;
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
  fencing_token: number | string;
  expires_at: string;
  released: boolean;
};

type LeaseRow = {
  lease_id: string;
  owner_agent_id: string;
  attempt_id: string;
  status: string;
  fencing_token: number | string;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
  released_at: string | null;
};

type EventRow = {
  cursor: number | string;
  event_id: string;
  schema_version: number;
  event_type: string;
  repository_sequence: number | string;
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
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

type AgentRow = {
  agent_id: string;
  namespace_id: string;
  display_name: string;
  runtime: string;
  version: string;
  capabilities: string[];
  status: string;
  last_heartbeat_at: string | null;
  metadata: Record<string, unknown>;
};

type TokenRow = {
  token_id: string;
  token_hash: string;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

/** `BIGINT`/`BIGSERIAL` columns come back from `pg` as strings (they exceed safe-integer range in the worst case); this driver's fencing tokens/cursors stay well within `Number.MAX_SAFE_INTEGER` in practice, so a plain `Number()` cast is safe and keeps the adapter's public types identical to the SQLite adapter's (`number`, not `bigint`/`string`). */
function num(v: number | string): number {
  return typeof v === "string" ? Number(v) : v;
}

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
    required_capabilities: row.required_capabilities,
    dependencies: row.dependencies,
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
    fencing_token: row.fencing_token === null ? null : num(row.fencing_token),
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
    fencing_token: num(row.fencing_token),
    expires_at: row.expires_at,
  };
}

function leaseFromRow(row: LeaseRow): Lease {
  return {
    lease_id: row.lease_id,
    owner_agent_id: row.owner_agent_id,
    attempt_id: row.attempt_id,
    status: row.status as Lease["status"],
    fencing_token: num(row.fencing_token),
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
    repository_sequence: num(row.repository_sequence),
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
    payload: row.payload,
    metadata: row.metadata,
  };
}

function agentFromRow(row: AgentRow): Agent {
  return {
    agent_id: row.agent_id,
    namespace_id: row.namespace_id,
    display_name: row.display_name,
    runtime: row.runtime,
    version: row.version,
    capabilities: row.capabilities,
    status: row.status as Agent["status"],
    last_heartbeat_at: row.last_heartbeat_at,
    metadata: row.metadata,
  };
}

function tokenFromRow(row: TokenRow): StoredToken {
  return {
    token_id: row.token_id,
    token_hash: row.token_hash,
    scopes: row.scopes,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
  };
}

let idCounter = 0;

export interface PostgresStorageOptions {
  /** `postgresql://user:pass@host:port/db`. Required unless `pglite` is set. */
  connectionString?: string;
  /** Forwarded to `pg.Client`, e.g. `{ rejectUnauthorized: false }` for managed Postgres providers with self-signed certs. */
  ssl?: boolean | Record<string, unknown>;
  /**
   * Test-only: run against an embedded in-process Postgres
   * (`@electric-sql/pglite`) instead of a real server. See
   * `packages/storage-postgres/README.md`. Never set this in production.
   */
  pglite?: boolean;
}

type MessageRow = {
  message_id: string;
  from_agent_id: string;
  to_agent_id: string;
  repository_id: string | null;
  task_id: string | null;
  body: string;
  created_at: string;
};

/**
 * PostgreSQL implementation of `StorageAdapter`, for multi-process/
 * multi-daemon production deployments (see `packages/core`'s
 * `storage-adapter.ts` doc comment). Every query is routed through a
 * persistent worker thread via `SyncPostgresClient` so this class can
 * offer the same synchronous method surface as `SqliteStorageAdapter` —
 * see `sync-client.ts` for why, and its cost.
 */
export class PostgresStorageAdapter implements StorageAdapter {
  private readonly client = new SyncPostgresClient();
  private inTransaction = false;

  constructor(options: PostgresStorageOptions) {
    if (!options.pglite && !options.connectionString) {
      throw new Error(
        "PostgresStorageAdapter: connectionString is required unless pglite is set.",
      );
    }
    const initOptions: PostgresWorkerInitOptions = {
      connectionString: options.connectionString,
      ssl: options.ssl,
      pglite: options.pglite,
      schemaSql: SCHEMA_SQL,
    };
    this.client.init(initOptions);
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      // Re-entrant call (an engine method calling another
      // transaction()-wrapped helper): run inline, same as
      // SqliteStorageAdapter — the outermost call owns the atomic
      // boundary.
      return fn();
    }
    this.inTransaction = true;
    this.client.begin();
    try {
      const result = fn();
      this.client.commit();
      return result;
    } catch (err) {
      this.client.rollback();
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  // --- Tasks ----------------------------------------------------------------
  getTask(taskId: string): Task | undefined {
    const rows = this.client.query<TaskRow>(
      "SELECT * FROM tasks WHERE task_id = $1",
      [taskId],
    );
    return rows[0] ? taskFromRow(rows[0]) : undefined;
  }

  saveTask(task: Task): void {
    this.client.query(
      `INSERT INTO tasks (task_id, workflow_id, repository_id, parent_task_id, title, description, status, priority, required_capabilities, dependencies, join_policy, base_sha, branch, idempotency_key, deadline_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (task_id) DO UPDATE SET
         workflow_id=excluded.workflow_id, repository_id=excluded.repository_id,
         parent_task_id=excluded.parent_task_id, title=excluded.title,
         description=excluded.description, status=excluded.status,
         priority=excluded.priority, required_capabilities=excluded.required_capabilities,
         dependencies=excluded.dependencies, join_policy=excluded.join_policy,
         base_sha=excluded.base_sha, branch=excluded.branch,
         idempotency_key=excluded.idempotency_key, deadline_at=excluded.deadline_at,
         created_at=excluded.created_at, updated_at=excluded.updated_at`,
      [
        task.task_id,
        task.workflow_id,
        task.repository_id,
        task.parent_task_id,
        task.title,
        task.description,
        task.status,
        task.priority,
        JSON.stringify(task.required_capabilities),
        JSON.stringify(task.dependencies),
        task.join_policy,
        task.base_sha,
        task.branch,
        task.idempotency_key,
        task.deadline_at,
        task.created_at,
        task.updated_at,
      ],
    );
  }

  // --- Attempts ---------------------------------------------------------------
  getAttempt(attemptId: string): TaskAttempt | undefined {
    const rows = this.client.query<AttemptRow>(
      "SELECT * FROM task_attempts WHERE attempt_id = $1",
      [attemptId],
    );
    return rows[0] ? attemptFromRow(rows[0]) : undefined;
  }

  saveAttempt(attempt: TaskAttempt): void {
    this.client.query(
      `INSERT INTO task_attempts (attempt_id, task_id, agent_id, workspace_session_id, attempt_number, status, lease_id, fencing_token, started_at, heartbeat_at, expires_at, completed_at, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (attempt_id) DO UPDATE SET
         status=excluded.status, lease_id=excluded.lease_id, fencing_token=excluded.fencing_token,
         heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at,
         completed_at=excluded.completed_at, error=excluded.error`,
      [
        attempt.attempt_id,
        attempt.task_id,
        attempt.agent_id,
        attempt.workspace_session_id,
        attempt.attempt_number,
        attempt.status,
        attempt.lease_id,
        attempt.fencing_token,
        attempt.started_at,
        attempt.heartbeat_at,
        attempt.expires_at,
        attempt.completed_at,
        attempt.error,
      ],
    );
  }

  getActiveAttemptsForTask(taskId: string): TaskAttempt[] {
    const rows = this.client.query<AttemptRow>(
      `SELECT * FROM task_attempts WHERE task_id = $1 AND status IN ('created','leased','running')`,
      [taskId],
    );
    return rows.map(attemptFromRow);
  }

  countAttemptsForTask(taskId: string): number {
    const rows = this.client.query<{ c: string | number }>(
      `SELECT COUNT(*) as c FROM task_attempts WHERE task_id = $1`,
      [taskId],
    );
    return num(rows[0]!.c);
  }

  listExpiredAttempts(nowIso: string): TaskAttempt[] {
    const rows = this.client.query<AttemptRow>(
      `SELECT * FROM task_attempts WHERE status IN ('leased','running') AND expires_at <= $1`,
      [nowIso],
    );
    return rows.map(attemptFromRow);
  }

  // --- Resource claims ----------------------------------------------------------
  getActiveResourceClaims(repositoryId: string): ResourceClaim[] {
    const rows = this.client.query<ClaimRow>(
      `SELECT * FROM resource_claims WHERE repository_id = $1 AND released = FALSE`,
      [repositoryId],
    );
    return rows.map(claimFromRow);
  }

  saveResourceClaim(claim: ResourceClaim): void {
    this.client.query(
      `INSERT INTO resource_claims (resource_claim_id, repository_id, task_id, attempt_id, resource_type, resource_key, mode, lease_id, fencing_token, expires_at, released)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE)
       ON CONFLICT (resource_claim_id) DO UPDATE SET expires_at=excluded.expires_at`,
      [
        claim.resource_claim_id,
        claim.repository_id,
        claim.task_id,
        claim.attempt_id,
        claim.resource_type,
        claim.resource_key,
        claim.mode,
        claim.lease_id,
        claim.fencing_token,
        claim.expires_at,
      ],
    );
  }

  getResourceClaimsForAttempt(attemptId: string): ResourceClaim[] {
    const rows = this.client.query<ClaimRow>(
      `SELECT * FROM resource_claims WHERE attempt_id = $1`,
      [attemptId],
    );
    return rows.map(claimFromRow);
  }

  releaseResourceClaimsForAttempt(attemptId: string): void {
    this.client.query(
      `UPDATE resource_claims SET released = TRUE WHERE attempt_id = $1`,
      [attemptId],
    );
  }

  renewResourceClaimsForAttempt(attemptId: string, newExpiresAtIso: string): void {
    this.client.query(
      `UPDATE resource_claims SET expires_at = $1 WHERE attempt_id = $2 AND released = FALSE`,
      [newExpiresAtIso, attemptId],
    );
  }

  // --- Leases -------------------------------------------------------------
  getLease(leaseId: string): Lease | undefined {
    const rows = this.client.query<LeaseRow>(
      `SELECT * FROM leases WHERE lease_id = $1`,
      [leaseId],
    );
    return rows[0] ? leaseFromRow(rows[0]) : undefined;
  }

  getLeaseByAttempt(attemptId: string): Lease | undefined {
    const rows = this.client.query<LeaseRow>(
      `SELECT * FROM leases WHERE attempt_id = $1 ORDER BY acquired_at DESC LIMIT 1`,
      [attemptId],
    );
    return rows[0] ? leaseFromRow(rows[0]) : undefined;
  }

  saveLease(lease: Lease): void {
    this.client.query(
      `INSERT INTO leases (lease_id, owner_agent_id, attempt_id, status, fencing_token, acquired_at, renewed_at, expires_at, released_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (lease_id) DO UPDATE SET
         status=excluded.status, renewed_at=excluded.renewed_at,
         expires_at=excluded.expires_at, released_at=excluded.released_at`,
      [
        lease.lease_id,
        lease.owner_agent_id,
        lease.attempt_id,
        lease.status,
        lease.fencing_token,
        lease.acquired_at,
        lease.renewed_at,
        lease.expires_at,
        lease.released_at,
      ],
    );
  }

  // --- Fencing tokens -------------------------------------------------------
  nextFencingToken(repositoryId: string): number {
    const rows = this.client.query<{ next_token: string | number }>(
      `INSERT INTO fencing_counters (repository_id, next_token) VALUES ($1, 1)
       ON CONFLICT (repository_id) DO UPDATE SET next_token = fencing_counters.next_token + 1
       RETURNING next_token`,
      [repositoryId],
    );
    return num(rows[0]!.next_token);
  }

  // --- Events -----------------------------------------------------------
  appendEvent(
    event: Omit<EventEnvelope, "event_id" | "repository_sequence"> & {
      event_id?: string;
    },
  ): EventEnvelope {
    const scopeKey = event.repository_id ?? `ns:${event.namespace_id}`;
    const seqRows = this.client.query<{ next_seq: string | number }>(
      `INSERT INTO event_sequences (scope_key, next_seq) VALUES ($1, 1)
       ON CONFLICT (scope_key) DO UPDATE SET next_seq = event_sequences.next_seq + 1
       RETURNING next_seq`,
      [scopeKey],
    );
    const repositorySequence = num(seqRows[0]!.next_seq);

    const eventId = event.event_id ?? this.generateId("event");
    const full: EventEnvelope = {
      ...event,
      event_id: eventId,
      repository_sequence: repositorySequence,
    };

    this.client.query(
      `INSERT INTO events (event_id, schema_version, event_type, repository_sequence, occurred_at, namespace_id, repository_id, workflow_id, task_id, attempt_id, agent_id, workspace_session_id, correlation_id, causation_id, idempotency_key, payload, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        full.event_id,
        full.schema_version,
        full.event_type,
        full.repository_sequence,
        full.occurred_at,
        full.namespace_id,
        full.repository_id,
        full.workflow_id,
        full.task_id,
        full.attempt_id,
        full.agent_id,
        full.workspace_session_id,
        full.correlation_id,
        full.causation_id,
        full.idempotency_key,
        JSON.stringify(full.payload),
        JSON.stringify(full.metadata),
      ],
    );

    return full;
  }

  listEventsForRepository(repositoryId: string): EventEnvelope[] {
    const rows = this.client.query<EventRow>(
      `SELECT * FROM events WHERE repository_id = $1 ORDER BY repository_sequence ASC`,
      [repositoryId],
    );
    return rows.map(eventFromRow);
  }

  listAllEvents(): EventEnvelope[] {
    const rows = this.client.query<EventRow>(
      `SELECT * FROM events ORDER BY cursor ASC`,
    );
    return rows.map(eventFromRow);
  }

  listEventsSince(
    cursor: number,
    opts?: { repositoryId?: string; limit?: number },
  ): { events: EventWithCursor[]; nextCursor: number } {
    const limit = opts?.limit ?? 500;
    const rows = opts?.repositoryId
      ? this.client.query<EventRow>(
          `SELECT * FROM events WHERE cursor > $1 AND repository_id = $2 ORDER BY cursor ASC LIMIT $3`,
          [cursor, opts.repositoryId, limit],
        )
      : this.client.query<EventRow>(
          `SELECT * FROM events WHERE cursor > $1 ORDER BY cursor ASC LIMIT $2`,
          [cursor, limit],
        );
    const events = rows.map((row) => ({
      ...eventFromRow(row),
      cursor: num(row.cursor),
    }));
    const nextCursor =
      events.length > 0 ? events[events.length - 1]!.cursor : cursor;
    return { events, nextCursor };
  }

  latestEventCursor(): number {
    const rows = this.client.query<{ m: string | number | null }>(
      `SELECT COALESCE(MAX(cursor), 0) as m FROM events`,
    );
    return rows[0]?.m == null ? 0 : num(rows[0].m);
  }

  // --- Agents (daemon-facing) ---------------------------------------------
  getAgent(agentId: string): Agent | undefined {
    const rows = this.client.query<AgentRow>(
      `SELECT * FROM agents WHERE agent_id = $1`,
      [agentId],
    );
    return rows[0] ? agentFromRow(rows[0]) : undefined;
  }

  saveAgent(agent: Agent): void {
    this.client.query(
      `INSERT INTO agents (agent_id, namespace_id, display_name, runtime, version, capabilities, status, last_heartbeat_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (agent_id) DO UPDATE SET
         display_name=excluded.display_name, runtime=excluded.runtime,
         version=excluded.version, capabilities=excluded.capabilities,
         status=excluded.status, last_heartbeat_at=excluded.last_heartbeat_at,
         metadata=excluded.metadata`,
      [
        agent.agent_id,
        agent.namespace_id,
        agent.display_name,
        agent.runtime,
        agent.version,
        JSON.stringify(agent.capabilities),
        agent.status,
        agent.last_heartbeat_at,
        JSON.stringify(agent.metadata),
      ],
    );
  }

  listAgents(): Agent[] {
    const rows = this.client.query<AgentRow>(
      `SELECT * FROM agents ORDER BY agent_id ASC`,
    );
    return rows.map(agentFromRow);
  }

  // --- Tasks: daemon-facing listing ---------------------------------------
  listTasks(filter?: { repositoryId?: string; status?: string }): Task[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter?.repositoryId) {
      args.push(filter.repositoryId);
      clauses.push(`repository_id = $${args.length}`);
    }
    if (filter?.status) {
      args.push(filter.status);
      clauses.push(`status = $${args.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.client.query<TaskRow>(
      `SELECT * FROM tasks ${where} ORDER BY created_at ASC`,
      args,
    );
    return rows.map(taskFromRow);
  }

  countTasksByStatus(): Record<string, number> {
    const rows = this.client.query<{ status: string; c: string | number }>(
      `SELECT status, COUNT(*) as c FROM tasks GROUP BY status`,
    );
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = num(row.c);
    return out;
  }

  // --- Resource claims: daemon-facing listing/manual release ------------------
  listActiveResourceClaims(repositoryId?: string): ResourceClaim[] {
    const rows = repositoryId
      ? this.client.query<ClaimRow>(
          `SELECT * FROM resource_claims WHERE repository_id = $1 AND released = FALSE`,
          [repositoryId],
        )
      : this.client.query<ClaimRow>(
          `SELECT * FROM resource_claims WHERE released = FALSE`,
        );
    return rows.map(claimFromRow);
  }

  getResourceClaim(claimId: string): ResourceClaim | undefined {
    const rows = this.client.query<ClaimRow>(
      `SELECT * FROM resource_claims WHERE resource_claim_id = $1`,
      [claimId],
    );
    return rows[0] ? claimFromRow(rows[0]) : undefined;
  }

  releaseResourceClaim(claimId: string): boolean {
    const rows = this.client.query<{ resource_claim_id: string }>(
      `UPDATE resource_claims SET released = TRUE WHERE resource_claim_id = $1 AND released = FALSE RETURNING resource_claim_id`,
      [claimId],
    );
    return rows.length > 0;
  }

  // --- Attempts: daemon-facing listing (owner visibility) -----------------
  listActiveAttempts(): TaskAttempt[] {
    const rows = this.client.query<AttemptRow>(
      `SELECT * FROM task_attempts WHERE status IN ('created','leased','running')`,
    );
    return rows.map(attemptFromRow);
  }

  // --- Messages (append-only) ----------------------------------------------
  appendMessage(message: Message): void {
    this.client.query(
      `INSERT INTO messages (message_id, from_agent_id, to_agent_id, repository_id, task_id, body, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        message.message_id,
        message.from,
        message.to,
        message.repository_id,
        message.task_id,
        message.body,
        message.created_at,
      ],
    );
  }

  getMessage(messageId: string): Message | undefined {
    const rows = this.client.query<MessageRow>(
      `SELECT * FROM messages WHERE message_id = $1`,
      [messageId],
    );
    return rows[0] ? this.messageFromRow(rows[0]) : undefined;
  }

  listMessages(filter?: { repositoryId?: string; since?: string }): Message[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter?.repositoryId) {
      args.push(filter.repositoryId);
      clauses.push(`repository_id = $${args.length}`);
    }
    if (filter?.since) {
      args.push(filter.since);
      clauses.push(`created_at > $${args.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.client.query<MessageRow>(
      `SELECT * FROM messages ${where} ORDER BY created_at ASC, message_id ASC`,
      args,
    );
    return rows.map((row) => this.messageFromRow(row));
  }

  ackMessage(messageId: string, agentId: string, ackedAtIso: string): boolean {
    const rows = this.client.query<{ agent_id: string }>(
      `INSERT INTO message_acks (message_id, agent_id, acked_at) VALUES ($1,$2,$3)
       ON CONFLICT (message_id, agent_id) DO NOTHING RETURNING agent_id`,
      [messageId, agentId, ackedAtIso],
    );
    return rows.length > 0;
  }

  private messageFromRow(row: MessageRow): Message {
    const acks = this.client.query<MessageAck>(
      `SELECT agent_id, acked_at FROM message_acks WHERE message_id = $1 ORDER BY acked_at ASC, agent_id ASC`,
      [row.message_id],
    );
    return {
      message_id: row.message_id,
      from: row.from_agent_id,
      to: row.to_agent_id,
      repository_id: row.repository_id,
      task_id: row.task_id,
      body: row.body,
      created_at: row.created_at,
      acked_by: acks,
    };
  }

  // --- Task history (append-only) ------------------------------------------
  appendTaskRevision(revision: TaskRevision): void {
    this.client.query(
      `INSERT INTO task_revisions (revision_id, task_id, changed_by, changed_at, changes)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        revision.revision_id,
        revision.task_id,
        revision.changed_by,
        revision.changed_at,
        JSON.stringify(revision.changes),
      ],
    );
  }

  listTaskRevisions(taskId: string): TaskRevision[] {
    return this.client.query<TaskRevision>(
      `SELECT * FROM task_revisions WHERE task_id = $1 ORDER BY changed_at ASC, revision_id ASC`,
      [taskId],
    );
  }

  appendTaskNote(note: TaskNote): void {
    this.client.query(
      `INSERT INTO task_notes (note_id, task_id, agent_id, body, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [note.note_id, note.task_id, note.agent_id, note.body, note.created_at],
    );
  }

  listTaskNotes(taskId: string): TaskNote[] {
    return this.client.query<TaskNote>(
      `SELECT * FROM task_notes WHERE task_id = $1 ORDER BY created_at ASC, note_id ASC`,
      [taskId],
    );
  }

  // --- Path locks ------------------------------------------------------------
  savePathLock(lock: PathLock): void {
    this.client.query(
      `INSERT INTO path_locks (lock_id, repository_id, agent_id, task_id, paths, acquired_at, heartbeat_at, expires_at, released_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (lock_id) DO UPDATE SET
         heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at,
         released_at=excluded.released_at`,
      [
        lock.lock_id,
        lock.repository_id,
        lock.agent_id,
        lock.task_id,
        JSON.stringify(lock.paths),
        lock.acquired_at,
        lock.heartbeat_at,
        lock.expires_at,
        lock.released_at,
      ],
    );
  }

  getPathLock(lockId: string): PathLock | undefined {
    const rows = this.client.query<PathLock>(
      `SELECT * FROM path_locks WHERE lock_id = $1`,
      [lockId],
    );
    return rows[0];
  }

  listUnreleasedPathLocks(repositoryId?: string): PathLock[] {
    return repositoryId
      ? this.client.query<PathLock>(
          `SELECT * FROM path_locks WHERE repository_id = $1 AND released_at IS NULL ORDER BY acquired_at ASC, lock_id ASC`,
          [repositoryId],
        )
      : this.client.query<PathLock>(
          `SELECT * FROM path_locks WHERE released_at IS NULL ORDER BY acquired_at ASC, lock_id ASC`,
        );
  }

  // --- Tokens (daemon-only) -----------------------------------------------
  saveToken(token: StoredToken): void {
    this.client.query(
      `INSERT INTO tokens (token_id, token_hash, scopes, created_at, expires_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (token_id) DO UPDATE SET revoked_at = excluded.revoked_at`,
      [
        token.token_id,
        token.token_hash,
        JSON.stringify(token.scopes),
        token.created_at,
        token.expires_at,
        token.revoked_at,
      ],
    );
  }

  getTokenByHash(tokenHash: string): StoredToken | undefined {
    const rows = this.client.query<TokenRow>(
      `SELECT * FROM tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    return rows[0] ? tokenFromRow(rows[0]) : undefined;
  }

  listTokens(): StoredToken[] {
    const rows = this.client.query<TokenRow>(
      `SELECT * FROM tokens ORDER BY created_at ASC`,
    );
    return rows.map(tokenFromRow);
  }

  revokeToken(tokenId: string, revokedAtIso: string): boolean {
    const rows = this.client.query<{ token_id: string }>(
      `UPDATE tokens SET revoked_at = $1 WHERE token_id = $2 AND revoked_at IS NULL RETURNING token_id`,
      [revokedAtIso, tokenId],
    );
    return rows.length > 0;
  }

  /** Cheap reachability check for `GET /readyz`. */
  ping(): boolean {
    const rows = this.client.query<{ ok: number }>(`SELECT 1 as ok`);
    return rows[0]?.ok === 1;
  }

  // --- Idempotency --------------------------------------------------------
  lookupIdempotentResult<T>(key: string): T | undefined {
    const rows = this.client.query<{ result_json: T }>(
      `SELECT result_json FROM idempotency_keys WHERE idempotency_key = $1`,
      [key],
    );
    return rows[0]?.result_json;
  }

  recordIdempotentResult<T>(key: string, result: T): void {
    this.client.query(
      `INSERT INTO idempotency_keys (idempotency_key, result_json, created_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (idempotency_key) DO UPDATE SET result_json = excluded.result_json`,
      [key, JSON.stringify(result), new Date().toISOString()],
    );
  }

  // --- Utilities ----------------------------------------------------------
  generateId(prefix: string): string {
    idCounter += 1;
    const rows = this.client.query<{ next_value: string | number }>(
      `INSERT INTO id_counters (prefix, next_value) VALUES ($1, 1)
       ON CONFLICT (prefix) DO UPDATE SET next_value = id_counters.next_value + 1
       RETURNING next_value`,
      [prefix],
    );
    const nextValue = num(rows[0]!.next_value);
    return `${prefix}_${nextValue.toString(36)}_${idCounter.toString(36)}`;
  }

  now(): string {
    return new Date().toISOString();
  }

  close(): void {
    this.client.close();
  }
}

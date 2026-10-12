/**
 * Schema for the SQLite storage adapter.
 *
 * Multi-process safety note: this adapter is correct for a single
 * embedded/single-process daemon using one WAL-mode connection —
 * check-then-write sequences are wrapped in real SQLite transactions
 * (`db.transaction(...)`), and SQLite itself serializes writers. It is
 * NOT designed for multiple separate OS processes writing to the same
 * SQLite file concurrently (SQLite's file-level locking makes that slow
 * and, for long-held transactions, prone to `SQLITE_BUSY`). Multi-process
 * / multi-daemon production deployments are expected to use a future
 * Postgres adapter implementing the same `StorageAdapter` interface.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS repositories (
  repository_id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worktrees (
  worktree_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  branch TEXT,
  detached INTEGER NOT NULL,
  dirty INTEGER NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  version TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  status TEXT NOT NULL,
  last_heartbeat_at TEXT,
  metadata TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_sessions (
  workspace_session_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  head_sha TEXT NOT NULL,
  branch TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  parent_task_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  priority REAL NOT NULL,
  required_capabilities TEXT NOT NULL,
  dependencies TEXT NOT NULL,
  join_policy TEXT NOT NULL,
  base_sha TEXT,
  branch TEXT,
  idempotency_key TEXT,
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_repository ON tasks(repository_id);

CREATE TABLE IF NOT EXISTS task_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  workspace_session_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  lease_id TEXT,
  fencing_token INTEGER,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_attempts_status_expiry ON task_attempts(status, expires_at);

CREATE TABLE IF NOT EXISTS resource_claims (
  resource_claim_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  released INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_claims_repo_active ON resource_claims(repository_id, released);
CREATE INDEX IF NOT EXISTS idx_claims_attempt ON resource_claims(attempt_id);

CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  owner_agent_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_leases_attempt ON leases(attempt_id);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  repository_sequence INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  repository_id TEXT,
  workflow_id TEXT,
  task_id TEXT,
  attempt_id TEXT,
  agent_id TEXT,
  workspace_session_id TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  idempotency_key TEXT,
  payload TEXT NOT NULL,
  metadata TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_repo_seq ON events(repository_id, repository_sequence);

CREATE TABLE IF NOT EXISTS event_sequences (
  scope_key TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fencing_counters (
  repository_id TEXT PRIMARY KEY,
  next_token INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS id_counters (
  prefix TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL
);

-- Daemon-only concern (apps/daemon): opaque bearer tokens for the HTTP API.
-- This is NOT part of the storage-agnostic CoordinationEngine's
-- StorageAdapter interface (packages/core) — auth/token management is a
-- daemon-layer responsibility, not a coordination invariant, so it is
-- implemented as extra methods on the concrete SqliteStorageAdapter that
-- apps/daemon depends on directly. Only the hash is ever stored; the raw
-- token is shown to the caller exactly once, at mint time.
CREATE TABLE IF NOT EXISTS tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash);

-- Agent collaboration records. messages, message_acks, task_revisions and
-- task_notes are append-only: the adapter has no UPDATE or DELETE for them.
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  repository_id TEXT,
  task_id TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent_id);

CREATE TABLE IF NOT EXISTS message_acks (
  message_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  acked_at TEXT NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);

CREATE TABLE IF NOT EXISTS task_revisions (
  revision_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  changed_by TEXT,
  changed_at TEXT NOT NULL,
  changes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_revisions_task ON task_revisions(task_id);

CREATE TABLE IF NOT EXISTS task_notes (
  note_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id);

CREATE TABLE IF NOT EXISTS path_locks (
  lock_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  paths TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_path_locks_repo ON path_locks(repository_id, released_at);
`;

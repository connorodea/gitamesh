/**
 * Schema for the PostgreSQL storage adapter.
 *
 * Field-for-field equivalent to `packages/storage-sqlite/src/schema.ts`,
 * with two deliberate differences:
 *
 *  - JSON-ish columns (`required_capabilities`, `dependencies`,
 *    `capabilities`, `metadata`, `scopes`, `payload`, `result_json`) are
 *    `JSONB` here instead of `TEXT` — node-postgres decodes JSONB columns
 *    into native JS values automatically, so the adapter does not need to
 *    JSON.parse/stringify by hand the way the SQLite adapter does.
 *  - `events` gets a dedicated `BIGSERIAL cursor` column. SQLite's adapter
 *    uses the implicit `rowid` as its opaque insertion-order cursor;
 *    Postgres has no equivalent stable primitive (no default rowid, and
 *    `ctid` is not stable across VACUUM), so this schema makes the cursor
 *    an explicit auto-incrementing column instead.
 *
 * Multi-process safety: unlike the SQLite adapter (single-process,
 * single-connection, `docker-compose`'s comment for the historical
 * context), this adapter is designed for multiple daemon processes
 * concurrently reading/writing the same database. Correctness for
 * concurrent writers relies on real Postgres transactions (`BEGIN` /
 * `COMMIT` / `ROLLBACK`) plus `SELECT ... FOR UPDATE`-free
 * `INSERT ... ON CONFLICT` upserts and atomic `UPDATE ... RETURNING`
 * counters — see adapter.ts for where each invariant is enforced.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS repositories (
  repository_id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS worktrees (
  worktree_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  branch TEXT,
  detached BOOLEAN NOT NULL,
  dirty BOOLEAN NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  version TEXT NOT NULL,
  capabilities JSONB NOT NULL,
  status TEXT NOT NULL,
  last_heartbeat_at TEXT,
  metadata JSONB NOT NULL
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
  priority DOUBLE PRECISION NOT NULL,
  required_capabilities JSONB NOT NULL,
  dependencies JSONB NOT NULL,
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
  fencing_token BIGINT,
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
  fencing_token BIGINT NOT NULL,
  expires_at TEXT NOT NULL,
  released BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_claims_repo_active ON resource_claims(repository_id, released);
CREATE INDEX IF NOT EXISTS idx_claims_attempt ON resource_claims(attempt_id);

CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  owner_agent_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL,
  fencing_token BIGINT NOT NULL,
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_leases_attempt ON leases(attempt_id);

CREATE TABLE IF NOT EXISTS events (
  cursor BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  repository_sequence BIGINT NOT NULL,
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
  payload JSONB NOT NULL,
  metadata JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_repo_seq ON events(repository_id, repository_sequence);
CREATE INDEX IF NOT EXISTS idx_events_cursor ON events(cursor);

CREATE TABLE IF NOT EXISTS event_sequences (
  scope_key TEXT PRIMARY KEY,
  next_seq BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS fencing_counters (
  repository_id TEXT PRIMARY KEY,
  next_token BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  result_json JSONB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS id_counters (
  prefix TEXT PRIMARY KEY,
  next_value BIGINT NOT NULL
);

-- Daemon-only concern (apps/daemon): opaque bearer tokens for the HTTP API.
-- See the equivalent comment in packages/storage-sqlite/src/schema.ts —
-- auth/token management is a daemon-layer responsibility layered onto the
-- shared StorageAdapter contract, not a coordination invariant.
CREATE TABLE IF NOT EXISTS tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL,
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
  changes JSONB NOT NULL
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
  paths JSONB NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_path_locks_repo ON path_locks(repository_id, released_at);
`;

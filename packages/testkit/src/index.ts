import { CoordinationEngine, type StorageAdapter } from "@gitamesh/core";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import type { Repository, Task, Agent } from "@gitamesh/protocol";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

export interface TestEngine {
  engine: CoordinationEngine;
  /**
   * Typed against the storage-agnostic `StorageAdapter` interface, not the
   * concrete `SqliteStorageAdapter` class — `createTestEngine()` happens to
   * use the in-memory SQLite adapter today, but nothing consuming
   * `TestEngine.storage` should depend on SQLite-only methods.
   */
  storage: StorageAdapter;
}

/** Spins up a fresh in-memory SQLite-backed CoordinationEngine for tests. */
export function createTestEngine(): TestEngine {
  const storage = createInMemorySqliteStorage();
  const engine = new CoordinationEngine(storage);
  return { engine, storage };
}

export function buildRepository(overrides: Partial<Repository> = {}): Repository {
  const id = overrides.repository_id ?? nextId("repo");
  return {
    repository_id: id,
    namespace_id: overrides.namespace_id ?? "default",
    display_name: overrides.display_name ?? id,
    git_common_dir: overrides.git_common_dir ?? `/tmp/${id}/.git`,
    default_branch: overrides.default_branch ?? "main",
    created_at: overrides.created_at ?? new Date().toISOString(),
    metadata: overrides.metadata ?? {},
  };
}

export function buildTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.task_id ?? nextId("task");
  const now = new Date().toISOString();
  return {
    task_id: id,
    workflow_id: overrides.workflow_id ?? nextId("workflow"),
    repository_id: overrides.repository_id ?? nextId("repo"),
    parent_task_id: overrides.parent_task_id ?? null,
    title: overrides.title ?? `Task ${id}`,
    description: overrides.description ?? "",
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 0,
    required_capabilities: overrides.required_capabilities ?? [],
    dependencies: overrides.dependencies ?? [],
    join_policy: overrides.join_policy ?? "all",
    base_sha: overrides.base_sha ?? null,
    branch: overrides.branch ?? null,
    idempotency_key: overrides.idempotency_key ?? null,
    deadline_at: overrides.deadline_at ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

export function buildAgent(overrides: Partial<Agent> = {}): Agent {
  const id = overrides.agent_id ?? nextId("agent");
  return {
    agent_id: id,
    namespace_id: overrides.namespace_id ?? "default",
    display_name: overrides.display_name ?? id,
    runtime: overrides.runtime ?? "custom",
    version: overrides.version ?? "0.0.0",
    capabilities: overrides.capabilities ?? [],
    status: overrides.status ?? "online",
    last_heartbeat_at: overrides.last_heartbeat_at ?? new Date().toISOString(),
    metadata: overrides.metadata ?? {},
  };
}

export * from "@gitamesh/core";
export * from "@gitamesh/protocol";

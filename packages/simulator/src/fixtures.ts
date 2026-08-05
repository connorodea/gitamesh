import type { Task, ResourceMode, ResourceType } from "@gitamesh/protocol";

/**
 * Deterministic entity builders for the simulator.
 *
 * These deliberately do NOT read the wall clock (no `new Date()`,
 * `Date.now()`). Every timestamp is a fixed, meaningless-but-valid ISO
 * string, and every id is caller-supplied. Determinism of the
 * `simulation-report.json` output depends on nothing here ever varying
 * between two runs with the same seed.
 */
const FIXED_TIMESTAMP = "2000-01-01T00:00:00.000Z";

export interface RequiredResourceSpec {
  resourceType: ResourceType;
  resourceKey: string;
  mode: ResourceMode;
}

export function buildSimTask(params: {
  taskId: string;
  repositoryId: string;
  workflowId: string;
  title: string;
  parentTaskId?: string | null;
  dependencies?: string[];
  joinPolicy?: Task["join_policy"];
}): Task {
  return {
    task_id: params.taskId,
    workflow_id: params.workflowId,
    repository_id: params.repositoryId,
    parent_task_id: params.parentTaskId ?? null,
    title: params.title,
    description: `Synthetic simulator task ${params.taskId}`,
    status: "pending",
    priority: 0,
    required_capabilities: [],
    dependencies: params.dependencies ?? [],
    join_policy: params.joinPolicy ?? "all",
    base_sha: null,
    branch: null,
    idempotency_key: null,
    deadline_at: null,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
  };
}

export function syntheticAgentIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `sim-agent-${i + 1}`);
}

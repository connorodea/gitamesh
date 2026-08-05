import type { Task } from "@gitamesh/protocol";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

export function buildTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.task_id ?? nextId("task");
  const now = new Date().toISOString();
  return {
    task_id: id,
    workflow_id: overrides.workflow_id ?? nextId("workflow"),
    repository_id: overrides.repository_id ?? "repo_1",
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

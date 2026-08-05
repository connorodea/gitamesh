import type { Agent, Task, TaskAttempt, ResourceClaim, EventEnvelope } from "@gitamesh/protocol";

const NOW = "2026-08-04T00:00:00.000Z";

export function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: "agent_1",
    namespace_id: "default",
    display_name: "claude-code-1",
    runtime: "claude-code",
    version: "0.1.0",
    capabilities: ["typescript"],
    status: "registered",
    last_heartbeat_at: null,
    metadata: {},
    ...overrides,
  };
}

export function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: "task_1",
    workflow_id: "wf_default",
    repository_id: "repo_1",
    parent_task_id: null,
    title: "Build the thing",
    description: "",
    status: "pending",
    priority: 0,
    required_capabilities: [],
    dependencies: [],
    join_policy: "all",
    base_sha: null,
    branch: null,
    idempotency_key: null,
    deadline_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function fakeAttempt(overrides: Partial<TaskAttempt> = {}): TaskAttempt {
  return {
    attempt_id: "attempt_1",
    task_id: "task_1",
    agent_id: "agent_1",
    workspace_session_id: "session_1",
    attempt_number: 1,
    status: "running",
    lease_id: "lease_1",
    fencing_token: 1,
    started_at: NOW,
    heartbeat_at: NOW,
    expires_at: NOW,
    completed_at: null,
    error: null,
    ...overrides,
  };
}

export function fakeClaim(overrides: Partial<ResourceClaim> = {}): ResourceClaim {
  return {
    resource_claim_id: "claim_1",
    repository_id: "repo_1",
    task_id: "task_1",
    attempt_id: "attempt_1",
    resource_type: "path",
    resource_key: "src/index.ts",
    mode: "write",
    lease_id: "lease_1",
    fencing_token: 1,
    expires_at: NOW,
    ...overrides,
  };
}

export function fakeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: "event_1",
    schema_version: 1,
    event_type: "task.created",
    repository_sequence: 1,
    occurred_at: NOW,
    namespace_id: "default",
    repository_id: "repo_1",
    workflow_id: "wf_default",
    task_id: "task_1",
    attempt_id: null,
    agent_id: null,
    workspace_session_id: null,
    correlation_id: null,
    causation_id: null,
    idempotency_key: null,
    payload: {},
    metadata: {},
    ...overrides,
  };
}

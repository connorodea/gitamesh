import { z } from "zod";

/**
 * Core domain-model schemas for Gitamesh.
 *
 * These are the canonical, versioned wire contracts shared between the
 * daemon, CLI, SDK, and any external adapter. Nothing here is
 * domain-specific (no legal, no vendor-specific business logic) — this is
 * a generic coordination substrate over Git + agent runtimes.
 */

const metadataSchema = z.record(z.string(), z.unknown());

export const RepositorySchema = z.object({
  repository_id: z.string(),
  namespace_id: z.string(),
  display_name: z.string(),
  git_common_dir: z.string(),
  default_branch: z.string(),
  created_at: z.string().datetime(),
  metadata: metadataSchema,
});
export type Repository = z.infer<typeof RepositorySchema>;

export const WorktreeSchema = z.object({
  worktree_id: z.string(),
  repository_id: z.string(),
  canonical_path: z.string(),
  head_sha: z.string(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  dirty: z.boolean(),
  last_seen_at: z.string().datetime(),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

/**
 * `runtime` is a free-form label describing which agent runtime produced
 * this Agent record. The common runtimes are enumerated for developer
 * ergonomics (autocomplete / docs) but arbitrary strings are accepted —
 * Gitamesh must never hard-code vendor-specific coordination logic.
 */
export const AgentRuntimeSchema = z.union([
  z.literal("claude-code"),
  z.literal("codex"),
  z.literal("cursor"),
  z.literal("custom"),
  z.string(),
]);
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

export const AGENT_STATES = [
  "registered",
  "online",
  "draining",
  "offline",
  "stale",
  "revoked",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];
export const AgentStateSchema = z.enum(AGENT_STATES);

export const AgentSchema = z.object({
  agent_id: z.string(),
  namespace_id: z.string(),
  display_name: z.string(),
  runtime: AgentRuntimeSchema,
  version: z.string(),
  capabilities: z.array(z.string()),
  status: AgentStateSchema,
  last_heartbeat_at: z.string().datetime().nullable(),
  metadata: metadataSchema,
});
export type Agent = z.infer<typeof AgentSchema>;

export const WorkspaceSessionSchema = z.object({
  workspace_session_id: z.string(),
  repository_id: z.string(),
  worktree_id: z.string(),
  agent_id: z.string(),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable(),
  head_sha: z.string(),
  branch: z.string().nullable(),
  status: z.string(),
});
export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>;

export const WorkflowSchema = z.object({
  workflow_id: z.string(),
  repository_id: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.string(),
  correlation_id: z.string().nullable(),
  created_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

export const TASK_STATES = [
  "pending",
  "queued",
  "claiming",
  "running",
  "blocked",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "dead_letter",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TaskStateSchema = z.enum(TASK_STATES);

export const JoinPolicySchema = z.union([
  z.literal("all"),
  z.literal("any"),
  z.literal("quorum"),
]);
export type JoinPolicy = z.infer<typeof JoinPolicySchema>;

export const TaskSchema = z.object({
  task_id: z.string(),
  workflow_id: z.string(),
  repository_id: z.string(),
  parent_task_id: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  status: TaskStateSchema,
  priority: z.number(),
  required_capabilities: z.array(z.string()),
  dependencies: z.array(z.string()),
  join_policy: JoinPolicySchema,
  base_sha: z.string().nullable(),
  branch: z.string().nullable(),
  idempotency_key: z.string().nullable(),
  deadline_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Task = z.infer<typeof TaskSchema>;

export const ATTEMPT_STATES = [
  "created",
  "leased",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "rejected_stale",
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];
export const AttemptStateSchema = z.enum(ATTEMPT_STATES);

export const TaskAttemptSchema = z.object({
  attempt_id: z.string(),
  task_id: z.string(),
  agent_id: z.string(),
  workspace_session_id: z.string(),
  attempt_number: z.number().int().positive(),
  status: AttemptStateSchema,
  lease_id: z.string().nullable(),
  fencing_token: z.number().int().nonnegative().nullable(),
  started_at: z.string().datetime(),
  heartbeat_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
  error: z.string().nullable(),
});
export type TaskAttempt = z.infer<typeof TaskAttemptSchema>;

export const ResourceTypeSchema = z.union([
  z.literal("repository"),
  z.literal("worktree"),
  z.literal("branch"),
  z.literal("path"),
  z.literal("symbol"),
  z.literal("integration_target"),
  z.literal("custom"),
]);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export const ResourceModeSchema = z.union([
  z.literal("read"),
  z.literal("write"),
  z.literal("exclusive"),
]);
export type ResourceMode = z.infer<typeof ResourceModeSchema>;

export const ResourceClaimSchema = z.object({
  resource_claim_id: z.string(),
  repository_id: z.string(),
  task_id: z.string(),
  attempt_id: z.string(),
  resource_type: ResourceTypeSchema,
  resource_key: z.string(),
  mode: ResourceModeSchema,
  lease_id: z.string(),
  fencing_token: z.number().int().nonnegative(),
  expires_at: z.string().datetime(),
});
export type ResourceClaim = z.infer<typeof ResourceClaimSchema>;

export const LeaseStatusSchema = z.union([
  z.literal("active"),
  z.literal("expired"),
  z.literal("released"),
  z.literal("superseded"),
]);
export type LeaseStatus = z.infer<typeof LeaseStatusSchema>;

export const LeaseSchema = z.object({
  lease_id: z.string(),
  owner_agent_id: z.string(),
  attempt_id: z.string(),
  status: LeaseStatusSchema,
  fencing_token: z.number().int().nonnegative(),
  acquired_at: z.string().datetime(),
  renewed_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  released_at: z.string().datetime().nullable(),
});
export type Lease = z.infer<typeof LeaseSchema>;

export const EventEnvelopeSchema = z.object({
  event_id: z.string(),
  schema_version: z.number().int().positive(),
  event_type: z.string(),
  repository_sequence: z.number().int().nonnegative(),
  occurred_at: z.string().datetime(),
  namespace_id: z.string(),
  repository_id: z.string().nullable(),
  workflow_id: z.string().nullable(),
  task_id: z.string().nullable(),
  attempt_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  workspace_session_id: z.string().nullable(),
  correlation_id: z.string().nullable(),
  causation_id: z.string().nullable(),
  idempotency_key: z.string().nullable(),
  payload: metadataSchema,
  metadata: metadataSchema,
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const INTEGRATION_STATES = [
  "queued",
  "claimed",
  "verifying",
  "ready",
  "conflicted",
  "stale",
  "integrated",
  "rejected",
  "failed",
] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];
export const IntegrationStateSchema = z.enum(INTEGRATION_STATES);

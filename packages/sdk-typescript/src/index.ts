export {
  GitameshClient,
  type GitameshClientOptions,
  type FetchLike,
  type RequiredResourceInput,
  type RegisterAgentInput,
  type RegisterAgentResult,
  type ListAgentsResult,
  type HeartbeatAgentResult,
  type CreateTaskInput,
  type CreateTaskResult,
  type ListTasksFilter,
  type ListTasksResult,
  type GetTaskResult,
  type ClaimTaskInput,
  type ClaimTaskResult,
  type HeartbeatTaskAttemptInput,
  type HeartbeatTaskAttemptResult,
  type CompleteTaskInput,
  type CompleteTaskResult,
  type FailTaskInput,
  type FailTaskResult,
  type CancelTaskResult,
  type ListClaimsFilter,
  type ListClaimsResult,
  type ReleaseClaimResult,
} from "./client.js";

export {
  GitameshApiError,
  GitameshConflictError,
  GitameshAuthError,
  GitameshNotFoundError,
  GitameshNetworkError,
} from "./errors.js";

export {
  subscribeToEvents,
  type SubscribeToEventsOptions,
  type EventSubscription,
  type StreamEvent,
  type WebSocketLike,
  type WebSocketCtor,
} from "./events.js";

export {
  startHeartbeatLoop,
  type HeartbeatLoopOptions,
  type HeartbeatLoopHandle,
  type HeartbeatSender,
} from "./heartbeat-loop.js";

// Re-exported for ergonomics: consumers building against this SDK's typed
// responses (e.g. `Task`, `Agent`, `TaskAttempt`) shouldn't need a direct
// `@gitamesh/protocol` dependency just to name these types.
export type {
  Agent,
  AgentState,
  AgentRuntime,
  Task,
  TaskState,
  TaskAttempt,
  AttemptState,
  ResourceClaim,
  ResourceType,
  ResourceMode,
  JoinPolicy,
  EventEnvelope,
  ProblemDetails,
} from "@gitamesh/protocol";

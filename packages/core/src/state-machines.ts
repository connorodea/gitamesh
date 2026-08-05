import {
  TASK_STATES,
  ATTEMPT_STATES,
  AGENT_STATES,
  INTEGRATION_STATES,
  type TaskState,
  type AttemptState,
  type AgentState,
  type IntegrationState,
} from "@gitamesh/protocol";

/**
 * Legal state-transition graphs.
 *
 * Each graph is a pure data structure (`Record<State, State[]>`) so it can
 * be inspected, tested, and rendered without executing any code. The
 * `canTransitionX` functions below are pure predicates — side-effect free,
 * no mutation, no I/O. Callers (the storage-adapter methods in
 * `packages/storage-sqlite`) are responsible for calling these BEFORE
 * mutating anything, and must not mutate if the predicate returns false.
 */

// ---------------------------------------------------------------------------
// Task state machine
// ---------------------------------------------------------------------------
//
//   pending ──────► queued ──────► claiming ──────► running ──┬──► completed
//      │               │               │                │    ├──► failed
//      │               │               │                │    ├──► blocked ─┐
//      │               │               │                │    │             │
//      │               │               │                │◄───┴─────────────┘
//      │               │               │                │
//      ▼               ▼               ▼                ▼
//   cancelled       cancelled      cancelled         cancelled
//
//   failed ───► queued (requeue for retry)
//   awaiting_approval ◄──► running   (approval gate mid-flight)
//   ANY non-terminal state ───► dead_letter (operator escape hatch)
//
// Terminal states: completed, cancelled, dead_letter. `failed` is
// near-terminal: it may be requeued (queued) or escalated (dead_letter),
// but it is not itself further "run".
export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  pending: ["queued", "cancelled", "dead_letter"],
  queued: ["claiming", "cancelled", "dead_letter"],
  claiming: ["running", "queued", "cancelled", "dead_letter"],
  running: [
    "completed",
    "failed",
    "blocked",
    "awaiting_approval",
    "queued",
    "cancelled",
    "dead_letter",
  ],
  blocked: ["running", "queued", "cancelled", "dead_letter"],
  awaiting_approval: ["running", "cancelled", "dead_letter", "completed"],
  completed: [],
  failed: ["queued", "dead_letter", "cancelled"],
  cancelled: [],
  dead_letter: [],
};

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Attempt state machine
// ---------------------------------------------------------------------------
//
//   created ──► leased ──► running ──┬──► completed
//                  │           │     ├──► failed
//                  │           │     ├──► cancelled
//                  │           │     ├──► expired
//                  │           │     └──► rejected_stale
//                  ├──► expired
//                  ├──► cancelled
//                  └──► rejected_stale
//
// Terminal: completed, failed, cancelled, expired, rejected_stale.
export const ATTEMPT_TRANSITIONS: Record<AttemptState, AttemptState[]> = {
  created: ["leased", "cancelled", "expired", "rejected_stale"],
  leased: ["running", "expired", "cancelled", "rejected_stale"],
  running: [
    "completed",
    "failed",
    "cancelled",
    "expired",
    "rejected_stale",
  ],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
  rejected_stale: [],
};

export function canTransitionAttempt(
  from: AttemptState,
  to: AttemptState,
): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Agent state machine
// ---------------------------------------------------------------------------
//
//   registered ──► online ──┬──► draining ──► offline
//                     │      ├──► offline
//                     │      └──► stale
//                     │
//   offline ◄────── stale ◄──────┘
//      │  ▲              │
//      ▼  │              ▼
//    online          revoked
//
// Terminal: revoked.
export const AGENT_TRANSITIONS: Record<AgentState, AgentState[]> = {
  registered: ["online", "revoked"],
  online: ["draining", "offline", "stale", "revoked"],
  draining: ["offline", "revoked"],
  offline: ["online", "stale", "revoked"],
  stale: ["online", "offline", "revoked"],
  revoked: [],
};

export function canTransitionAgent(from: AgentState, to: AgentState): boolean {
  return AGENT_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Integration state machine
// ---------------------------------------------------------------------------
//
//   queued ──► claimed ──► verifying ──┬──► ready ──► integrated
//      ▲           │            │      └──► conflicted ─┐
//      │           ▼            ▼                       │
//      │        stale        failed                     │
//      │           │            │                        │
//      └───────────┴────────────┴──── rejected / queued ◄┘
//
// Terminal: integrated, rejected. `failed` and `stale` may retry (queued).
export const INTEGRATION_TRANSITIONS: Record<
  IntegrationState,
  IntegrationState[]
> = {
  queued: ["claimed", "stale", "failed"],
  claimed: ["verifying", "stale", "failed"],
  verifying: ["ready", "conflicted", "failed"],
  ready: ["integrated", "stale", "failed"],
  conflicted: ["claimed", "stale", "failed", "rejected"],
  stale: ["queued", "rejected", "failed"],
  integrated: [],
  rejected: [],
  failed: ["queued", "rejected"],
};

export function canTransitionIntegration(
  from: IntegrationState,
  to: IntegrationState,
): boolean {
  return INTEGRATION_TRANSITIONS[from].includes(to);
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TASK_TRANSITIONS[state].length === 0;
}

export function isTerminalAttemptState(state: AttemptState): boolean {
  return ATTEMPT_TRANSITIONS[state].length === 0;
}

export function isTerminalAgentState(state: AgentState): boolean {
  return AGENT_TRANSITIONS[state].length === 0;
}

export function isTerminalIntegrationState(state: IntegrationState): boolean {
  return INTEGRATION_TRANSITIONS[state].length === 0;
}

// Note: TASK_STATES / ATTEMPT_STATES / AGENT_STATES / INTEGRATION_STATES
// are already re-exported from @gitamesh/protocol via packages/core's
// index.ts (`export * from "@gitamesh/protocol"`), so they are not
// re-declared here to avoid a duplicate-export collision.

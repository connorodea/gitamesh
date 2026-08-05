import type {
  Agent,
  Task,
  TaskAttempt,
  ResourceClaim,
  ResourceType,
  ResourceMode,
  JoinPolicy,
  ProblemDetails,
} from "@gitamesh/protocol";
import { toApiError, GitameshNetworkError } from "./errors.js";
import { subscribeToEvents } from "./events.js";
import type { SubscribeToEventsOptions, EventSubscription } from "./events.js";
import { startHeartbeatLoop as startHeartbeatLoopImpl } from "./heartbeat-loop.js";
import type { HeartbeatLoopHandle, HeartbeatLoopOptions } from "./heartbeat-loop.js";

export type FetchLike = typeof fetch;

export interface GitameshClientOptions {
  baseUrl: string;
  token?: string | null;
  /** Injectable `fetch` implementation. Defaults to global `fetch`. Inject a fake in tests to avoid a real network. */
  fetchImpl?: FetchLike;
}

export interface RequiredResourceInput {
  resourceType: ResourceType;
  resourceKey: string;
  mode: ResourceMode;
}

// --- agents ------------------------------------------------------------

export interface RegisterAgentInput {
  namespaceId?: string;
  displayName: string;
  runtime: string;
  version?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  /** Sent as `Idempotency-Key`. The daemon actually de-dupes on this for agent registration. */
  idempotencyKey?: string;
}
export interface RegisterAgentResult {
  agent: Agent;
  replayed: boolean;
}
export interface ListAgentsResult {
  agents: Agent[];
}
export interface HeartbeatAgentResult {
  agent: Agent;
}

// --- tasks ---------------------------------------------------------------

export interface CreateTaskInput {
  repositoryId: string;
  workflowId?: string;
  parentTaskId?: string | null;
  title: string;
  description?: string;
  priority?: number;
  requiredCapabilities?: string[];
  dependencies?: string[];
  joinPolicy?: JoinPolicy;
  baseSha?: string | null;
  branch?: string | null;
  deadlineAt?: string | null;
  /** Sent as `Idempotency-Key`. The daemon actually de-dupes on this for task creation. */
  idempotencyKey?: string;
}
export interface CreateTaskResult {
  task: Task;
  replayed: boolean;
}
export interface ListTasksFilter {
  repositoryId?: string;
  status?: string;
}
export interface ListTasksResult {
  tasks: Task[];
}
export interface GetTaskResult {
  task: Task;
}

export interface ClaimTaskInput {
  agentId: string;
  workspaceSessionId: string;
  requiredResources?: RequiredResourceInput[];
  /** Sent as `Idempotency-Key` AND threaded into `CoordinationEngine.claimTask`'s own idempotency handling. */
  idempotencyKey?: string;
}
export interface ClaimTaskResult {
  attempt: TaskAttempt;
  fencingToken: number;
  resourceClaims: ResourceClaim[];
  replayed: boolean;
}

export interface HeartbeatTaskAttemptInput {
  attemptId: string;
  fencingToken: number;
  leaseDurationMs?: number;
  /**
   * Sent as `Idempotency-Key` for consistency with every other mutating
   * method, but as of this daemon version `POST /v1/tasks/:id/heartbeat`
   * does not read the header at all (verified against
   * `apps/daemon/src/routes/tasks.ts`) — heartbeats are naturally
   * idempotent (repeating one just re-renews the lease), so there is
   * nothing for it to de-dupe.
   */
  idempotencyKey?: string;
}
export interface HeartbeatTaskAttemptResult {
  attempt: TaskAttempt;
  resourceClaims: ResourceClaim[];
}

export interface CompleteTaskInput {
  attemptId: string;
  fencingToken: number;
  result?: Record<string, unknown>;
  /**
   * Sent as `Idempotency-Key` for consistency, but not currently read by
   * `POST /v1/tasks/:id/complete` — that route relies instead on
   * `CoordinationEngine.completeAttempt`'s own attempt-terminal-status
   * check to detect a repeat call (see `packages/core/src/engine.ts`),
   * which does not consume a caller-supplied key.
   */
  idempotencyKey?: string;
}
export interface CompleteTaskResult {
  attempt: TaskAttempt;
  task: Task;
  result: Record<string, unknown> | undefined;
  replayed: boolean;
}

export interface FailTaskInput {
  attemptId: string;
  fencingToken: number;
  error: string;
  /** Sent as `Idempotency-Key` for consistency; not currently read by `POST /v1/tasks/:id/fail` (same as `completeTask`). */
  idempotencyKey?: string;
}
export interface FailTaskResult {
  attempt: TaskAttempt;
  task: Task;
  replayed: boolean;
}

export interface CancelTaskResult {
  task: Task;
}

// --- claims ----------------------------------------------------------------

export interface ListClaimsFilter {
  repositoryId?: string;
}
export interface ListClaimsResult {
  claims: ResourceClaim[];
}
export interface ReleaseClaimResult {
  released: boolean;
}

type QueryValue = string | number | boolean | undefined;

interface RequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
  auth?: boolean;
  idempotencyKey?: string;
}

/**
 * Typed, injectable client for the Gitamesh daemon's HTTP + WebSocket API
 * (spec section 15). See `apps/daemon/README.md` for the authoritative
 * route table this wraps, and `docs/adr/0001-protocol-first-storage-agnostic-core.md`
 * for why the wire contract lives in `@gitamesh/protocol` rather than
 * being duplicated here.
 *
 * `POST /v1/repositories` deliberately has no wrapper method: as of this
 * daemon version that route does not exist yet (see the daemon README's
 * "What's NOT implemented" section and `packages/cli/src/client.ts`'s own
 * note on the same gap). Add `registerRepository` here once the daemon
 * grows the route.
 */
export class GitameshClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(options: GitameshClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async healthz(): Promise<{ status: string }> {
    return this.request("GET", "/healthz", { auth: false });
  }

  // --- agents --------------------------------------------------------------

  async registerAgent(input: RegisterAgentInput): Promise<RegisterAgentResult> {
    return this.request("POST", "/v1/agents", {
      body: {
        namespace_id: input.namespaceId,
        display_name: input.displayName,
        runtime: input.runtime,
        version: input.version,
        capabilities: input.capabilities,
        metadata: input.metadata,
      },
      idempotencyKey: input.idempotencyKey,
    });
  }

  async listAgents(): Promise<ListAgentsResult> {
    return this.request("GET", "/v1/agents");
  }

  async heartbeatAgent(agentId: string, opts?: { idempotencyKey?: string }): Promise<HeartbeatAgentResult> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/heartbeat`, {
      idempotencyKey: opts?.idempotencyKey,
    });
  }

  // --- tasks -----------------------------------------------------------------

  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    return this.request("POST", "/v1/tasks", {
      body: {
        repository_id: input.repositoryId,
        workflow_id: input.workflowId,
        parent_task_id: input.parentTaskId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        required_capabilities: input.requiredCapabilities,
        dependencies: input.dependencies,
        join_policy: input.joinPolicy,
        base_sha: input.baseSha,
        branch: input.branch,
        deadline_at: input.deadlineAt,
      },
      idempotencyKey: input.idempotencyKey,
    });
  }

  async listTasks(filter?: ListTasksFilter): Promise<ListTasksResult> {
    return this.request("GET", "/v1/tasks", {
      query: { repositoryId: filter?.repositoryId, status: filter?.status },
    });
  }

  async getTask(taskId: string): Promise<GetTaskResult> {
    return this.request("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  /**
   * Atomically claims a task for an agent + workspace session. Returns the
   * new attempt and its fencing token on success, or throws
   * `GitameshConflictError` (carrying the RFC 9457 body) on a 409 —
   * another live attempt already holds the task, or a required resource
   * is held by someone else.
   */
  async claimTask(taskId: string, input: ClaimTaskInput): Promise<ClaimTaskResult> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/claim`, {
      body: {
        agentId: input.agentId,
        workspaceSessionId: input.workspaceSessionId,
        requiredResources: input.requiredResources ?? [],
      },
      idempotencyKey: input.idempotencyKey,
    });
  }

  async heartbeatTaskAttempt(
    taskId: string,
    input: HeartbeatTaskAttemptInput,
  ): Promise<HeartbeatTaskAttemptResult> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/heartbeat`, {
      body: {
        attemptId: input.attemptId,
        fencingToken: input.fencingToken,
        leaseDurationMs: input.leaseDurationMs,
      },
      idempotencyKey: input.idempotencyKey,
    });
  }

  async completeTask(taskId: string, input: CompleteTaskInput): Promise<CompleteTaskResult> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/complete`, {
      body: {
        attemptId: input.attemptId,
        fencingToken: input.fencingToken,
        result: input.result,
      },
      idempotencyKey: input.idempotencyKey,
    });
  }

  async failTask(taskId: string, input: FailTaskInput): Promise<FailTaskResult> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/fail`, {
      body: {
        attemptId: input.attemptId,
        fencingToken: input.fencingToken,
        error: input.error,
      },
      idempotencyKey: input.idempotencyKey,
    });
  }

  async cancelTask(taskId: string, opts?: { idempotencyKey?: string }): Promise<CancelTaskResult> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      idempotencyKey: opts?.idempotencyKey,
    });
  }

  /**
   * Starts an interval-driven heartbeat loop for a claimed attempt.
   * Failures (e.g. a `GitameshConflictError` when the lease was
   * superseded) are routed to `options.onError`, never thrown into the
   * interval — see `heartbeat-loop.ts` for the full rationale. Call
   * `.stop()` on the returned handle to cancel the loop cleanly.
   */
  startHeartbeatLoop(
    taskId: string,
    attemptId: string,
    fencingToken: number,
    intervalMs: number,
    options?: HeartbeatLoopOptions,
  ): HeartbeatLoopHandle {
    return startHeartbeatLoopImpl(
      () =>
        this.heartbeatTaskAttempt(taskId, {
          attemptId,
          fencingToken,
          leaseDurationMs: options?.leaseDurationMs,
          idempotencyKey: options?.idempotencyKey,
        }),
      intervalMs,
      options,
    );
  }

  // --- claims ------------------------------------------------------------------

  async listClaims(filter?: ListClaimsFilter): Promise<ListClaimsResult> {
    return this.request("GET", "/v1/claims", { query: { repositoryId: filter?.repositoryId } });
  }

  async releaseClaim(claimId: string, opts?: { idempotencyKey?: string }): Promise<ReleaseClaimResult> {
    return this.request("POST", `/v1/claims/${encodeURIComponent(claimId)}/release`, {
      idempotencyKey: opts?.idempotencyKey,
    });
  }

  // --- events / WebSocket stream -------------------------------------------------

  /**
   * Subscribes to `GET /v1/events/stream`, replaying from `since` (if
   * given) with no gaps, and — if `autoReconnect` (default `true`) —
   * automatically reconnecting from the last-seen cursor on disconnect.
   * See `events.ts` for the full at-least-once/reconnect contract.
   */
  subscribeToEvents(options: SubscribeToEventsOptions): EventSubscription {
    return subscribeToEvents(this.baseUrl, this.token, options);
  }

  // --- internals -----------------------------------------------------------------

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const { body, query, auth = true, idempotencyKey } = opts;
    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new GitameshNetworkError(
        `daemon unreachable at ${this.baseUrl}: ${error instanceof Error ? error.message : "unknown error"}`,
        { cause: error },
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isJson = contentType.includes("json");
    const payload = isJson ? await response.json().catch(() => undefined) : undefined;

    if (!response.ok) {
      const problem = isJson ? (payload as ProblemDetails) : undefined;
      throw toApiError(response.status, problem, method, path);
    }

    return payload as T;
  }
}

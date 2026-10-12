/**
 * TEMPORARY — replace with `@gitamesh/sdk-typescript` once it is merged.
 *
 * `packages/mcp-server` is specified to depend on `@gitamesh/sdk-typescript`
 * for talking to the daemon. As of this package's initial implementation,
 * `packages/sdk-typescript` does not exist in this working tree (another
 * agent is building it concurrently, uncommitted, in this same repo). Per
 * this task's own instruction, rather than block on that package landing,
 * this file is a small, internal, private HTTP client written directly
 * against `apps/daemon`'s documented API (`apps/daemon/README.md` + the
 * route source under `apps/daemon/src/routes/*.ts`). It is intentionally
 * NOT a full SDK: no retries, no pagination helpers beyond what the daemon
 * itself returns, no schema-generation tooling — just enough surface for
 * this package's MCP tools to call the daemon and be tested.
 *
 * When `@gitamesh/sdk-typescript` lands with a stable exported client, swap
 * this whole file out for a `workspace:*` dependency on it and delete this
 * one. Every call site in `src/tools/*.ts` only touches the small interface
 * below, so that swap should be localized to this file plus the tool
 * modules' imports.
 */

export type FetchLike = typeof fetch;

export interface DaemonClientOptions {
  baseUrl: string;
  token?: string | null;
  fetchImpl?: FetchLike;
}

export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  [key: string]: unknown;
}

/**
 * Thrown only for genuinely unexpected situations (the caller passed a
 * malformed URL, JSON parsing of a *successful* response blew up, etc).
 * Every *expected* daemon-level failure (404, 409, 400, network
 * unreachable) is surfaced as a normal return value via `DaemonResult`, not
 * a throw — see the module doc on `packages/mcp-server/src/tools/*.ts` for
 * why: MCP tool responses must be structured, and a calling AI agent can't
 * react sensibly to an opaque thrown exception.
 */
export class InternalClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalClientError";
  }
}

export type DaemonResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; unreachable: true; detail: string }
  | { ok: false; unreachable: false; status: number; problem: ProblemDetails };

export interface ListQuery {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Minimal daemon HTTP client. Every method returns a `DaemonResult` instead
 * of throwing on non-2xx responses, so callers (the MCP tool handlers) can
 * turn a 409 (claim conflict, stale token, etc.) into a structured tool
 * result rather than propagating a thrown error to the MCP transport.
 */
export class DaemonClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(options: DaemonClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  healthz(): Promise<DaemonResult<{ status: string }>> {
    return this.request("GET", "/healthz", { auth: false });
  }

  // --- repositories ---------------------------------------------------------

  registerRepository(
    body: Record<string, unknown>,
  ): Promise<DaemonResult<{ repository: unknown; replayed: boolean }>> {
    return this.request("POST", "/v1/repositories", { body });
  }

  listRepositories(): Promise<DaemonResult<{ repositories: unknown[] }>> {
    return this.request("GET", "/v1/repositories");
  }

  // --- agents ---------------------------------------------------------------

  registerAgent(body: {
    namespace_id?: string;
    display_name: string;
    runtime: string;
    version?: string;
    capabilities?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<DaemonResult<{ agent: unknown; replayed: boolean }>> {
    return this.request("POST", "/v1/agents", { body });
  }

  listAgents(): Promise<DaemonResult<{ agents: unknown[] }>> {
    return this.request("GET", "/v1/agents");
  }

  // --- tasks ------------------------------------------------------------------

  createTask(body: Record<string, unknown>): Promise<DaemonResult<{ task: unknown; replayed: boolean }>> {
    return this.request("POST", "/v1/tasks", { body });
  }

  listTasks(query?: ListQuery): Promise<DaemonResult<{ tasks: unknown[] }>> {
    return this.request("GET", "/v1/tasks", { query });
  }

  getTask(
    taskId: string,
  ): Promise<DaemonResult<{ task: unknown; notes: unknown[]; revisions: unknown[] }>> {
    return this.request("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  claimTask(
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<
    DaemonResult<{ attempt: unknown; fencingToken: number; resourceClaims: unknown[]; replayed: boolean }>
  > {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/claim`, { body });
  }

  heartbeatTask(
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<DaemonResult<{ attempt: unknown; resourceClaims: unknown[] }>> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/heartbeat`, { body });
  }

  completeTask(
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<DaemonResult<{ attempt: unknown; task: unknown; result: unknown; replayed: boolean }>> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/complete`, { body });
  }

  failTask(
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<DaemonResult<{ attempt: unknown; task: unknown; replayed: boolean }>> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/fail`, { body });
  }

  updateTask(
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<DaemonResult<{ task: unknown; revision: unknown }>> {
    return this.request("PATCH", `/v1/tasks/${encodeURIComponent(taskId)}`, { body });
  }

  addTaskNote(
    taskId: string,
    body: { agent_id: string; body: string },
  ): Promise<DaemonResult<{ note: unknown }>> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/notes`, { body });
  }

  // --- messages -----------------------------------------------------------------

  sendMessage(body: Record<string, unknown>): Promise<DaemonResult<{ message: unknown }>> {
    return this.request("POST", "/v1/messages", { body });
  }

  listMessages(query?: ListQuery): Promise<DaemonResult<{ messages: unknown[] }>> {
    return this.request("GET", "/v1/messages", { query });
  }

  ackMessage(
    messageId: string,
    body: { agent_id: string },
  ): Promise<DaemonResult<{ message: unknown; already_acked: boolean }>> {
    return this.request("POST", `/v1/messages/${encodeURIComponent(messageId)}/ack`, { body });
  }

  // --- path locks -----------------------------------------------------------------

  acquireLock(body: Record<string, unknown>): Promise<DaemonResult<{ lock: unknown }>> {
    return this.request("POST", "/v1/locks", { body });
  }

  listLocks(query?: ListQuery): Promise<DaemonResult<{ locks: unknown[] }>> {
    return this.request("GET", "/v1/locks", { query });
  }

  heartbeatLock(
    lockId: string,
    body: { agent_id: string; ttl_seconds?: number },
  ): Promise<DaemonResult<{ lock: unknown }>> {
    return this.request("POST", `/v1/locks/${encodeURIComponent(lockId)}/heartbeat`, { body });
  }

  releaseLock(lockId: string, body: { agent_id: string }): Promise<DaemonResult<{ lock: unknown }>> {
    return this.request("POST", `/v1/locks/${encodeURIComponent(lockId)}/release`, { body });
  }

  // --- claims -----------------------------------------------------------------

  listClaims(query?: ListQuery): Promise<DaemonResult<{ claims: unknown[] }>> {
    return this.request("GET", "/v1/claims", { query });
  }

  // --- events -------------------------------------------------------------------

  /**
   * `GET /v1/events` — a one-shot cursor page, NOT the WebSocket stream.
   * See `src/tools/watch-events.ts` for why an MCP tool call uses this
   * request/response route instead of `/v1/events/stream`.
   */
  listEventsSince(query?: ListQuery): Promise<DaemonResult<{ events: unknown[]; nextCursor: number }>> {
    return this.request("GET", "/v1/events", { query });
  }

  // --- internals ----------------------------------------------------------------

  private buildUrl(path: string, query?: ListQuery): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    opts: { body?: unknown; query?: ListQuery; auth?: boolean } = {},
  ): Promise<DaemonResult<T>> {
    const { body, query, auth = true } = opts;
    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (auth && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      return {
        ok: false,
        unreachable: true,
        detail: `daemon unreachable at ${this.baseUrl} — is it running?`,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isJson = contentType.includes("json");
    const payload = isJson ? await response.json().catch(() => undefined) : undefined;

    if (!response.ok) {
      const problem: ProblemDetails = (isJson ? (payload as ProblemDetails) : undefined) ?? {
        title: response.statusText,
        status: response.status,
      };
      return { ok: false, unreachable: false, status: response.status, problem };
    }

    return { ok: true, status: response.status, data: payload as T };
  }
}

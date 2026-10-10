/**
 * A small, injectable HTTP client for talking to the Gitamesh daemon.
 *
 * Request bodies/queries must match the zod schemas in
 * `apps/daemon/src/routes/*.ts` (table in `apps/daemon/README.md`). Note the
 * daemon is NOT uniform: create routes take snake_case, while
 * claim/heartbeat/complete/fail and the list filters take camelCase.
 * `apps/daemon/test/cli-contract.test.ts` runs this CLI against a real
 * in-memory daemon to keep the two in step. `/v1/repositories` does not
 * exist in the daemon yet, so `registerRepository` will 404.
 *
 * `fetchImpl` is injectable so unit tests can supply a fake `fetch`
 * instead of hitting a real network / real daemon.
 */
export type FetchLike = typeof fetch;

export interface GitameshClientOptions {
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

export class GitameshClientError extends Error {
  readonly baseUrl: string;
  readonly status?: number;
  readonly problem?: ProblemDetails;
  /** True when the request never reached the server (network-level failure). */
  readonly unreachable: boolean;

  constructor(params: {
    message: string;
    baseUrl: string;
    status?: number;
    problem?: ProblemDetails;
    unreachable: boolean;
  }) {
    super(params.message);
    this.name = "GitameshClientError";
    this.baseUrl = params.baseUrl;
    this.status = params.status;
    this.problem = params.problem;
    this.unreachable = params.unreachable;
  }
}

export interface ListQuery {
  [key: string]: string | number | boolean | undefined;
}

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

  // --- repositories -------------------------------------------------------

  async registerRepository(body: {
    namespace_id?: string;
    display_name: string;
    git_common_dir: string;
    default_branch: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown> {
    return this.request("POST", "/v1/repositories", { body });
  }

  // --- agents --------------------------------------------------------------

  async registerAgent(body: {
    namespace_id?: string;
    display_name: string;
    runtime: string;
    version?: string;
    capabilities?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<unknown> {
    return this.request("POST", "/v1/agents", { body });
  }

  async listAgents(): Promise<unknown> {
    return this.request("GET", "/v1/agents");
  }

  async heartbeatAgent(agentId: string): Promise<unknown> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/heartbeat`);
  }

  // --- tasks ----------------------------------------------------------------

  async createTask(body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/v1/tasks", { body });
  }

  async listTasks(query?: ListQuery): Promise<unknown> {
    return this.request("GET", "/v1/tasks", { query });
  }

  async getTask(taskId: string): Promise<unknown> {
    return this.request("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  async claimTask(taskId: string, body?: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/claim`, { body });
  }

  async heartbeatTask(taskId: string, body?: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/heartbeat`, { body });
  }

  async completeTask(taskId: string, body?: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/complete`, { body });
  }

  async failTask(taskId: string, body?: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/fail`, { body });
  }

  async cancelTask(taskId: string, body?: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { body });
  }

  async updateTask(taskId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("PATCH", `/v1/tasks/${encodeURIComponent(taskId)}`, { body });
  }

  async addTaskNote(taskId: string, body: { agent_id: string; body: string }): Promise<unknown> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/notes`, { body });
  }

  // --- messages -------------------------------------------------------------

  async sendMessage(body: {
    from: string;
    to: string;
    body: string;
    repository_id?: string | null;
    task_id?: string | null;
  }): Promise<unknown> {
    return this.request("POST", "/v1/messages", { body });
  }

  async listMessages(query?: ListQuery): Promise<unknown> {
    return this.request("GET", "/v1/messages", { query });
  }

  async ackMessage(messageId: string, body: { agent_id: string }): Promise<unknown> {
    return this.request("POST", `/v1/messages/${encodeURIComponent(messageId)}/ack`, { body });
  }

  // --- path locks -------------------------------------------------------------

  async acquireLock(body: {
    agent_id: string;
    repository_id: string;
    paths: string[];
    task_id?: string | null;
    ttl_seconds?: number;
  }): Promise<unknown> {
    return this.request("POST", "/v1/locks", { body });
  }

  async listLocks(query?: ListQuery): Promise<unknown> {
    return this.request("GET", "/v1/locks", { query });
  }

  async heartbeatLock(
    lockId: string,
    body: { agent_id: string; ttl_seconds?: number },
  ): Promise<unknown> {
    return this.request("POST", `/v1/locks/${encodeURIComponent(lockId)}/heartbeat`, { body });
  }

  async releaseLock(lockId: string, body: { agent_id: string }): Promise<unknown> {
    return this.request("POST", `/v1/locks/${encodeURIComponent(lockId)}/release`, { body });
  }

  // --- resource claims --------------------------------------------------------

  async listClaims(query?: ListQuery): Promise<unknown> {
    return this.request("GET", "/v1/claims", { query });
  }

  async releaseClaim(claimId: string): Promise<unknown> {
    return this.request("POST", `/v1/claims/${encodeURIComponent(claimId)}/release`);
  }

  // --- internals -------------------------------------------------------------

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
  ): Promise<T> {
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
    } catch (error) {
      throw new GitameshClientError({
        message: `daemon unreachable at ${this.baseUrl} — is it running? (gitamesh doctor)`,
        baseUrl: this.baseUrl,
        unreachable: true,
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isJson = contentType.includes("json");
    const payload = isJson ? await response.json().catch(() => undefined) : undefined;

    if (!response.ok) {
      const problem = (isJson ? (payload as ProblemDetails) : undefined) ?? undefined;
      const detail = summarizeProblem(problem) ?? response.statusText;
      throw new GitameshClientError({
        message: `${method} ${path} failed (${response.status}): ${detail}`,
        baseUrl: this.baseUrl,
        status: response.status,
        problem,
        unreachable: false,
      });
    }

    return payload as T;
  }
}

/**
 * Flattens a problem-details body to ONE line, so the failure survives
 * `| tail -1` / log truncation. The daemon's 400s put a pretty-printed zod
 * issue array in `detail`; that is rendered as `field: message; ...`.
 */
function summarizeProblem(problem: ProblemDetails | undefined): string | undefined {
  if (!problem) return undefined;
  const title = problem.title;
  const detail = problem.detail;
  if (detail === undefined) return title;

  let summary = detail.replace(/\s+/g, " ").trim();
  try {
    const issues: unknown = JSON.parse(detail);
    if (Array.isArray(issues) && issues.length > 0) {
      summary = issues
        .map((issue: { path?: unknown[]; message?: string }) => {
          const field = Array.isArray(issue.path) ? issue.path.join(".") : "";
          const message = issue.message ?? "invalid";
          return field ? `${field}: ${message}` : message;
        })
        .join("; ");
    }
  } catch {
    // Not JSON — a plain-text detail, already collapsed to one line above.
  }
  return title && title !== summary ? `${title} — ${summary}` : summary;
}

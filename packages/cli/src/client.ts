/**
 * A small, injectable HTTP client for talking to the Gitamesh daemon.
 *
 * Every method here calls a route documented in the project's master spec
 * / this package's README. As of writing, `apps/daemon` has ONLY
 * `/healthz`, `/readyz`, `/metrics`, and the `/v1/agents*` routes
 * committed — `/v1/repositories`, `/v1/tasks*`, and `/v1/claims*` do not
 * exist yet (they may be landing concurrently from another agent working
 * on `apps/daemon`). Those methods are written against the documented
 * route SHAPE from the spec so the CLI compiles and its argument-parsing/
 * output-formatting logic is fully testable today; they will 404 against
 * a daemon that hasn't grown those routes yet. `gitamesh doctor` surfaces
 * that gap plainly rather than pretending it works.
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

  // --- resource claims / locks ----------------------------------------------

  async listClaims(query?: ListQuery): Promise<unknown> {
    return this.request("GET", "/v1/claims", { query });
  }

  async releaseClaim(claimId: string): Promise<unknown> {
    return this.request("POST", `/v1/claims/${encodeURIComponent(claimId)}/release`);
  }

  // --- agent check-ins ------------------------------------------------------

  async sendMessage(body: Record<string, unknown>, idempotencyKey?: string): Promise<unknown> {
    return this.request("POST", "/v1/messages", { body, idempotencyKey });
  }

  async listMessages(query: ListQuery): Promise<unknown> {
    return this.request("GET", "/v1/messages", { query });
  }

  async acknowledgeMessage(messageId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/v1/messages/${encodeURIComponent(messageId)}/ack`, { body });
  }

  async reportProgress(taskId: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<unknown> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/progress`, { body, idempotencyKey });
  }

  async getProgress(taskId: string, query: ListQuery): Promise<unknown> {
    return this.request("GET", `/v1/tasks/${encodeURIComponent(taskId)}/progress`, { query });
  }

  async setDependencies(taskId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/dependencies`, { body });
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
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; query?: ListQuery; auth?: boolean; idempotencyKey?: string } = {},
  ): Promise<T> {
    const { body, query, auth = true } = opts;
    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
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
      const detail = problem?.detail ?? problem?.title ?? response.statusText;
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

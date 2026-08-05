import type { ProblemDetails } from "@gitamesh/protocol";

/**
 * Base class for every error the SDK throws for a non-2xx HTTP response
 * from the daemon. `problem` carries the parsed RFC 9457 problem-details
 * body when the daemon provided one (it always does for its own errors —
 * see `apps/daemon/src/problem.ts` — but a reverse proxy or an
 * unexpected non-JSON response could still leave it undefined).
 */
export class GitameshApiError extends Error {
  readonly status: number;
  readonly problem?: ProblemDetails;

  constructor(message: string, status: number, problem?: ProblemDetails) {
    super(message);
    this.name = "GitameshApiError";
    this.status = status;
    this.problem = problem;
  }
}

/** 409 — a claim/task-state conflict (e.g. `task-already-claimed`, `resource-conflict`, `stale-attempt-token`). */
export class GitameshConflictError extends GitameshApiError {
  constructor(message: string, problem?: ProblemDetails) {
    super(message, 409, problem);
    this.name = "GitameshConflictError";
  }
}

/**
 * 401 (missing/invalid/expired/revoked token) or 403 (valid token,
 * missing scope). Kept as one class with a `.status` discriminator
 * rather than two, because the daemon's problem-details bodies for both
 * share the same shape (`type` ends in `/unauthorized` or `/forbidden`)
 * and callers overwhelmingly just want to know "auth failed, go fix my
 * token/scopes" rather than branch on which of the two it was.
 */
export class GitameshAuthError extends GitameshApiError {
  constructor(message: string, status: 401 | 403, problem?: ProblemDetails) {
    super(message, status, problem);
    this.name = "GitameshAuthError";
  }
}

/** 404 — no such agent/task/claim. */
export class GitameshNotFoundError extends GitameshApiError {
  constructor(message: string, problem?: ProblemDetails) {
    super(message, 404, problem);
    this.name = "GitameshNotFoundError";
  }
}

/**
 * The request never reached the daemon at all (connection refused, DNS
 * failure, the daemon process is down, etc.) — as opposed to
 * `GitameshApiError`, which means the daemon responded with an error
 * status. There is no HTTP status code to report here.
 */
export class GitameshNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitameshNetworkError";
  }
}

/** Maps a daemon HTTP error response to the appropriate typed error class. */
export function toApiError(
  status: number,
  problem: ProblemDetails | undefined,
  method: string,
  path: string,
): GitameshApiError {
  const detail = problem?.detail ?? problem?.title ?? `HTTP ${status}`;
  const message = `${method} ${path} failed (${status}): ${detail}`;
  if (status === 409) return new GitameshConflictError(message, problem);
  if (status === 401 || status === 403) return new GitameshAuthError(message, status, problem);
  if (status === 404) return new GitameshNotFoundError(message, problem);
  return new GitameshApiError(message, status, problem);
}

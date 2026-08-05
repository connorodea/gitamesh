# @gitamesh/sdk

A typed, injectable TypeScript client for `apps/daemon`'s HTTP +
WebSocket API. This is the polished, publicly-exported counterpart to
`packages/cli/src/client.ts` (the CLI's own hand-rolled client) — same
proven integration knowledge (bearer-token auth, RFC 9457 problem
details, `Idempotency-Key`, fencing tokens, cursor-based WebSocket
reconnect), typed and packaged for reuse by anything else that wants to
talk to a Gitamesh daemon (an MCP server, a custom orchestrator, tests).

## Quickstart

```ts
import { GitameshClient, GitameshConflictError } from "@gitamesh/sdk";

const client = new GitameshClient({
  baseUrl: "http://127.0.0.1:8787",
  token: process.env.GITAMESH_TOKEN,
});

// 1. Register an agent.
const { agent } = await client.registerAgent({
  displayName: "worker-1",
  runtime: "claude-code",
});

// 2. Create a task.
const { task } = await client.createTask({
  repositoryId: "repo_1",
  title: "Refactor the parser",
  idempotencyKey: crypto.randomUUID(), // safe to retry this exact call
});

// 3. Claim it atomically.
let attempt;
let fencingToken;
try {
  const claimed = await client.claimTask(task.task_id, {
    agentId: agent.agent_id,
    workspaceSessionId: "ws_1",
    requiredResources: [{ resourceType: "path", resourceKey: "src/parser.ts", mode: "write" }],
  });
  attempt = claimed.attempt;
  fencingToken = claimed.fencingToken;
} catch (err) {
  if (err instanceof GitameshConflictError) {
    console.log("someone else already holds this task/resource:", err.problem);
  }
  throw err;
}

// 4. Heartbeat the lease while work is in progress.
const heartbeat = client.startHeartbeatLoop(task.task_id, attempt.attempt_id, fencingToken, 10_000, {
  onError: (error) => console.error("heartbeat failed — lease may be lost:", error),
});

// ... do the work ...
heartbeat.stop();

// 5. Report the outcome.
await client.completeTask(task.task_id, {
  attemptId: attempt.attempt_id,
  fencingToken,
  result: { filesChanged: 3 },
});

// 6. Subscribe to the event stream (gap-free, auto-reconnecting).
const sub = client.subscribeToEvents({
  onEvent: (event) => console.log(event.event_type, event),
  onDisconnect: (info) => console.warn("stream disconnected", info),
});
// ... later ...
sub.close();
```

## Testing without a real daemon

Every method routes through an injectable `fetchImpl` (defaults to
global `fetch`), and `subscribeToEvents` takes an injectable `wsImpl`
constructor (defaults to `globalThis.WebSocket`). Inject a fake for both
in your own tests — see `test/support/fake-fetch.ts` and
`test/support/fake-websocket.ts` in this package for the pattern this
SDK's own test suite uses (mirrors `packages/cli/test/support/fake-fetch.ts`).

```ts
const client = new GitameshClient({ baseUrl: "http://x", fetchImpl: myFakeFetch });
```

## Idempotency-Key mechanism (read this before assuming)

The daemon's idempotency convention is a single HTTP header,
**`Idempotency-Key`** — never a body field (see
`apps/daemon/src/idempotency.ts` and `apps/daemon/README.md`). Every
mutating SDK method accepts an optional `idempotencyKey` and sends it as
that header for a consistent single API surface. However, **not every
route actually reads the header today** — verified directly against
`apps/daemon/src/routes/*.ts`:

| Method | Header consumed by the daemon? |
|---|---|
| `registerAgent` | **Yes** — de-duped via `withIdempotency` against a generic idempotency-key table. |
| `createTask` | **Yes** — same mechanism. |
| `claimTask` | **Yes** — threaded straight into `CoordinationEngine.claimTask`'s own `idempotencyKey` param; a repeat call with the same key replays the same attempt. |
| `heartbeatTaskAttempt` | No — the route never reads the header. Heartbeats are naturally idempotent (repeating one just re-renews the lease), so nothing is lost. |
| `completeTask` / `failTask` | No — these routes rely on `CoordinationEngine`'s own attempt-terminal-status check to detect a repeat call, which does not consume a caller-supplied key. |
| `cancelTask` | No — the route never reads the header. |
| `heartbeatAgent` / `releaseClaim` | No — these routes never read the header. |

The SDK still sends the header uniformly for forward compatibility (if
the daemon grows idempotency handling for the remaining routes, no SDK
change is needed), but don't assume a retried `completeTask`/`failTask`/
`cancelTask` call is deduped server-side today — it isn't.

## WebSocket reconnect / at-least-once semantics

`subscribeToEvents` connects to `GET /v1/events/stream?since=<cursor>`.
Verified against `apps/daemon/test/daemon.test.ts`'s
"streams task lifecycle events live, then replays with no gaps on
reconnect" test and `apps/daemon/src/events-bus.ts`'s own documentation:

- Every delivered event carries a `cursor` field. The client tracks the
  cursor of the last event it received.
- If `autoReconnect` (default `true`), a disconnect (network drop, daemon
  restart, etc.) triggers a reconnect after `reconnectDelayMs` (default
  1000ms) using `?since=<lastCursor>`, which replays anything appended
  while disconnected — **nothing is ever skipped**.
- Delivery is **at-least-once**: reconnecting with a cursor equal to
  (not past) the last event fully processed may redeliver that boundary
  event a second time. Duplicates across a reconnect are acceptable —
  this matches the daemon's own documented behavior. Treat `event_id` as
  a dedupe key if your consumer needs exactly-once processing.
- The daemon's WebSocket upgrade cannot read the `Authorization` header
  from a browser `WebSocket` client, so this SDK always authenticates the
  stream via the `?token=` query-param fallback the daemon documents for
  exactly this reason (`apps/daemon/src/auth.ts`).

## What's NOT wrapped

- **`POST /v1/repositories`** — this route does not exist in
  `apps/daemon` yet (see the daemon's own README, "What's NOT
  implemented", and `packages/cli/src/client.ts`'s matching note). No
  `registerRepository` method exists here either; add one once the
  daemon grows the route.
- **Postgres / multi-process daemon deployments** — this SDK just talks
  HTTP/WebSocket to whatever daemon is at `baseUrl`; it has no opinion on
  how that daemon is deployed.

## Design notes

- **Heartbeat-loop failure handling**: `startHeartbeatLoop`'s failures go
  to `options.onError`, never thrown into the interval — an uncaught
  rejection inside a `setInterval` callback has no well-defined place to
  land. This lets a caller decide what a heartbeat failure means (e.g. a
  `GitameshConflictError` for a stale fencing token means the lease was
  superseded and the caller should stop working) without the loop making
  that policy call itself. See `src/heartbeat-loop.ts`.
- **Typed errors**: `GitameshConflictError` (409), `GitameshAuthError`
  (401 or 403, kept as one class with a `.status` discriminator since
  both share the same problem-details shape and callers mostly just want
  "auth failed"), `GitameshNotFoundError` (404), and
  `GitameshNetworkError` (the request never reached the daemon at all —
  no HTTP status to report). All API errors carry the parsed RFC 9457
  problem-details body (`.problem`) where the daemon provided one. See
  `src/errors.ts`.

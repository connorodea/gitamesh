# @gitamesh/daemon

The Gitamesh coordination daemon: a Fastify HTTP/WebSocket API in front
of `@gitamesh/core`'s `CoordinationEngine`, backed by the embedded
`@gitamesh/storage-sqlite` adapter (`better-sqlite3`, WAL mode).

This is a **single-process, embedded-SQLite** daemon for this milestone
— see `docs/adr/0001-protocol-first-storage-agnostic-core.md` and
`packages/storage-sqlite/src/schema.ts` for why. Multi-process
production deployment is expected to land with a future Postgres
storage adapter implementing the same `StorageAdapter` interface; this
daemon's route/auth/observability layer would not need to change.

## Running locally

```bash
# From the repo root, after `pnpm install`:
pnpm --filter @gitamesh/daemon dev        # tsx watch — auto-restarts on change
pnpm --filter @gitamesh/daemon build      # tsc -> dist/
pnpm --filter @gitamesh/daemon start      # node dist/index.js
pnpm --filter @gitamesh/daemon typecheck
pnpm --filter @gitamesh/daemon test       # vitest, Fastify .inject() + a real ws client
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `GITAMESH_DB_PATH` | `./gitamesh.db` | SQLite file path. Set to `:memory:` for an ephemeral in-memory database. |
| `GITAMESH_BIND_HOST` | `127.0.0.1` | Set to `0.0.0.0` to listen on all interfaces. **Secure-by-default**: loopback only unless explicitly opted into. Production TLS/remote exposure is handled by a reverse proxy (Caddy) in front of this daemon, not by the daemon itself. |
| `GITAMESH_PORT` | `8787` | Listen port. |
| `LOG_LEVEL` | `info` | Pino log level. |

## Minting a bootstrap admin token

Every route except `/healthz` and `/readyz` requires a bearer token (see
Auth below). To get one for local development:

```bash
# Option A: print one admin-scoped token at daemon startup (shown ONCE):
node dist/index.js --bootstrap-admin-token
# or during dev:
pnpm --filter @gitamesh/daemon dev -- --bootstrap-admin-token

# Option B: mint a token directly against a db file without starting the daemon,
# with whichever scopes you want:
pnpm --filter @gitamesh/daemon mint-token -- --db ./gitamesh.db --scopes admin
pnpm --filter @gitamesh/daemon mint-token -- --db ./gitamesh.db --scopes task:read,events:read
```

Only the token's SHA-256 hash is ever persisted (`tokens` table in
`packages/storage-sqlite/src/schema.ts`); the raw value is shown exactly
once and is not recoverable afterwards. This is a **dev/bootstrap
convenience**, not a production secret-management tool — there is no
token-rotation UI, audit trail beyond `created_at`/`revoked_at`, or
multi-tenant issuance flow yet.

## Routes

All request/response bodies are JSON. All errors follow [RFC 9457
Problem Details](https://www.rfc-editor.org/rfc/rfc9457) with
`Content-Type: application/problem+json`.

| Method & path | Auth scope | Notes |
|---|---|---|
| `GET /healthz` | none | Liveness. |
| `GET /readyz` | none | Readiness — runs a trivial `SELECT 1` against storage. |
| `GET /metrics` | `admin` | Prometheus text exposition format. |
| `POST /v1/agents` | `agent:register` | Registers an agent. Idempotency-Key aware. |
| `GET /v1/agents` | `repository:read` | Lists all agents. (No dedicated `agent:read` scope exists in the spec's scope list — `repository:read` doubles as the general read scope for agents/claims listing; documented here rather than invented silently.) |
| `POST /v1/agents/:agentId/heartbeat` | `agent:heartbeat` | Advances agent status to `online`; naturally idempotent (repeating it just re-stamps `last_heartbeat_at`). |
| `POST /v1/tasks` | `task:create` | Creates a task. Idempotency-Key aware. |
| `GET /v1/tasks` | `task:read` | Optional `?repositoryId=` / `?status=` filters. |
| `GET /v1/tasks/:taskId` | `task:read` | 404 problem-details if missing. |
| `POST /v1/tasks/:taskId/claim` | `task:claim` | Body: `{ agentId, workspaceSessionId, requiredResources: [{resourceType, resourceKey, mode}] }`. Returns the attempt + fencing token, or a 409 problem-details conflict. Idempotency-Key threads straight into `CoordinationEngine.claimTask`'s own `idempotencyKey`. |
| `POST /v1/tasks/:taskId/heartbeat` | `task:claim` | Body: `{ attemptId, fencingToken, leaseDurationMs? }`. Reuses `task:claim` — the spec's scope list has no separate scope for it. |
| `POST /v1/tasks/:taskId/complete` | `task:complete` | Body: `{ attemptId, fencingToken, result? }`. Idempotent via the attempt's own terminal-status check in `CoordinationEngine`. |
| `POST /v1/tasks/:taskId/fail` | `task:complete` | Body: `{ attemptId, fencingToken, error }`. Reuses `task:complete` (both are attempt-terminal operations; no separate scope exists). |
| `POST /v1/tasks/:taskId/cancel` | `task:complete` | Not an engine method — implemented directly in the daemon route (see "What's implemented directly in the daemon" below) inside a single `storage.transaction()`. Cancels the task and any of its still-active attempts/claims/leases. |
| `GET /v1/claims` | `repository:read` | Optional `?repositoryId=` filter. Lists active (unreleased) resource claims. |
| `POST /v1/claims/:claimId/release` | `admin` | Manual release — a governance escape hatch outside the normal complete/fail/expire lifecycle, so it's gated behind `admin` rather than a claim-specific scope (none exists). |
| `GET /v1/events` | `events:read` | One-shot cursor page: `?since=<cursor>&repositoryId=&limit=`. Returns `{ events, nextCursor }`. |
| `GET /v1/events/stream` | `events:read` | WebSocket. See below. |

**Idempotency convention**: every mutating route reads its idempotency
key from the `Idempotency-Key` HTTP header (not a body field), applied
consistently across agents/tasks/claims so clients only learn one
mechanism. See `apps/daemon/src/idempotency.ts`.

**Rate limiting**: 60 mutating requests per rolling 60-second window,
per token (hand-rolled sliding window, `apps/daemon/src/rate-limit.ts`
— no dependency). Exceeding it returns `429` with a `Retry-After` header
and an RFC 9457 body. Read-only (`GET`) routes are not rate-limited.

### What's implemented directly in the daemon vs. in `CoordinationEngine`

`CoordinationEngine` (packages/core) only owns `claimTask`,
`heartbeatAttempt`, `completeAttempt`, `failAttempt`, and
`expireStaleLeases` — the concurrency-control invariants. Everything
else this daemon exposes (agent registration/listing/heartbeat, task
creation/listing, task cancellation, manual claim release, event
listing/streaming, auth/tokens) is daemon-layer CRUD/observability with
no coordination-invariant content, so it's implemented directly against
the concrete `SqliteStorageAdapter` (extra methods added in
`packages/storage-sqlite/src/adapter.ts`: `saveAgent`/`getAgent`/
`listAgents`, `listTasks`/`countTasksByStatus`,
`listActiveResourceClaims`/`releaseResourceClaim`, `listEventsSince`/
`listAllEvents`/`latestEventCursor`, `saveToken`/`getTokenByHash`/
`listTokens`/`revokeToken`, `ping`) rather than added to the
storage-agnostic `StorageAdapter` interface in `packages/core`. This
keeps ADR-0001's "core stays storage-agnostic" invariant intact — a
future Postgres adapter only has to reimplement the interface
`CoordinationEngine` actually depends on, not daemon-only CRUD.

`POST /v1/tasks/:taskId/cancel` is the one route that mutates
coordination state (task/attempt/claim/lease) without an
`CoordinationEngine` method to call — there is no `cancelTask` in the
engine yet. It's implemented in `apps/daemon/src/routes/tasks.ts` using
the same primitives the engine itself uses (`canTransitionTask`,
`canTransitionAttempt` from `@gitamesh/core`, and a single
`storage.transaction()` for atomicity), so it's consistent with the
engine's own invariants without needing a new core API for a single
milestone's worth of one route.

## Auth & scopes

Opaque bearer tokens (`Authorization: Bearer <token>`), matching spec
section 12, simplified for this milestone:

- Tokens are minted via `mintToken()` (`apps/daemon/src/auth.ts`) or the
  bootstrap flows above. Only a SHA-256 hash is stored
  (`packages/storage-sqlite`'s `tokens` table); the raw value is shown
  once.
- Scopes: `repository:read`, `repository:write` (reserved, unused by any
  route yet — no `/v1/repositories` routes exist), `agent:register`,
  `agent:heartbeat`, `task:read`, `task:create`, `task:claim`,
  `task:complete`, `events:read`, `admin`. A token with `admin` satisfies
  every scope check.
- Missing/malformed `Authorization` header → `401`. Invalid, expired, or
  revoked token → `401`. Valid token lacking the required scope → `403`.
  Both are RFC 9457 problem-details bodies.
- `/v1/events/stream`'s WebSocket upgrade also accepts `?token=` as a
  query-param fallback, since browser `WebSocket` clients cannot set
  arbitrary headers on the upgrade request. Prefer the `Authorization`
  header everywhere else.
- Logs never include the raw token or its hash — only `token_id`
  (`apps/daemon/src/server.ts`'s `onResponse` hook, plus the
  `Authorization` header is explicitly redacted from Fastify's request
  logs).

## WebSocket reconnect / cursor semantics

`GET /v1/events/stream?since=<cursor>&repositoryId=<optional>`:

1. On connect, the server **replays** every event after `since` from
   durable storage (`SqliteStorageAdapter.listEventsSince`, an indexed
   `rowid > ?` scan), in insertion order.
2. It then stays open and pushes new events live as they're appended,
   via an in-process broadcaster (`apps/daemon/src/events-bus.ts`) that
   re-reads storage from each client's own cursor after every mutating
   route succeeds. There is deliberately no external pub/sub (Redis,
   etc.) — this is a single-process daemon for this milestone.
3. Each delivered event carries a `cursor` field. To reconnect with **no
   gaps**, pass the `cursor` of the last event you fully processed as
   the new `?since=`.
4. Delivery is **at-least-once**: if you reconnect with a cursor equal
   to (not past) the last event you saw, you may receive that boundary
   event a second time. Treat `event_id` as a dedupe key if exactly-once
   processing matters to you. What is guaranteed is that nothing is ever
   **skipped**.

## Observability

- Structured JSON logs via Fastify's built-in pino logger (no second
  logging library). Every log line includes the Fastify request id;
  `token_id` is attached once auth succeeds. `Authorization` headers are
  redacted; full request bodies are not logged wholesale (route handlers
  log only what's needed, primarily ids and status codes).
- `/metrics` (Prometheus text exposition, hand-rolled — no metrics
  library, see `apps/daemon/src/metrics.ts`):
  - `gitamesh_tasks_total{status="..."}` — gauge, one line per task
    state, from `SELECT status, COUNT(*) FROM tasks GROUP BY status`.
  - `gitamesh_lease_expirations_total` — counter, incremented by the
    daemon's periodic `expireStaleLeases()` sweep (every 5s).
  - `gitamesh_claim_conflicts_total` — counter, incremented whenever
    `POST /v1/tasks/:id/claim` is rejected with a 409
    (`resource-conflict` / `task-already-claimed` / `task-not-claimable`).
  - `gitamesh_websocket_clients_connected` — gauge, live count of
    connected `/v1/events/stream` clients.

## What's NOT implemented (be honest about the gaps)

- **Postgres adapter** — this daemon only runs against
  `packages/storage-sqlite`, which is explicitly single-process/
  single-connection-safe, not multi-daemon-safe (see
  `packages/storage-sqlite/src/schema.ts`).
- **Redis / external signaling** — the WebSocket broadcaster is
  in-process only; running two daemon processes against the same
  SQLite file would NOT fan out events between them.
- **`/v1/repositories`** — no repository-registration route exists yet
  (the CLI's `registerRepository` client method is written against the
  documented shape but will 404 against this daemon; see
  `packages/cli/src/client.ts`'s own note on this gap).
- **Integration-candidate routes** — `packages/core` has no
  integration-candidate lifecycle support yet (only the
  `IntegrationState` enum exists in `packages/protocol`, unconsumed), so
  this milestone deliberately did not half-build routes for it, per the
  task's own instruction to prefer a fully-implemented core surface over
  a partially-built extra one.
- **Production TLS / remote exposure** — binds to `127.0.0.1` by
  default; putting this behind Caddy (or similar) with TLS termination
  and real network exposure is out of scope here.
- **Token rotation / multi-tenant issuance UI** — `mint-token.ts` and
  `--bootstrap-admin-token` are dev conveniences, not a production
  identity system.
- **A configurable retry policy for `failAttempt`** — inherited as-is
  from `packages/core`'s fixed `maxAttempts` default (see the `TODO` in
  `packages/core/src/engine.ts`); this daemon does not add a retry
  policy on top.

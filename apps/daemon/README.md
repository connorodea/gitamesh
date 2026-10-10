# @gitamesh/daemon

The Gitamesh coordination daemon: a Fastify HTTP/WebSocket API in front
of `@gitamesh/core`'s `CoordinationEngine`, backed by a pluggable
`StorageAdapter` (`packages/core/src/storage-adapter.ts`). Every file in
this daemon is written against that interface, never a concrete adapter
class — see "Storage drivers" below.

Two implementations exist today:

- **`@gitamesh/storage-sqlite`** (`better-sqlite3`, WAL mode) — the
  **default**. Single-process, single-connection-safe (see
  `packages/storage-sqlite/src/schema.ts`); zero setup, one file on disk.
- **`@gitamesh/storage-postgres`** (`pg`/node-postgres) — for
  multi-process/multi-daemon production deployments, where several
  daemon processes need to coordinate through one shared database. See
  `packages/storage-postgres/README.md` for how it stays synchronous
  (matching `StorageAdapter`'s sync contract) despite `pg` being async.

The route/auth/observability layer is identical regardless of which
driver is selected — only `apps/daemon/src/index.ts`'s `createStorage()`
branches on `GITAMESH_STORAGE_DRIVER`.

## Running in Docker

See [`docker/README.md`](../../docker/README.md) for the production
Dockerfile (`Dockerfile` in this directory), `docker-compose.yml` at the
repo root, environment variables, the volume-mount pattern for SQLite
persistence, and why the container's `GITAMESH_BIND_HOST` default
(`0.0.0.0`) differs from this section's bare-metal default (`127.0.0.1`).

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
| `GITAMESH_STORAGE_DRIVER` | `sqlite` | `sqlite` or `postgres`. See "Storage drivers" below. |
| `GITAMESH_DB_PATH` | `./gitamesh.db` | SQLite file path (only used when the driver is `sqlite`). Set to `:memory:` for an ephemeral in-memory database. |
| `GITAMESH_POSTGRES_URL` | — | `postgresql://user:pass@host:port/db`. Required when the driver is `postgres`; `DATABASE_URL` is accepted as a fallback name. |
| `GITAMESH_POSTGRES_SSL` | unset | Set to `true` to connect with `{ rejectUnauthorized: false }` (common for managed Postgres providers with load-balancer-terminated/self-signed certs in front of the DB). Only used when the driver is `postgres`. |
| `GITAMESH_REDIS_URL` | unset | `redis://[:password@]host:port[/db]`. Opt-in cross-process live event signaling — see "Redis cross-process signaling" below. Unset (the default) means zero behavior change and `ioredis` is never resolved. |
| `GITAMESH_BIND_HOST` | `127.0.0.1` | Set to `0.0.0.0` to listen on all interfaces. **Secure-by-default**: loopback only unless explicitly opted into. Production TLS/remote exposure is handled by a reverse proxy (Caddy) in front of this daemon, not by the daemon itself. |
| `GITAMESH_PORT` | `8787` | Listen port. |
| `LOG_LEVEL` | `info` | Pino log level. |

### Storage drivers

```bash
# Default — unchanged from before this feature existed:
pnpm --filter @gitamesh/daemon start

# Postgres-backed, for multi-process/multi-daemon deployments:
GITAMESH_STORAGE_DRIVER=postgres \
GITAMESH_POSTGRES_URL="postgresql://gitamesh:gitamesh@localhost:5432/gitamesh" \
pnpm --filter @gitamesh/daemon start

# Or via Docker Compose (brings up Postgres too):
docker compose --profile postgres up
```

`apps/daemon/src/index.ts`'s `createStorage()` selects the driver once at
startup. `@gitamesh/storage-postgres` is imported dynamically (`await
import(...)`) so a plain SQLite deployment never has to resolve the `pg`
module at all. Schema creation is automatic and idempotent on both
drivers (`CREATE TABLE IF NOT EXISTS ...`) — there is no separate
"migrate" step to run first.

### Redis cross-process signaling

Running several `postgres`-driver daemon processes behind a load
balancer, all pointed at one shared database, makes coordination itself
safe (real Postgres transactions) — but each process's WebSocket
broadcaster (`apps/daemon/src/events-bus.ts`) previously only knew about
events appended by mutations that happened to hit *that* process. A
client connected to process A would not see a live event for a task
claimed via process B until it reconnected (cursor-based replay-on-
reconnect always caught it up, so nothing was ever silently lost — it
just wasn't *live* across processes).

Setting `GITAMESH_REDIS_URL` closes that gap:

```bash
GITAMESH_STORAGE_DRIVER=postgres \
GITAMESH_POSTGRES_URL="postgresql://gitamesh:gitamesh@localhost:5432/gitamesh" \
GITAMESH_REDIS_URL="redis://localhost:6379" \
pnpm --filter @gitamesh/daemon start

# Or via Docker Compose (brings up Postgres + Redis too):
docker compose --profile postgres-redis up
```

What it does and does not do:

- Every time a daemon process's `EventBroadcaster.notifyNew()` runs
  (i.e. after every mutating route succeeds), it also publishes a
  **single fixed-byte signal** on a Redis pub/sub channel — never
  serialized event data. Every other daemon process subscribed to that
  channel reacts by re-reading storage from each of *its own*
  locally-connected clients' cursors and pushing anything new, via the
  exact same `listEventsSince` path the local in-process broadcast
  already uses.
- Storage remains the **sole source of truth** at all times. Redis pub/
  sub has no delivery-durability guarantee (a message published while a
  subscriber is disconnected is simply dropped), which would be
  unacceptable for event data but is fine for a signal: a dropped signal
  only delays a client's live update until its next reconnect-triggered
  replay — the at-least-once/no-gap guarantee documented under
  "WebSocket reconnect / cursor semantics" below is completely
  unaffected by whether Redis is configured, up, or flaky.
- `ioredis` is imported dynamically (`await import("./redis-signal.js")`,
  itself importing `ioredis`) only when `GITAMESH_REDIS_URL` is set, so a
  deployment that never opts in never resolves the module — the same
  pattern `@gitamesh/storage-postgres` uses for `pg`.
- Meaningful only alongside `GITAMESH_STORAGE_DRIVER=postgres`. It's
  harmless but pointless with the default `sqlite` driver, since SQLite
  itself isn't multi-daemon-safe either way (see "What's NOT
  implemented" below).
- Two daemon processes only signal each other if they point at the
  **same** `GITAMESH_REDIS_URL` — same as needing to point at the same
  Postgres database to coordinate at all.

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
| `POST /v1/repositories` | `repository:write` | Body: `{ display_name, git_common_dir, default_branch, namespace_id?, metadata? }`. Idempotent without an Idempotency-Key: a repository already registered under `metadata.local_repository_id` (else under the same `namespace_id` + `git_common_dir`) is returned unchanged with `200` and `replayed: true`; a new one returns `201`. `repository_id` is `metadata.local_repository_id` when sent, else generated. Emits `repository.registered`. |
| `GET /v1/repositories` | `repository:read` | Lists all repositories, oldest first. There is no update or delete route. |
| `POST /v1/tasks` | `task:create` | Creates a task. Idempotency-Key aware. |
| `GET /v1/tasks` | `task:read` | Optional `?repositoryId=` / `?status=` / `?agentId=` (tasks that agent holds) / `?unclaimed=true` filters. Each task carries `owner` (`{agent_id, display_name, attempt_id, heartbeat_at, expires_at}` or null), `readiness` (`ready`/`blocked`, null once not waiting) and `blocked_by`. |
| `GET /v1/tasks/:taskId` | `task:read` | Returns `{ task, notes, revisions }`. 404 problem-details if missing. |
| `PATCH /v1/tasks/:taskId` | `task:create` | Body (snake_case, strict): any of `title`, `description`, `priority`, `branch`, `base_sha`, `dependencies`, plus optional `updated_by` (agent id). Writes one append-only revision (`changed_by`, `changed_at`, `changes: {field: {old, new}}`) when something changed; returns `revision: null` otherwise. `dependencies` may change only while the task is pending/queued/blocked. |
| `POST /v1/tasks/:taskId/notes` | `task:claim` | Body: `{ agent_id, body }`. Append-only progress note. |
| `POST /v1/tasks/:taskId/claim` | `task:claim` | Body: `{ agentId, workspaceSessionId, requiredResources: [{resourceType, resourceKey, mode}] }`. Returns the attempt + fencing token, or a 409 problem-details conflict. Idempotency-Key threads straight into `CoordinationEngine.claimTask`'s own `idempotencyKey`. |
| `POST /v1/tasks/:taskId/heartbeat` | `task:claim` | Body: `{ attemptId, fencingToken, leaseDurationMs? }`. Reuses `task:claim` — the spec's scope list has no separate scope for it. |
| `POST /v1/tasks/:taskId/complete` | `task:complete` | Body: `{ attemptId, fencingToken, result? }`. Idempotent via the attempt's own terminal-status check in `CoordinationEngine`. |
| `POST /v1/tasks/:taskId/fail` | `task:complete` | Body: `{ attemptId, fencingToken, error }`. Reuses `task:complete` (both are attempt-terminal operations; no separate scope exists). |
| `POST /v1/tasks/:taskId/cancel` | `task:complete` | Not an engine method — implemented directly in the daemon route (see "What's implemented directly in the daemon" below) inside a single `storage.transaction()`. Cancels the task and any of its still-active attempts/claims/leases. |
| `GET /v1/claims` | `repository:read` | Optional `?repositoryId=` filter. Lists active (unreleased) resource claims. |
| `POST /v1/claims/:claimId/release` | `admin` | Manual release — a governance escape hatch outside the normal complete/fail/expire lifecycle, so it's gated behind `admin` rather than a claim-specific scope (none exists). |
| `POST /v1/messages` | `task:claim` | Body: `{ from, to, body, repository_id?, task_id? }`; `to` is an agent id or `"all"`. Append-only. |
| `GET /v1/messages` | `task:read` | Filters: `?to=` (also returns messages to `all`), `?from=`, `?unread=true` (needs `to`), `?since=<iso>`, `?repositoryId=`, `?taskId=`. Oldest first. |
| `POST /v1/messages/:messageId/ack` | `task:claim` | Body: `{ agent_id }`. Adds to `acked_by`; a repeat returns `already_acked: true`. 403 if the message is addressed to another agent. |
| `POST /v1/locks` | `task:claim` | Body: `{ agent_id, repository_id, paths[], task_id?, ttl_seconds? }` (default 900, max 86400). All-or-nothing; 409 `path-lock-conflict` names the holder. |
| `GET /v1/locks` | `repository:read` | Active (unreleased, unexpired) path locks. `?repositoryId=` / `?agentId=`. |
| `POST /v1/locks/:lockId/heartbeat` | `task:claim` | Body: `{ agent_id, ttl_seconds? }`. Holder only. 409 once expired. |
| `POST /v1/locks/:lockId/release` | `task:claim` | Body: `{ agent_id }`. Holder only. Sets `released_at`; the record stays. |
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

### No delete routes

Messages, message acks, task revisions and task notes are append-only, and
no route deletes a message, task, note, revision or lock. The new routes
reuse existing scopes (`task:claim` for an agent's own writes, `task:read`
/ `repository:read` for reads, `task:create` for `PATCH`) so tokens minted
before these routes existed keep working.

`POST /v1/tasks` and `PATCH` reject a dependency that does not exist, is
in another repository, is the task itself, or closes a cycle (422
`invalid-dependencies`). `POST /v1/tasks/:taskId/claim` refuses a task
whose dependencies have not met its `join_policy` (409
`task-dependencies-incomplete`).

### What's implemented directly in the daemon vs. in `CoordinationEngine`

`CoordinationEngine` (packages/core) only *calls* `claimTask`,
`heartbeatAttempt`, `completeAttempt`, `failAttempt`, and
`expireStaleLeases` internally — the concurrency-control invariants.
Everything else this daemon exposes (agent registration/listing/
heartbeat, task creation/listing, task cancellation, manual claim
release, event listing/streaming, auth/tokens) is daemon-layer
CRUD/observability with no coordination-invariant content. It's
implemented against extra methods on the shared `StorageAdapter`
interface itself (`packages/core/src/storage-adapter.ts`: `saveAgent`/
`getAgent`/`listAgents`, `listTasks`/`countTasksByStatus`,
`listActiveResourceClaims`/`releaseResourceClaim`, `listEventsSince`/
`listAllEvents`/`latestEventCursor`, `saveToken`/`getTokenByHash`/
`listTokens`/`revokeToken`, `ping`) rather than a concrete class — every
route file types `storage` as `StorageAdapter`, never
`SqliteStorageAdapter`/`PostgresStorageAdapter` directly, so either
driver can back this daemon interchangeably. This still keeps
ADR-0001's "core stays storage-agnostic" invariant intact: none of these
daemon-only methods are called by `CoordinationEngine`, they're just
part of the same interface contract both storage packages implement.

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
  bootstrap flows above. Only a SHA-256 hash is stored (the `tokens`
  table — see `packages/storage-sqlite/src/schema.ts` or
  `packages/storage-postgres/src/schema.ts` depending on the active
  driver); the raw value is shown once.
- Scopes: `repository:read`, `repository:write`, `agent:register`,
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
   durable storage (`StorageAdapter.listEventsSince` — an indexed
   `rowid > ?` scan on SQLite, `cursor > $1` on Postgres), in insertion
   order.
2. It then stays open and pushes new events live as they're appended,
   via an in-process broadcaster (`apps/daemon/src/events-bus.ts`) that
   re-reads storage from each client's own cursor after every mutating
   route succeeds. By default this is purely in-process, single-daemon
   delivery; see "Redis cross-process signaling" above for the opt-in
   `GITAMESH_REDIS_URL` path that fans this out across multiple daemon
   processes sharing one Postgres database.
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

- **Redis / external signaling is now opt-in, not built-in.** The
  WebSocket broadcaster is in-process by default. Running two
  `sqlite`-driver daemon processes against the same SQLite file still
  would NOT fan out events between them (SQLite itself isn't
  multi-daemon-safe either — see `packages/storage-sqlite/src/schema.ts`
  — so this isn't a case Redis signaling is meant to address). Running
  multiple `postgres`-driver daemon processes against the same database
  IS safe for coordination (real Postgres transactions); with
  `GITAMESH_REDIS_URL` also set, their WebSocket broadcasters now fan
  live events out to each other too (see "Redis cross-process signaling"
  above). Without it, a client connected to daemon A still only sees a
  live event for a mutation on daemon B on its next reconnect — nothing
  is silently lost either way, delivery is just not live across daemons
  until Redis signaling is configured.
- **`storage-postgres` concurrency model** — every call into
  `PostgresStorageAdapter` is synchronous from the daemon's point of
  view (matching `StorageAdapter`'s contract) via a `synckit`-bridged
  worker thread holding one persistent connection; see
  `packages/storage-postgres/README.md` for the full rationale and its
  cost (each call blocks the daemon process's event loop for the
  round-trip, same as `better-sqlite3` already does today). Real
  concurrency across daemon processes still comes from Postgres itself.
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

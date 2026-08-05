# Gitamesh

The coordination mesh for autonomous coding agents.

Gitamesh prevents duplicate work, conflicting implementations, and
stale-worker races when multiple AI coding agents (Claude Code, Codex,
Cursor, remote workers) operate across repos, branches, and worktrees
concurrently. It is a domain-neutral coordination, observability, and
concurrency-control layer over Git and agent runtimes — not an LLM
provider, not a chatbot, not a CI platform, and not an IDE.

## What's implemented so far (v0.1.0 — foundation milestone)

- **`packages/protocol`** — versioned zod schemas + inferred TypeScript
  types for the domain model (Repository, Worktree, Agent,
  WorkspaceSession, Workflow, Task, TaskAttempt, ResourceClaim, Lease,
  EventEnvelope), the Task/Attempt/Agent/Integration state-name unions,
  generated JSON Schema wire contracts under `packages/protocol/schemas/`,
  and an RFC 9457 problem-details error module.
- **`packages/core`** — pure state-transition graphs for Task, Attempt,
  Agent, and Integration lifecycles, hierarchical resource-path conflict
  detection, resource-key validation/canonicalization, and the
  `CoordinationEngine`: `claimTask`, `heartbeatAttempt`,
  `completeAttempt`, `failAttempt`, `expireStaleLeases`, all implemented
  against a storage-agnostic `StorageAdapter` interface.
- **`packages/storage-sqlite`** — a `better-sqlite3` (WAL mode)
  implementation of `StorageAdapter`, with in-memory and file-backed
  factories.
- **`packages/testkit`** — shared test helpers (in-memory engine
  factory, entity builders) for packages built in later milestones.
- **`packages/git-adapter`** — a safe (argument-array, never
  shell-interpolated), read-only-with-respect-to-the-working-tree wrapper
  around the `git` CLI: stable cross-worktree repository identity
  (`getRepositoryIdentity` + `getOrCreateRepositoryId`), porcelain-based
  worktree discovery (`listWorktrees`), changed-path/merge-base helpers,
  base-SHA staleness detection, a read-only merge-conflict assessment
  (`assessMergeConflict`, via `git merge-tree`), and the filesystem-aware
  symlink-escape check (`resolveAndValidateResourceKey`) that
  `packages/core/src/resource-keys.ts` explicitly defers to this package.
- **`packages/cli`** — the `gitamesh` command-line interface: `init`,
  `doctor`, `status`, `repo register/status`, `agent
  register/heartbeat/list`, `task
  create/list/show/claim/heartbeat/complete/fail/cancel`, `lock
  list/release`. See `packages/cli/README.md` for the full command
  reference and a coordination note on which daemon routes exist yet.
- **`apps/daemon`** — the Fastify HTTP/WebSocket coordination daemon:
  `/healthz` `/readyz` `/metrics`, `/v1/agents*`, `/v1/tasks*`,
  `/v1/claims*`, `/v1/events` + a `/v1/events/stream` WebSocket with
  gap-free cursor-based reconnect, opaque bearer-token auth with scopes,
  per-token rate limiting, and `Idempotency-Key`-aware mutating routes,
  all backed by the embedded `storage-sqlite` adapter. See
  `apps/daemon/README.md` for the full route table, scope model, and how
  to mint a bootstrap admin token.

- **`packages/sdk-typescript`** (`@gitamesh/sdk`) — a typed, injectable
  TypeScript client for `apps/daemon`'s HTTP + WebSocket API: agent
  registration/heartbeat, task create/list/get, atomic `claimTask`
  (typed `GitameshConflictError` on 409), a heartbeat-loop helper,
  complete/fail/cancel, resource-claim listing/release, `Idempotency-Key`
  threading, and a `subscribeToEvents` WebSocket client with cursor-based
  gap-free auto-reconnect. See `packages/sdk-typescript/README.md`.
- **`packages/mcp-server`** (`@gitamesh/mcp-server`) — a stdio MCP (Model
  Context Protocol) server exposing Gitamesh coordination as tools an AI
  coding agent (Claude Code, Codex, Cursor) can call directly: status,
  agent registration, task create/list/claim/heartbeat/complete/fail,
  claim listing, and a cursor-based event-page tool, all
  schema-validated (zod) and structured — a 409 claim conflict returns a
  structured result rather than a thrown error. Built against a small
  temporary internal daemon client pending `@gitamesh/sdk-typescript`
  integration; see `packages/mcp-server/README.md` for client-config
  snippets and design notes.
- **`packages/simulator`** (`@gitamesh/simulator`) — the deterministic,
  seedable adversarial scenario harness from the spec's `gitamesh
  simulate` (section 16): drives a real `CoordinationEngine` + real
  in-memory SQLite storage through claim races, resource-claim races,
  duplicate/idempotent-command replay, worker-crash + fencing-token
  supersession, and path-traversal/symlink-key rejection, all from a
  single `mulberry32` PRNG seed, and writes a `simulation-report.json`
  with a per-scenario `reproductionCommand`. Also honestly documents,
  rather than fakes, the spec scenarios blocked on missing
  `packages/core` features (base_sha staleness, cancellation cascade,
  integration candidates) — see `packages/simulator/README.md`. Fan-in
  join-policy evaluation (`Task.join_policy`/`Task.dependencies`) is
  implemented (`packages/core/src/fan-in.ts`); `"quorum"` policy remains
  a documented no-op pending a threshold field in the schema.

All of the above ship with real, passing tests — see each package's
`test/` directory. See `docs/adr/0001-protocol-first-storage-agnostic-core.md`
for the key architectural decisions made in this milestone.

**Nothing in this repository has been deployed or published anywhere.**
This is a foundation-layer milestone, not a production-ready system.

## Not yet built

- Postgres storage adapter (for real multi-process safety — the SQLite
  adapter, and therefore the daemon built on it, is single-process only)
- Redis-based signaling / pub-sub (the daemon's WebSocket broadcaster is
  in-process only, by design — see `apps/daemon/src/events-bus.ts`)
- `/v1/repositories` and any "integration candidate" routes (no
  integration-candidate support exists in `packages/core` yet, so
  `apps/daemon` deliberately does not half-build routes for it)
- Docker / deployment tooling
- Production TLS / remote exposure hardening (the daemon binds to
  `127.0.0.1` by default; that's Caddy's job in front of it later)
- Public docs site

## Development

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

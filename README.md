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

All of the above ship with real, passing tests — see each package's
`test/` directory. See `docs/adr/0001-protocol-first-storage-agnostic-core.md`
for the key architectural decisions made in this milestone.

**Nothing in this repository has been deployed or published anywhere.**
This is a foundation-layer milestone, not a production-ready system.

## Not yet built

- Daemon / API server (`apps/daemon` is a placeholder package only)
- CLI
- TypeScript SDK
- MCP adapter
- Git adapter (worktree-aware, symlink-safe resource-key resolution)
- Deterministic simulator
- Postgres storage adapter (for real multi-process safety)
- Redis-based signaling
- Docker / deployment tooling
- Public docs site

## Development

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

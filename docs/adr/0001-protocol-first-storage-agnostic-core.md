# ADR-0001: Protocol-first, storage-agnostic core

**Status:** Accepted
**Date:** 2026-08-04

## Context

Gitamesh's coordination invariants (single-active-attempt tasks, atomic
resource acquisition, fencing-token-based lease safety, idempotent
mutating operations, per-repository event ordering) are the load-bearing
part of the whole product. They need to be correct independent of which
database eventually backs a production deployment — the milestone spec
calls out SQLite now and Postgres later as the intended multi-process
production adapter.

## Decision

`packages/protocol` defines the wire-contract shapes (zod schemas +
generated JSON Schema) with no behavior. `packages/core` implements the
state-machine transition graphs and the `CoordinationEngine` entirely
against a `StorageAdapter` interface it also defines — it has no
dependency on `better-sqlite3` or any concrete store.
`packages/storage-sqlite` is the first (and, for this milestone, only)
implementation of that interface. A future Postgres adapter implements
the identical interface; `CoordinationEngine` does not change.

**Fencing-token scope:** tokens are a monotonic counter scoped
**per-repository** (`nextFencingToken(repositoryId)`), not per-task or
global. Per-task would reset on every new task and wouldn't protect
cross-task resource claims within a repository from being compared
meaningfully; global would force every repository's claims through a
single contention point for no coordination benefit, since resource
conflicts are already repository-scoped (`getActiveResourceClaims` is
queried per repository). Per-repository is the smallest scope that still
lets any two attempts touching the same repository's resources be
strictly ordered.

**`validateResourceKey` scope:** it is a pure, filesystem-free string
function. It rejects absolute paths, NUL bytes, and `..` traversal
segments, and canonicalizes lexically equivalent forms
(`./src/file.ts` → `src/file.ts`). It deliberately does **not** resolve
symlinks or touch a real checkout — a resource key that is lexically
safe but escapes the repository root via a symlink on disk cannot be
caught by string processing alone. That check belongs to the
not-yet-built Git adapter, which will have an actual worktree to resolve
against.

**Claim atomicity via check-then-write, not app-level locking:**
`claimTask` validates every required resource against active claims
(and against sibling resources in the same request) entirely before any
write, and the whole method body runs inside `storage.transaction()`.
For `storage-sqlite`, that transaction is a single real SQLite
transaction on a single WAL-mode connection — correct for one process,
not for multiple OS processes sharing one SQLite file (documented in
`packages/storage-sqlite/src/schema.ts`). Multi-process safety is
explicitly deferred to the future Postgres adapter, which will use `SELECT
... FOR UPDATE` / serializable transactions instead of relying on
single-connection serialization.

**Task-state transition on claim:** a successful `claimTask` walks the
task through `pending → queued → claiming → running` (skipping the
`queued` step if the task was already queued) in one call, rather than
exposing `claiming` as an externally observable intermediate state.
`failAttempt` requeues to `queued` (not `pending`) since a task that was
already claimable once doesn't need to re-satisfy whatever gated
`pending → queued` originally. A minimal, non-configurable max-attempts
check (default 3) escalates to the terminal `failed` task state instead
of requeuing forever; a real retry policy (backoff, failure
classification) is intentionally out of scope here (see the `TODO`
comment in `packages/core/src/engine.ts`).

**Testing the core against a fake, not a cycle back through
storage-sqlite:** `packages/storage-sqlite` depends on `packages/core`
(it implements core's interface). If `packages/core`'s own tests
depended on `packages/storage-sqlite` (directly or via `packages/testkit`,
which depends on both), that would create a workspace dependency cycle.
Instead, `packages/core/test` ships its own minimal, snapshot-rollback
in-memory `StorageAdapter` fake used only by core's tests, and
`packages/storage-sqlite/test` separately re-proves the invariants that
are most sensitive to a *real* transactional store (concurrent claim
racing, per-repository event sequencing) against actual SQLite.
`packages/testkit` (which legitimately depends on both `core` and
`storage-sqlite`) is reserved for consumers built in later milestones
(daemon, CLI, SDK) that sit above both.

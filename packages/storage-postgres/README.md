# @gitamesh/storage-postgres

PostgreSQL (`pg`/node-postgres) implementation of `@gitamesh/core`'s
`StorageAdapter` interface, for multi-process/multi-daemon production
deployments of `apps/daemon`. `@gitamesh/storage-sqlite` remains the
default, embedded, single-process implementation — this package is the
option you reach for when several daemon processes need to coordinate
through one shared database.

## Why this needed a "verify the library first" pass

`packages/core`'s `StorageAdapter` interface is **synchronous**:
`transaction<T>(fn: () => T): T`, and every CRUD method returns a plain
value, not a `Promise`. That's not an oversight — `CoordinationEngine`
and every existing consumer (`apps/daemon`, `packages/cli`,
`packages/testkit`) call it synchronously, and changing that would ripple
through the entire monorepo far outside this package's scope. But `pg`
is unavoidably async (real network I/O to Postgres). Two options existed:

1. Make the engine/interface async everywhere. Rejected — out of scope,
   and `SqliteStorageAdapter` (which stays as-is) would no longer satisfy
   the same interface without its own rewrite.
2. Bridge sync-over-async with a persistent worker thread and
   `Atomics.wait`, the same mechanism ESLint/Prettier plugins use to call
   async formatters/linters synchronously. Chosen.

Before committing to option 2, both moving parts were verified standalone
in isolation (not assumed to work together):

- **`@electric-sql/pglite`** (embedded, in-process, WASM Postgres — this
  package's default test backend): installed standalone and exercised
  with `CREATE TABLE`, parameterized `INSERT ... RETURNING`,
  `ON CONFLICT ... DO UPDATE`, and `db.transaction(...)` — all worked.
  One real gap was found and worked around: `pglite`'s `.query()` goes
  through the extended/prepared-statement protocol, which rejects
  multi-statement SQL strings (`"cannot insert multiple commands into a
  prepared statement"`). Schema initialization therefore uses `.exec()`
  (pglite-only, simple-query protocol) instead of `.query()` — see
  `src/worker.ts`.
- **`synckit`**: installed standalone and exercised with a toy worker
  round-tripping through `createSyncFn` before any Postgres code was
  written on top of it.

Both held up, so `sync-client.ts` + `worker.ts` implement the bridge:
`worker.ts` runs inside a persistent `worker_threads` worker and owns the
actual `pg.Client` (or `PGlite` instance) connections, one per adapter,
keyed by a connection id; `sync-client.ts`
exposes `init`/`query`/`begin`/`commit`/`rollback`/`close` as plain
synchronous method calls via `synckit`'s `createSyncFn`.

### The honest cost

- **One persistent connection per adapter, not a pool.** `StorageAdapter.
  transaction()` needs `BEGIN`/`COMMIT`/`ROLLBACK` to land on the same
  server-side connection as the statements they bracket. Since only one
  synchronous call can be in flight at a time anyway (the calling thread
  is fully blocked on `Atomics.wait` for the duration), one
  connection per adapter is sufficient and simplest — see the comment above
  `runAsWorker(...)` in `src/worker.ts`.
- **Every storage call blocks the daemon process's event loop** for the
  round trip to the worker thread. This sounds worse than it is: it is
  **not a regression** relative to today's SQLite adapter —
  `better-sqlite3` is itself a synchronous native binding that blocks the
  event loop per call, and its own schema comment already documents
  "SQLite itself serializes writers". This adapter's serialization
  happens one layer up (worker RPC) instead of inside a native binding,
  but the practical throughput characteristics for one daemon process are
  comparable.
- **Coordination transactions are serialized across daemon processes.**
  Each process has its own connection, but every outer `transaction()`
  acquires the same transaction-scoped advisory lock before running its
  callback. This protects the complete read/check/write operation. Ordinary
  `BEGIN` and a later atomic fencing-counter increment are insufficient:
  two processes could already have read the same unclaimed task.

If a future need for real intra-process concurrent Postgres access
emerges, the fix is a connection pool *inside the worker* (still fronted
by the same synchronous RPC surface) or, for a larger rework, making
`StorageAdapter` itself async — not a change to make casually.

### Transaction boundary and contention

Real server transactions start with `BEGIN ISOLATION LEVEL READ COMMITTED`
and then `pg_advisory_xact_lock(1195988033, 1296388936)`. The two integer
keys encode `GITA` / `MESH` and are reserved for Gitamesh coordination in
that database. The lock is released by commit, rollback, or connection
termination. READ COMMITTED ensures reads after a lock wait see the previous
holder's committed state, even if the database role defaults to another
isolation level. See PostgreSQL's [advisory lock documentation](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS).

This is deliberately a coarse database-wide lock for the current synchronous
storage contract. Task execution remains outside database transactions and
can run in parallel; competing claim, completion, and other transactional
state changes serialize. This does not claim independent per-repository
transaction throughput. Keep callbacks short; never perform agent execution
or external network calls inside them.

Nested calls on the **same adapter** join the existing transaction. Do not
nest a transaction on another adapter within a callback: that second
connection would wait for a lock the first cannot release until it returns.
Direct CRUD calls outside `transaction()` retain their existing autocommit
behavior and do not acquire this lock. Therefore every operation requiring
atomic check-then-write behavior must use `transaction()`; direct SQL writers
are outside the guarantee. A failed begin or advisory-lock acquisition rolls
back partial server state and resets the adapter's transaction state.

The embedded PGlite test backend skips the advisory lock. Each adapter owns
an isolated single-connection database there, so it cannot demonstrate
coordination between real server sessions or daemon processes.

## Usage

```ts
import { createPostgresStorage } from "@gitamesh/storage-postgres";

const storage = createPostgresStorage("postgresql://user:pass@host:5432/gitamesh", {
  ssl: false, // or { rejectUnauthorized: false } for managed providers with self-signed certs
});
// storage implements @gitamesh/core's StorageAdapter — pass it straight
// into `new CoordinationEngine(storage)` or `buildServer({ storage })`.
```

Schema creation is automatic and idempotent (`CREATE TABLE IF NOT EXISTS
...`, run once at construction time) — there is no separate migration
step to run first. See `src/schema.ts` for the DDL, field-for-field
equivalent to `packages/storage-sqlite/src/schema.ts` (JSONB instead of
manually JSON.stringify'd TEXT for JSON-ish columns; an explicit
`BIGSERIAL cursor` column on `events` instead of relying on SQLite's
implicit `rowid`, since Postgres has no stable equivalent).

`apps/daemon` selects this driver via `GITAMESH_STORAGE_DRIVER=postgres`
+ `GITAMESH_POSTGRES_URL` (see `apps/daemon/README.md`'s "Storage
drivers" section) and imports it dynamically, so a plain SQLite
deployment never has to resolve the `pg` module at all.

## Testing

`test/adapter.test.ts` runs the exact same behavioral spec as
`packages/storage-sqlite/test/adapter.test.ts` (including the real
`CoordinationEngine` concurrency-race invariant test and the
per-repository event-sequence invariant test), plus adapter-specific
coverage for transaction rollback and the daemon-facing surface
(agents/claims/tokens/event cursor). It runs against
`createEmbeddedPostgresStorageForTests()` (pglite) by default — no
Docker/external Postgres server required, mirroring how
`storage-sqlite`'s tests use `:memory:`.

`test/transaction-boundary.test.ts` also checks recovery after a failed begin
and ensures nested callbacks share one transaction.

Real-server tests run when `GITAMESH_TEST_POSTGRES_URL` names a throwaway
PostgreSQL database; CI supplies PostgreSQL 16. They are explicitly skipped
otherwise. `test/real-postgres.test.ts` covers independent connections and
connection loss. `test/concurrent-processes.test.ts` starts two independent
Node processes against the same database and verifies competing task claims,
same-key idempotency receipts, and cleanup after a lock timeout. A barrier
holds the first process after its critical read until the second either
reaches the competing read or is observed waiting on the advisory lock. The
test exercises the old race without relying only on scheduler timing.

```bash
pnpm --filter @gitamesh/storage-postgres... build
GITAMESH_TEST_POSTGRES_URL=postgresql://user:pass@localhost:5432/gitamesh_test \
  pnpm exec vitest run packages/storage-postgres/test --maxWorkers=2
```

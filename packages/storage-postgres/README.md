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
one actual `pg.Client` (or `PGlite` instance) connection; `sync-client.ts`
exposes `init`/`query`/`begin`/`commit`/`rollback`/`close` as plain
synchronous method calls via `synckit`'s `createSyncFn`.

### The honest cost

- **A single persistent connection, not a pool.** `StorageAdapter.
  transaction()` needs `BEGIN`/`COMMIT`/`ROLLBACK` to land on the same
  server-side connection as the statements they bracket. Since only one
  synchronous call can be in flight at a time anyway (the calling thread
  is fully blocked on `Atomics.wait` for the duration), a single
  connection is sufficient and simplest — see the comment above
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
- **Real concurrency across daemon processes still comes from Postgres
  itself.** Each daemon process gets its own worker and its own
  server-side connection; Postgres's own MVCC/locking correctly
  serializes/arbitrates between them. This is exactly what "multi-process
  production deployment" means for this adapter — the concurrency this
  package exists to provide is *inter*-process, not *intra*-process.

If a future need for real intra-process concurrent Postgres access
emerges, the fix is a connection pool *inside the worker* (still fronted
by the same synchronous RPC surface) or, for a larger rework, making
`StorageAdapter` itself async — not a change to make casually.

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

This was additionally verified end-to-end against a **real** Postgres
server (a local `postgres:16-alpine` container) by starting
`apps/daemon` with `GITAMESH_STORAGE_DRIVER=postgres` +
`GITAMESH_POSTGRES_URL` pointed at it, minting a bootstrap admin token,
creating a task through the real HTTP API, and confirming the row via
`psql` and `/metrics` — not just the pglite-backed test suite. Pglite is
the default automated-test backend (fast, no external dependency); the
real-server path is documented here rather than wired into CI in this
milestone.

import { createSyncFn, startWorkerThread } from "synckit";
import { fileURLToPath } from "node:url";
import type { PostgresWorkerInitOptions } from "./worker.js";

/**
 * `packages/core`'s `StorageAdapter` contract is synchronous
 * (`transaction<T>(fn: () => T): T`) because `CoordinationEngine` and every
 * existing consumer (apps/daemon, packages/cli, packages/testkit) call it
 * synchronously — that contract is intentionally NOT being changed by this
 * package (see the "why not make the engine async" note in this package's
 * README). `pg` is unavoidably async (real network I/O), so this class
 * bridges the gap with `synckit`: a persistent `worker_threads` worker
 * (`worker.ts`) owns the actual `pg.Client`/pglite connection and runs
 * every query; `createSyncFn` blocks the calling thread on
 * `Atomics.wait` until the worker's async round-trip resolves.
 *
 * This is not a novel hack — `synckit` is the same mechanism ESLint and
 * Prettier plugins use to call async formatters/linters synchronously, and
 * it was verified standalone (a plain async worker round-tripped through
 * `createSyncFn`) before being adopted here. The practical cost: every
 * storage call blocks this Node process's event loop for the duration of
 * the round trip, and all calls against one adapter instance are
 * serialized through its one connection. That is not a regression versus
 * today's SQLite adapter — `better-sqlite3` is itself a synchronous
 * native binding that blocks the event loop per call, and its own schema
 * comment already documents "SQLite itself serializes writers". Real
 * concurrency across daemon processes still comes from Postgres itself:
 * each process gets its own worker and its own server-side connection,
 * and Postgres's own MVCC/locking arbitrates between them.
 *
 * Worker ownership. `createSyncFn` caches its worker per worker file, so
 * going through it would make every adapter in a process share ONE worker
 * thread and ONE module-global connection in `worker.ts`: a second adapter
 * would replace (and leak) the first one's `pg.Client`, closing either would
 * end both, and a `transaction()` on one would interleave with queries on
 * the other. So the real `pg` path calls `startWorkerThread` directly — one
 * worker, one connection per adapter. The worker is `unref`'d by synckit,
 * so an adapter that was closed leaves only an idle thread, which does not
 * keep the process alive.
 *
 * The embedded (pglite) test path is the opposite on purpose: it uses the
 * cached shared worker so the single WASM instance is booted once per
 * process (see `embedded` in `worker.ts`). One instance cannot serve two
 * independent adapters, so a second live embedded adapter is refused rather
 * than silently resetting the first one's data.
 */
let liveEmbeddedClient: SyncPostgresClient | undefined;

export class SyncPostgresClient {
  private readonly syncFn: (
    action: "init" | "query" | "begin" | "commit" | "rollback" | "end",
    ...args: unknown[]
  ) => unknown;

  private readonly embedded: boolean;
  private ownsEmbedded = false;

  constructor(embedded = false) {
    this.embedded = embedded;
    const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
    this.syncFn = (
      embedded ? createSyncFn(workerPath) : startWorkerThread(workerPath)
    ) as typeof this.syncFn;
  }

  init(opts: PostgresWorkerInitOptions): void {
    if (this.embedded) {
      if (liveEmbeddedClient !== undefined) {
        throw new Error(
          "PostgresStorageAdapter: an embedded (pglite) adapter is still open in this process. " +
            "The embedded Postgres is a single shared instance; close() the existing adapter first.",
        );
      }
      // Claim before the worker resets the shared instance, so a failed
      // init cannot leave a half-reset instance unguarded.
      liveEmbeddedClient = this;
      this.ownsEmbedded = true;
    }
    try {
      this.syncFn("init", opts);
    } catch (err) {
      this.releaseEmbedded();
      throw err;
    }
  }

  private releaseEmbedded(): void {
    if (this.ownsEmbedded) {
      this.ownsEmbedded = false;
      liveEmbeddedClient = undefined;
    }
  }

  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Row[] {
    return this.syncFn("query", sql, params) as Row[];
  }

  begin(): void {
    this.syncFn("begin");
  }

  commit(): void {
    this.syncFn("commit");
  }

  rollback(): void {
    this.syncFn("rollback");
  }

  close(): void {
    try {
      this.syncFn("end");
    } finally {
      this.releaseEmbedded();
    }
  }
}

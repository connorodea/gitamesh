import { createSyncFn } from "synckit";
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
 */
export class SyncPostgresClient {
  private readonly syncFn: (
    action: "init" | "query" | "begin" | "commit" | "rollback" | "end",
    ...args: unknown[]
  ) => unknown;

  constructor() {
    const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
    this.syncFn = createSyncFn(workerPath) as typeof this.syncFn;
  }

  init(opts: PostgresWorkerInitOptions): void {
    this.syncFn("init", opts);
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
    this.syncFn("end");
  }
}

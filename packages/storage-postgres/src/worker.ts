import { runAsWorker } from "synckit";

/**
 * Minimal shape both `pg.Client` and `@electric-sql/pglite`'s `PGlite`
 * satisfy: an async `query(text, params)` returning `{ rows }`, used
 * identically by this worker regardless of which backend is active.
 */
interface QueryableClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  /**
   * pglite-only: runs a multi-statement SQL string via the simple query
   * protocol. `pg.Client#query()` also supports multi-statement strings
   * (when called with no params) so it doesn't need this — but pglite's
   * `query()` always goes through the extended/prepared protocol, which
   * rejects more than one command per call, hence the separate `exec`.
   */
  exec?(text: string): Promise<unknown>;
}

export interface PostgresWorkerInitOptions {
  /** `postgresql://...` connection string. Ignored when `pglite` is set. */
  connectionString?: string;
  /**
   * Test-only escape hatch: run against an in-process embedded Postgres
   * (`@electric-sql/pglite`, a devDependency) instead of a real server.
   * Never set in production — see packages/storage-postgres/README
   * (and the "Testing" section of this package's code comments) for why
   * pglite is the default test backend but never the runtime one.
   */
  pglite?: boolean;
  /** Forwarded to `pg.Client` as-is; e.g. `{ rejectUnauthorized: false }`. Ignored for pglite. */
  ssl?: boolean | Record<string, unknown>;
  schemaSql: string;
}

let client: QueryableClient | undefined;

/**
 * The one embedded Postgres this worker ever boots (test-only path).
 *
 * `synckit` caches its worker per worker file, so every
 * `PostgresStorageAdapter` in a process already shares this single worker
 * thread and this single `client` slot. Booting a fresh PGlite (a WASM
 * instance) per adapter and closing it on `end` meant a test file created
 * and freed one WASM instance per test — and freeing WASM code from this
 * worker thread is what crashed V8 on Node 24 / Linux
 * (`Check failed: jit_page_->allocations_.erase(addr) == 1` in
 * `ThreadIsolation::UnregisterWasmAllocation`), killing the vitest fork
 * and surfacing as `ERR_IPC_CHANNEL_CLOSED` in CI.
 *
 * So the instance is booted once, kept for the life of the worker, and
 * handed to each new adapter with an empty schema. It is never closed:
 * it holds no file or socket, and the process exit reclaims it.
 */
let embedded: (QueryableClient & { exec(text: string): Promise<unknown> }) | undefined;

const RESET_EMBEDDED_SQL = "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;";

/**
 * A single, persistent connection (never a `pg.Pool`) is intentional: this
 * worker is the exclusive synchronous-RPC target for exactly one
 * `PostgresStorageAdapter` instance in the host process (see
 * `sync-client.ts`), and `StorageAdapter.transaction()` needs BEGIN/COMMIT/
 * ROLLBACK to land on the same server-side connection as the statements
 * they bracket. A pool would risk handing different statements in the same
 * "transaction" to different connections. Real concurrency across daemon
 * processes is still provided by Postgres itself — each daemon process
 * gets its own worker + its own connection.
 */
runAsWorker(
  async (
    action: "init" | "query" | "begin" | "commit" | "rollback" | "end",
    ...args: unknown[]
  ) => {
    switch (action) {
      case "init": {
        const opts = args[0] as PostgresWorkerInitOptions;
        if (opts.pglite) {
          if (embedded) {
            await embedded.exec(RESET_EMBEDDED_SQL);
          } else {
            const { PGlite } = await import("@electric-sql/pglite");
            embedded = new PGlite() as unknown as NonNullable<typeof embedded>;
          }
          client = embedded;
        } else {
          const { Client } = await import("pg");
          const pgClient = new Client({
            connectionString: opts.connectionString,
            ssl: opts.ssl,
          });
          await pgClient.connect();
          client = pgClient;
        }
        if (client.exec) {
          await client.exec(opts.schemaSql);
        } else {
          await client.query(opts.schemaSql);
        }
        return "ok";
      }
      case "query": {
        if (!client) throw new Error("storage-postgres worker: query before init");
        const [sql, params] = args as [string, unknown[] | undefined];
        const result = await client.query(sql, params);
        return result.rows;
      }
      case "begin":
        await client!.query("BEGIN");
        return "ok";
      case "commit":
        await client!.query("COMMIT");
        return "ok";
      case "rollback":
        await client!.query("ROLLBACK");
        return "ok";
      case "end": {
        if (client !== undefined && client === embedded) {
          // Kept alive on purpose — see `embedded`.
          client = undefined;
          return "ok";
        }
        const maybeCloseable = client as unknown as { end?: () => Promise<void>; close?: () => Promise<void> };
        await maybeCloseable?.end?.();
        await maybeCloseable?.close?.();
        client = undefined;
        return "ok";
      }
      default:
        throw new Error(`storage-postgres worker: unknown action "${String(action)}"`);
    }
  },
);

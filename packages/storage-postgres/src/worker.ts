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
          const { PGlite } = await import("@electric-sql/pglite");
          client = new PGlite() as unknown as QueryableClient;
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

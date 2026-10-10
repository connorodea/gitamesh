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

/**
 * One worker thread serves every `PostgresStorageAdapter` in the process
 * (`synckit` caches its worker per worker file, so there is no way to give
 * each adapter its own). Each adapter therefore gets a numeric connection id
 * from `SyncPostgresClient`, and this worker keeps one client per id. That is
 * what keeps adapters isolated: separate `pg.Client` connections (so one
 * adapter's BEGIN/ROLLBACK never touches another's statements) and, in
 * tests, separate embedded Postgres instances.
 */
const connections = new Map<number, QueryableClient>();

/**
 * Embedded Postgres instances (test-only path) that are booted but not in use.
 *
 * An instance is never closed: freeing a PGlite (a WASM instance) from this
 * worker thread is what crashed V8 on Node 24 / Linux
 * (`Check failed: jit_page_->allocations_.erase(addr) == 1` in
 * `ThreadIsolation::UnregisterWasmAllocation`), killing the vitest fork and
 * surfacing as `ERR_IPC_CHANNEL_CLOSED` in CI. So a closed adapter returns its
 * instance here, and the next adapter reuses it after a schema reset. Two
 * adapters open at once get two instances. They hold no file or socket, so
 * process exit reclaims them.
 */
type EmbeddedClient = QueryableClient & { exec(text: string): Promise<unknown> };
const idleEmbedded: EmbeddedClient[] = [];
const embeddedIds = new Set<number>();

const RESET_EMBEDDED_SQL = "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;";

/**
 * `pg.Client` emits `error` when the server drops an idle connection
 * (restart, `pg_terminate_backend`, network loss). With no listener Node
 * throws it as an uncaught exception, which kills this worker thread for
 * every adapter in the process and leaves the host blocked in `Atomics.wait`.
 * The error is parked here instead and thrown from that adapter's next call.
 */
const brokenConnections = new Map<number, Error>();

function connection(id: number): QueryableClient {
  const broken = brokenConnections.get(id);
  if (broken) {
    throw new Error(`storage-postgres worker: connection ${id} was lost: ${broken.message}`);
  }
  const client = connections.get(id);
  if (!client) {
    throw new Error(`storage-postgres worker: connection ${id} is not open (closed or never initialised)`);
  }
  return client;
}

/**
 * A single, persistent connection per adapter (never a `pg.Pool`) is
 * intentional: `StorageAdapter.transaction()` needs BEGIN/COMMIT/ROLLBACK to
 * land on the same server-side connection as the statements they bracket. A
 * pool would risk handing different statements in the same "transaction" to
 * different connections. Real concurrency across daemon processes is still
 * provided by Postgres itself — each process gets its own connections.
 */
runAsWorker(
  async (
    action: "init" | "query" | "begin" | "commit" | "rollback" | "end",
    id: number,
    ...args: unknown[]
  ) => {
    switch (action) {
      case "init": {
        if (connections.has(id)) {
          throw new Error(`storage-postgres worker: connection ${id} is already open`);
        }
        const opts = args[0] as PostgresWorkerInitOptions;
        let client: QueryableClient;
        if (opts.pglite) {
          // If this throws, the instance is dropped rather than returned to
          // `idleEmbedded`: its state is unknown, and it is never closed.
          let embedded = idleEmbedded.pop();
          if (embedded) {
            await embedded.exec(RESET_EMBEDDED_SQL);
          } else {
            const { PGlite } = await import("@electric-sql/pglite");
            embedded = new PGlite() as unknown as EmbeddedClient;
          }
          await embedded.exec(opts.schemaSql);
          embeddedIds.add(id);
          client = embedded;
        } else {
          const { Client } = await import("pg");
          const pgClient = new Client({
            connectionString: opts.connectionString,
            ssl: opts.ssl,
          });
          pgClient.on("error", (err: Error) => {
            brokenConnections.set(id, err);
          });
          await pgClient.connect();
          try {
            await pgClient.query(opts.schemaSql);
          } catch (err) {
            await pgClient.end().catch(() => undefined);
            throw err;
          }
          client = pgClient;
        }
        connections.set(id, client);
        return "ok";
      }
      case "query": {
        const [sql, params] = args as [string, unknown[] | undefined];
        const result = await connection(id).query(sql, params);
        return result.rows;
      }
      case "begin":
        await connection(id).query("BEGIN");
        return "ok";
      case "commit":
        await connection(id).query("COMMIT");
        return "ok";
      case "rollback":
        await connection(id).query("ROLLBACK");
        return "ok";
      case "end": {
        const client = connections.get(id);
        if (!client) return "ok"; // closing twice is allowed
        connections.delete(id);
        const lost = brokenConnections.delete(id);
        if (embeddedIds.delete(id)) {
          try {
            // A transaction left open by a failed caller must not leak into
            // the next adapter that gets this instance.
            await client.query("ROLLBACK");
            idleEmbedded.push(client as EmbeddedClient);
          } catch {
            // Dropped, not closed (see `idleEmbedded`).
          }
          return "ok";
        }
        try {
          await (client as unknown as { end(): Promise<void> }).end();
        } catch (err) {
          if (!lost) throw err; // a lost connection cannot be ended cleanly
        }
        return "ok";
      }
      default:
        throw new Error(`storage-postgres worker: unknown action "${String(action)}"`);
    }
  },
);

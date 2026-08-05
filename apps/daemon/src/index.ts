import type { StorageAdapter } from "@gitamesh/core";
import {
  createFileSqliteStorage,
  createInMemorySqliteStorage,
} from "@gitamesh/storage-sqlite";
import { buildServer } from "./server.js";
import { mintToken, type Scope } from "./auth.js";

const LEASE_SWEEP_INTERVAL_MS = 5_000;

function parseArgs(argv: string[]): { bootstrapAdminToken: boolean } {
  return { bootstrapAdminToken: argv.includes("--bootstrap-admin-token") };
}

/**
 * Selects the storage backend at startup. Default is `sqlite` — zero
 * behavior change for existing single-process deployments. Set
 * `GITAMESH_STORAGE_DRIVER=postgres` (+ `GITAMESH_POSTGRES_URL` or
 * `DATABASE_URL`) for multi-process/multi-daemon production deployments.
 * `@gitamesh/storage-postgres` is imported dynamically so daemon
 * deployments that never opt into Postgres don't need `pg` resolvable at
 * all (see this function's Dockerfile / package.json notes).
 */
async function createStorage(): Promise<StorageAdapter> {
  const driver = (process.env.GITAMESH_STORAGE_DRIVER ?? "sqlite").toLowerCase();

  if (driver === "postgres" || driver === "postgresql") {
    const connectionString =
      process.env.GITAMESH_POSTGRES_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "GITAMESH_STORAGE_DRIVER=postgres requires GITAMESH_POSTGRES_URL (or DATABASE_URL) to be set.",
      );
    }
    const { createPostgresStorage } = await import("@gitamesh/storage-postgres");
    const ssl =
      process.env.GITAMESH_POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : undefined;
    return createPostgresStorage(connectionString, { ssl });
  }

  if (driver !== "sqlite") {
    throw new Error(
      `Unknown GITAMESH_STORAGE_DRIVER "${driver}". Supported: "sqlite" (default), "postgres".`,
    );
  }

  const dbPath = process.env.GITAMESH_DB_PATH ?? "./gitamesh.db";
  return process.env.GITAMESH_DB_PATH === ":memory:"
    ? createInMemorySqliteStorage()
    : createFileSqliteStorage(dbPath);
}

async function main(): Promise<void> {
  const { bootstrapAdminToken } = parseArgs(process.argv.slice(2));

  const storageDriver = (process.env.GITAMESH_STORAGE_DRIVER ?? "sqlite").toLowerCase();
  const dbPath = process.env.GITAMESH_DB_PATH ?? "./gitamesh.db";
  const storage = await createStorage();

  // Secure-by-default bind: loopback only unless explicitly opted out.
  // This matches the spec's "secure defaults for remote listening"
  // requirement — production TLS-termination + remote exposure is
  // Caddy's job in front of this daemon, not this daemon's.
  const bindHost = process.env.GITAMESH_BIND_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
  const port = Number(process.env.GITAMESH_PORT ?? 8787);

  const { app, sweepExpiredLeases } = buildServer({ storage });

  if (bootstrapAdminToken) {
    const minted = mintToken(storage, ["admin"] as Scope[]);
    // Deliberately bypasses the structured pino logger: this is the ONE
    // place the raw token is meant to be visible, and only once, only for
    // local dev bootstrap. Never logged again after this.
    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "==================== GITAMESH BOOTSTRAP ADMIN TOKEN ====================",
        `  ${minted.rawToken}`,
        "",
        "  This token has the `admin` scope (satisfies every route's scope",
        "  check) and is shown ONLY ONCE. Store it somewhere safe (e.g. your",
        "  shell's secret manager) — it is not recoverable from the database,",
        "  which stores only its SHA-256 hash.",
        "==========================================================================",
        "",
      ].join("\n"),
    );
  }

  const sweepTimer = setInterval(sweepExpiredLeases, LEASE_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  await app.listen({ host: bindHost, port });
  app.log.info(
    {
      host: bindHost,
      port,
      storageDriver,
      ...(storageDriver === "postgres" || storageDriver === "postgresql"
        ? {}
        : { dbPath: process.env.GITAMESH_DB_PATH ?? dbPath }),
    },
    "gitamesh daemon listening",
  );

  const shutdown = async () => {
    clearInterval(sweepTimer);
    await app.close();
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("gitamesh daemon failed to start:", err);
  process.exit(1);
});

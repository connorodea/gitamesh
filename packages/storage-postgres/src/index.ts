import {
  PostgresStorageAdapter,
  type PostgresStorageOptions,
} from "./adapter.js";

export { PostgresStorageAdapter } from "./adapter.js";
export type { PostgresStorageOptions } from "./adapter.js";
export { SCHEMA_SQL } from "./schema.js";

/** Connects to a real PostgreSQL server and ensures the schema exists. */
export function createPostgresStorage(
  connectionString: string,
  options?: { ssl?: boolean | Record<string, unknown> },
): PostgresStorageAdapter {
  return new PostgresStorageAdapter({
    connectionString,
    ssl: options?.ssl,
  });
}

/**
 * Test-only: an embedded, in-process Postgres (`@electric-sql/pglite`, a
 * devDependency of this package) instead of a real server — the Postgres
 * analogue of `@gitamesh/storage-sqlite`'s `createInMemorySqliteStorage`.
 * Never call this from production code (it will throw if pglite is not
 * installed, since it is intentionally not a production dependency).
 */
export function createEmbeddedPostgresStorageForTests(): PostgresStorageAdapter {
  const options: PostgresStorageOptions = { pglite: true };
  return new PostgresStorageAdapter(options);
}

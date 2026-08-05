import Database from "better-sqlite3";
import { SqliteStorageAdapter } from "./adapter.js";

export { SqliteStorageAdapter } from "./adapter.js";
export { SCHEMA_SQL } from "./schema.js";

export function createInMemorySqliteStorage(): SqliteStorageAdapter {
  const db = new Database(":memory:");
  return new SqliteStorageAdapter(db);
}

export function createFileSqliteStorage(path: string): SqliteStorageAdapter {
  const db = new Database(path);
  return new SqliteStorageAdapter(db);
}

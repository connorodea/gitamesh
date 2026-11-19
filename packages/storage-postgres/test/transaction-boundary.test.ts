import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmbeddedPostgresStorageForTests, type PostgresStorageAdapter } from "../src/index.js";
import { SyncPostgresClient } from "../src/sync-client.js";

let storage: PostgresStorageAdapter | undefined;

beforeAll(() => {
  createEmbeddedPostgresStorageForTests().close();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
  storage?.close();
  storage = undefined;
});

describe("Postgres transaction boundary recovery", () => {
  it("resets adapter state when begin fails before invoking the callback", () => {
    storage = createEmbeddedPostgresStorageForTests();
    const begin = vi.spyOn(SyncPostgresClient.prototype, "begin");
    begin.mockImplementationOnce(() => { throw new Error("begin failed"); });
    const callback = vi.fn();
    expect(() => storage!.transaction(callback)).toThrow("begin failed");
    expect(callback).not.toHaveBeenCalled();
    expect(() => storage!.transaction(() => {
      storage!.recordIdempotentResult("must-roll-back", { value: 1 });
      throw new Error("rollback second transaction");
    })).toThrow("rollback second transaction");
    expect(begin).toHaveBeenCalledTimes(2);
    expect(storage.lookupIdempotentResult("must-roll-back")).toBeUndefined();
  });

  it("uses one transaction for nested calls on the same adapter", () => {
    storage = createEmbeddedPostgresStorageForTests();
    const begin = vi.spyOn(SyncPostgresClient.prototype, "begin");
    const commit = vi.spyOn(SyncPostgresClient.prototype, "commit");
    const result = storage.transaction(() => storage!.transaction(() => {
      storage!.recordIdempotentResult("nested", { value: 2 });
      return 42;
    }));
    expect(result).toBe(42);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(storage.lookupIdempotentResult("nested")).toEqual({ value: 2 });
  });
});

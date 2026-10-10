import { afterEach, describe, expect, it } from "vitest";
import type { Repository } from "@gitamesh/protocol";
import type { StorageAdapter } from "../../src/storage-adapter.js";

/**
 * Behavioral spec for the repository part of `StorageAdapter`. Each
 * concrete adapter's test file calls this with its own factory, so SQLite
 * and Postgres are held to the same contract.
 */
export function runRepositoryStorageContract(
  adapterName: string,
  createStorage: () => StorageAdapter,
): void {
  const open: StorageAdapter[] = [];
  const fresh = (): StorageAdapter => {
    const storage = createStorage();
    open.push(storage);
    return storage;
  };
  afterEach(() => {
    while (open.length > 0) open.pop()!.close();
  });

  const repository = (overrides: Partial<Repository>): Repository => ({
    repository_id: "repo_1",
    namespace_id: "default",
    display_name: "gitamesh",
    git_common_dir: "/srv/git/gitamesh/.git",
    default_branch: "main",
    created_at: "2026-01-01T00:00:00.000Z",
    metadata: { local_repository_id: "repo_1", nested: { a: [1, 2] } },
    ...overrides,
  });

  describe(`${adapterName}: repositories`, () => {
    it("round-trips a repository, metadata included", () => {
      const storage = fresh();
      storage.saveRepository(repository({}));

      expect(storage.getRepository("repo_1")).toEqual(repository({}));
      expect(storage.getRepository("nope")).toBeUndefined();
    });

    it("lists repositories oldest first", () => {
      const storage = fresh();
      storage.saveRepository(repository({ repository_id: "repo_b", created_at: "2026-01-02T00:00:00.000Z" }));
      storage.saveRepository(repository({ repository_id: "repo_c", created_at: "2026-01-01T00:00:00.000Z" }));
      storage.saveRepository(repository({ repository_id: "repo_a", created_at: "2026-01-02T00:00:00.000Z" }));

      expect(storage.listRepositories().map((r) => r.repository_id)).toEqual(["repo_c", "repo_a", "repo_b"]);
    });

    it("lists nothing when no repository is stored", () => {
      expect(fresh().listRepositories()).toEqual([]);
    });

    it("a second save updates the record but keeps created_at and namespace_id", () => {
      const storage = fresh();
      storage.saveRepository(repository({}));
      storage.saveRepository(
        repository({
          namespace_id: "other",
          display_name: "renamed",
          git_common_dir: "/moved/.git",
          default_branch: "trunk",
          created_at: "2026-06-01T00:00:00.000Z",
          metadata: { local_repository_id: "repo_1" },
        }),
      );

      expect(storage.listRepositories()).toEqual([
        repository({
          display_name: "renamed",
          git_common_dir: "/moved/.git",
          default_branch: "trunk",
          metadata: { local_repository_id: "repo_1" },
        }),
      ]);
    });
  });
}

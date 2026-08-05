import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitameshError } from "@gitamesh/protocol";
import { resolveAndValidateResourceKey } from "../src/resource-key.js";
import { commitAll, createTempRepo, removeTempRepo, writeFile } from "./support/temp-repo.js";

describe("resolveAndValidateResourceKey", () => {
  let repoDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
    await writeFile(repoDir, "src/file.ts", "export const x = 1;\n");
    commitAll(repoDir, "add src/file.ts");

    outsideDir = await fs.mkdtemp(path.join(path.dirname(repoDir), "gitamesh-outside-"));
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "should not be reachable\n");
  });

  afterEach(async () => {
    await removeTempRepo(repoDir);
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("accepts and canonicalizes a normal in-repo resource key", async () => {
    const result = await resolveAndValidateResourceKey(repoDir, "./src/file.ts");
    expect(result).toBe("src/file.ts");
  });

  it("rejects lexical traversal (delegated to the core validator)", async () => {
    await expect(resolveAndValidateResourceKey(repoDir, "../outside.txt")).rejects.toBeInstanceOf(
      GitameshError,
    );
  });

  it("rejects a resource key that escapes the repo root via a symlink", async () => {
    // src/escape -> a symlink pointing OUTSIDE the repository root.
    await fs.symlink(outsideDir, path.join(repoDir, "src", "escape"), "dir");

    await expect(
      resolveAndValidateResourceKey(repoDir, "src/escape/secret.txt"),
    ).rejects.toBeInstanceOf(GitameshError);
  });

  it("accepts a resource key through a symlink that stays INSIDE the repo root", async () => {
    await fs.mkdir(path.join(repoDir, "real-dir"));
    await fs.writeFile(path.join(repoDir, "real-dir", "inner.txt"), "ok\n");
    await fs.symlink(
      path.join(repoDir, "real-dir"),
      path.join(repoDir, "link-dir"),
      "dir",
    );

    const result = await resolveAndValidateResourceKey(repoDir, "link-dir/inner.txt");
    expect(result).toBe("link-dir/inner.txt");
  });

  it("accepts a resource key naming a file that does not exist yet (not-yet-created output)", async () => {
    const result = await resolveAndValidateResourceKey(repoDir, "src/not-created-yet.ts");
    expect(result).toBe("src/not-created-yet.ts");
  });

  it("rejects a not-yet-created path whose PARENT directory escapes via symlink", async () => {
    await fs.symlink(outsideDir, path.join(repoDir, "src", "escape2"), "dir");

    await expect(
      resolveAndValidateResourceKey(repoDir, "src/escape2/not-created-yet.txt"),
    ).rejects.toBeInstanceOf(GitameshError);
  });
});

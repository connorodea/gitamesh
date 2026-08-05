import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getChangedPaths, getMergeBase } from "../src/diff.js";
import { commitAll, createTempRepo, removeTempRepo, writeFile } from "./support/temp-repo.js";

describe("getChangedPaths / getMergeBase", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
  });

  afterEach(async () => {
    await removeTempRepo(repoDir);
  });

  it("returns repo-relative changed paths between two commits", async () => {
    await writeFile(repoDir, "a.txt", "one\n");
    const base = commitAll(repoDir, "add a.txt");

    await writeFile(repoDir, "b.txt", "two\n");
    await writeFile(repoDir, "nested/c.txt", "three\n");
    const head = commitAll(repoDir, "add b.txt and nested/c.txt");

    const changed = await getChangedPaths(repoDir, base, head);
    expect(changed.sort()).toEqual(["b.txt", "nested/c.txt"]);
  });

  it("computes the merge base of two diverged branches", async () => {
    await writeFile(repoDir, "a.txt", "one\n");
    const base = commitAll(repoDir, "base commit");

    await writeFile(repoDir, "b.txt", "on branch A\n");
    commitAll(repoDir, "branch A commit");

    const mergeBase = await getMergeBase(repoDir, "HEAD", base);
    expect(mergeBase).toBe(base);
  });
});

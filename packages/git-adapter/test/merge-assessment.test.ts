import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assessMergeConflict } from "../src/merge-assessment.js";
import { commitAll, createTempRepo, git, removeTempRepo, writeFile } from "./support/temp-repo.js";

describe("assessMergeConflict", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
    await writeFile(repoDir, "a.txt", "one\n");
    commitAll(repoDir, "base commit");
  });

  afterEach(async () => {
    await removeTempRepo(repoDir);
  });

  it("returns 'ready' for a cleanly mergeable branch", async () => {
    git(repoDir, ["checkout", "-b", "feature-clean"]);
    await writeFile(repoDir, "b.txt", "unrelated new file\n");
    commitAll(repoDir, "clean addition");
    git(repoDir, ["checkout", "main"]);

    const result = await assessMergeConflict(repoDir, "main", "feature-clean");
    expect(result).toBe("ready");
  });

  it("returns 'conflicted' when both branches edit the same line differently", async () => {
    git(repoDir, ["checkout", "-b", "feature-conflict"]);
    await writeFile(repoDir, "a.txt", "one\ntwo-from-feature\n");
    commitAll(repoDir, "feature edits a.txt");

    git(repoDir, ["checkout", "main"]);
    await writeFile(repoDir, "a.txt", "one\ntwo-from-main\n");
    commitAll(repoDir, "main edits a.txt (conflicts with feature)");

    const result = await assessMergeConflict(repoDir, "main", "feature-conflict");
    expect(result).toBe("conflicted");
  });

  it("returns 'stale' when the source branch ref no longer resolves", async () => {
    const result = await assessMergeConflict(repoDir, "main", "branch-that-does-not-exist");
    expect(result).toBe("stale");
  });

  it("returns 'stale' when the target branch ref no longer resolves", async () => {
    git(repoDir, ["checkout", "-b", "feature-only"]);
    await writeFile(repoDir, "c.txt", "x\n");
    commitAll(repoDir, "feature-only commit");

    const result = await assessMergeConflict(repoDir, "no-such-target", "feature-only");
    expect(result).toBe("stale");
  });

  it("never mutates the working tree, index, HEAD, or current branch", async () => {
    git(repoDir, ["checkout", "-b", "feature-clean-2"]);
    await writeFile(repoDir, "d.txt", "another unrelated file\n");
    commitAll(repoDir, "clean addition 2");
    git(repoDir, ["checkout", "main"]);

    const branchBefore = git(repoDir, ["branch", "--show-current"]).trim();
    const headBefore = git(repoDir, ["rev-parse", "HEAD"]).trim();
    const statusBefore = git(repoDir, ["status", "--porcelain"]).trim();

    await assessMergeConflict(repoDir, "main", "feature-clean-2");

    expect(git(repoDir, ["branch", "--show-current"]).trim()).toBe(branchBefore);
    expect(git(repoDir, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(git(repoDir, ["status", "--porcelain"]).trim()).toBe(statusBefore);
  });
});

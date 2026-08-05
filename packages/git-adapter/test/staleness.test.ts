import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isBaseShaStale } from "../src/staleness.js";
import { commitAll, createTempRepo, git, removeTempRepo, writeFile } from "./support/temp-repo.js";

describe("isBaseShaStale", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
  });

  afterEach(async () => {
    await removeTempRepo(repoDir);
  });

  it("is not stale when baseSha equals the branch's current tip", async () => {
    await writeFile(repoDir, "a.txt", "one\n");
    const tip = commitAll(repoDir, "commit 1");
    expect(await isBaseShaStale(repoDir, tip, "main")).toBe(false);
  });

  it("is not stale when baseSha is a strict ancestor (fast-forward-compatible)", async () => {
    await writeFile(repoDir, "a.txt", "one\n");
    const base = commitAll(repoDir, "commit 1");
    await writeFile(repoDir, "b.txt", "two\n");
    commitAll(repoDir, "commit 2 (fast-forward ahead of base)");

    expect(await isBaseShaStale(repoDir, base, "main")).toBe(false);
  });

  it("is stale when the branch has diverged from baseSha (baseSha not an ancestor)", async () => {
    await writeFile(repoDir, "a.txt", "one\n");
    commitAll(repoDir, "shared base");

    git(repoDir, ["checkout", "-b", "side"]);
    await writeFile(repoDir, "side.txt", "side work\n");
    const sideTip = commitAll(repoDir, "side commit");

    git(repoDir, ["checkout", "main"]);
    await writeFile(repoDir, "main-only.txt", "main work\n");
    commitAll(repoDir, "main-only commit, diverging from side");

    // sideTip is not an ancestor of main's new tip -> diverged -> stale.
    expect(await isBaseShaStale(repoDir, sideTip, "main")).toBe(true);
  });
});

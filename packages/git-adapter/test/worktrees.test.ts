import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listWorktrees, parseWorktreePorcelain } from "../src/worktrees.js";
import { commitAll, createTempRepo, git, removeTempRepo, writeFile } from "./support/temp-repo.js";

describe("parseWorktreePorcelain", () => {
  it("parses a multi-worktree porcelain blob including a detached one", () => {
    const porcelain = [
      "worktree /repo/main",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo/linked",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "branch refs/heads/feature",
      "",
      "worktree /repo/detached",
      "HEAD cccccccccccccccccccccccccccccccccccccccc",
      "detached",
      "",
      "worktree /repo/removed",
      "HEAD dddddddddddddddddddddddddddddddddddddddd",
      "branch refs/heads/removed",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    const blocks = parseWorktreePorcelain(porcelain);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({
      worktreePath: "/repo/main",
      branch: "main",
      detached: false,
    });
    expect(blocks[1]).toMatchObject({ worktreePath: "/repo/linked", branch: "feature" });
    expect(blocks[2]).toMatchObject({ worktreePath: "/repo/detached", detached: true, branch: null });
    expect(blocks[3]).toMatchObject({ worktreePath: "/repo/removed", prunable: true });
  });

  it("tolerates a trailing block with no final blank line", () => {
    const porcelain = "worktree /repo/main\nHEAD aaaa\nbranch refs/heads/main";
    const blocks = parseWorktreePorcelain(porcelain);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.worktreePath).toBe("/repo/main");
  });
});

describe("listWorktrees (real repo)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
    await writeFile(repoDir, "README.md", "hello\n");
    commitAll(repoDir, "initial commit");
  });

  afterEach(async () => {
    await removeTempRepo(repoDir);
  });

  it("lists the primary worktree as not dirty right after a commit", async () => {
    const worktrees = await listWorktrees(repoDir);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]?.branch).toBe("main");
    expect(worktrees[0]?.detached).toBe(false);
    expect(worktrees[0]?.dirty).toBe(false);
    expect(worktrees[0]?.head_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("detects a dirty working tree", async () => {
    await writeFile(repoDir, "README.md", "hello again, uncommitted\n");
    const worktrees = await listWorktrees(repoDir);
    expect(worktrees[0]?.dirty).toBe(true);
  });

  it("lists a linked worktree with its own branch and dirty state, sharing repository_id", async () => {
    const worktreeDir = `${repoDir}-linked`;
    git(repoDir, ["worktree", "add", "-b", "feature-z", worktreeDir]);
    await writeFile(worktreeDir, "scratch.txt", "wip\n");

    const worktrees = await listWorktrees(repoDir);
    expect(worktrees).toHaveLength(2);

    const linked = worktrees.find((w) => w.branch === "feature-z");
    const main = worktrees.find((w) => w.branch === "main");
    expect(linked).toBeDefined();
    expect(linked?.dirty).toBe(true);
    expect(main?.repository_id).toBe(linked?.repository_id);

    await fs.rm(worktreeDir, { recursive: true, force: true });
  });

  it("reports a detached HEAD worktree with branch=null, detached=true", async () => {
    const headSha = git(repoDir, ["rev-parse", "HEAD"]).trim();
    const worktreeDir = `${repoDir}-detached`;
    git(repoDir, ["worktree", "add", "--detach", worktreeDir, headSha]);

    const worktrees = await listWorktrees(repoDir);
    const detached = worktrees.find((w) => w.canonical_path.includes("detached"));
    expect(detached?.detached).toBe(true);
    expect(detached?.branch).toBeNull();

    await fs.rm(worktreeDir, { recursive: true, force: true });
  });

  it("skips a prunable worktree whose directory no longer exists", async () => {
    const worktreeDir = `${repoDir}-removed`;
    git(repoDir, ["worktree", "add", "-b", "feature-removed", worktreeDir]);
    await fs.rm(worktreeDir, { recursive: true, force: true });

    const worktrees = await listWorktrees(repoDir);

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]?.branch).toBe("main");
  });

  it("resolves canonical_path through a symlink to its real, resolved location", async () => {
    const worktreeDir = `${repoDir}-real-wt`;
    git(repoDir, ["worktree", "add", "-b", "feature-symlink", worktreeDir]);

    const symlinkDir = path.join(os.tmpdir(), `gitamesh-symlink-${Date.now()}`);
    await fs.symlink(worktreeDir, symlinkDir, "dir");

    const worktrees = await listWorktrees(symlinkDir);
    const found = worktrees.find((w) => w.branch === "feature-symlink");
    expect(found).toBeDefined();
    // canonical_path must be the REAL path, not the symlink path we entered through.
    expect(found?.canonical_path).not.toBe(symlinkDir);
    expect(found?.canonical_path).toBe(await fs.realpath(worktreeDir));

    await fs.rm(symlinkDir, { force: true });
    await fs.rm(worktreeDir, { recursive: true, force: true });
  });
});

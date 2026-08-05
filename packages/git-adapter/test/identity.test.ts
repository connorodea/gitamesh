import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getOrCreateRepositoryId, getRepositoryIdentity } from "../src/identity.js";
import { git } from "./support/temp-repo.js";
import { commitAll, createTempRepo, removeTempRepo, writeFile } from "./support/temp-repo.js";

describe("getRepositoryIdentity", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
    await writeFile(repoDir, "README.md", "hello\n");
    commitAll(repoDir, "initial commit");
  });

  afterEach(async () => {
    await removeTempRepo(repoDir);
  });

  it("resolves the git-common-dir to the real .git directory", async () => {
    const identity = await getRepositoryIdentity(repoDir);
    const expected = await fs.realpath(path.join(repoDir, ".git"));
    expect(identity.gitCommonDir).toBe(expected);
  });

  it("falls back to the current branch as default branch when there is no remote", async () => {
    const identity = await getRepositoryIdentity(repoDir);
    expect(identity.defaultBranch).toBe("main");
  });

  it("prefers origin/HEAD's symbolic ref when a remote HEAD is configured", async () => {
    // Simulate a bare "remote" repo and set up origin/HEAD tracking.
    const remoteDir = `${repoDir}-remote.git`;
    git(repoDir, ["clone", "--bare", repoDir, remoteDir]);
    git(repoDir, ["remote", "add", "origin", remoteDir]);
    git(repoDir, ["fetch", "origin"]);
    git(repoDir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

    const identity = await getRepositoryIdentity(repoDir);
    expect(identity.defaultBranch).toBe("main");

    await fs.rm(remoteDir, { recursive: true, force: true });
  });

  it("resolves the SAME git-common-dir from a linked worktree", async () => {
    const worktreeDir = `${repoDir}-linked-wt`;
    git(repoDir, ["worktree", "add", "-b", "feature-x", worktreeDir]);

    const mainIdentity = await getRepositoryIdentity(repoDir);
    const worktreeIdentity = await getRepositoryIdentity(worktreeDir);

    expect(worktreeIdentity.gitCommonDir).toBe(mainIdentity.gitCommonDir);

    await fs.rm(worktreeDir, { recursive: true, force: true });
  });
});

describe("getOrCreateRepositoryId", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
    await writeFile(repoDir, "README.md", "hello\n");
    commitAll(repoDir, "initial commit");
  });

  afterEach(async () => {
    await removeTempRepo(repoDir);
  });

  it("generates a fresh id on first call and persists it", async () => {
    const { gitCommonDir } = await getRepositoryIdentity(repoDir);
    const id = await getOrCreateRepositoryId(gitCommonDir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const markerPath = path.join(gitCommonDir, ".gitamesh-repository-id");
    const onDisk = (await fs.readFile(markerPath, "utf8")).trim();
    expect(onDisk).toBe(id);
  });

  it("returns the SAME id on repeated calls", async () => {
    const { gitCommonDir } = await getRepositoryIdentity(repoDir);
    const first = await getOrCreateRepositoryId(gitCommonDir);
    const second = await getOrCreateRepositoryId(gitCommonDir);
    expect(second).toBe(first);
  });

  it("resolves to the SAME repository_id from multiple worktrees of one repo", async () => {
    const worktreeDir = `${repoDir}-linked-wt-2`;
    git(repoDir, ["worktree", "add", "-b", "feature-y", worktreeDir]);

    const mainIdentity = await getRepositoryIdentity(repoDir);
    const worktreeIdentity = await getRepositoryIdentity(worktreeDir);

    const idFromMain = await getOrCreateRepositoryId(mainIdentity.gitCommonDir);
    const idFromWorktree = await getOrCreateRepositoryId(worktreeIdentity.gitCommonDir);

    expect(idFromWorktree).toBe(idFromMain);

    await fs.rm(worktreeDir, { recursive: true, force: true });
  });
});

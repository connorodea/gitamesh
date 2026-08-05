import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { runGit, runGitAllowNonZero } from "./exec.js";

/**
 * The filename written inside a repository's resolved `git_common_dir`
 * that anchors a stable Gitamesh `repository_id` across every worktree of
 * the same repository, even before the daemon has ever seen it.
 *
 * Why `git_common_dir` and not the remote URL: a repo can have no remote
 * (yet), multiple remotes, or a remote URL that changes (fork migration,
 * protocol switch http->ssh) while remaining the SAME physical repository
 * on disk. `git_common_dir` is the one path every worktree of a repo
 * agrees on (each worktree's `.git` is a pointer file/dir back to it), so
 * writing a durable marker there is the stable anchor the spec calls for.
 */
export const REPOSITORY_ID_MARKER_FILENAME = ".gitamesh-repository-id";

export interface RepositoryIdentity {
  /** Absolute, resolved path to the repository's common git directory. */
  gitCommonDir: string;
  /** Best-effort default branch name (see resolution order below). */
  defaultBranch: string;
}

/**
 * Resolves the repository identity anchor for the repo containing `cwd`.
 *
 * `gitCommonDir` comes from `git rev-parse --git-common-dir`, which
 * returns the SAME path regardless of which worktree you run it from —
 * that is exactly the stability property Gitamesh needs.
 *
 * `defaultBranch` resolution order:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` (what the remote
 *      considers default, if a remote + its HEAD ref are configured).
 *   2. `git config init.defaultBranch` (local Git config default).
 *   3. The current branch (`git rev-parse --abbrev-ref HEAD`), if it does
 *      not resolve to the literal string "HEAD" (i.e. we're not detached).
 *   4. Falls back to the literal string "main".
 */
export async function getRepositoryIdentity(cwd: string): Promise<RepositoryIdentity> {
  const commonDirResult = await runGit(cwd, ["rev-parse", "--git-common-dir"]);
  const rawCommonDir = commonDirResult.stdout.trim();
  const gitCommonDir = path.isAbsolute(rawCommonDir)
    ? rawCommonDir
    : path.resolve(cwd, rawCommonDir);
  const resolvedCommonDir = await fs.realpath(gitCommonDir);

  const defaultBranch = await resolveDefaultBranch(cwd);

  return { gitCommonDir: resolvedCommonDir, defaultBranch };
}

async function resolveDefaultBranch(cwd: string): Promise<string> {
  const symbolicRef = await runGitAllowNonZero(cwd, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
  ]);
  if (symbolicRef.code === 0) {
    const ref = symbolicRef.stdout.trim();
    const shortName = ref.replace(/^refs\/remotes\/origin\//, "");
    if (shortName.length > 0) {
      return shortName;
    }
  }

  const configDefault = await runGitAllowNonZero(cwd, [
    "config",
    "--get",
    "init.defaultBranch",
  ]);
  if (configDefault.code === 0) {
    const branch = configDefault.stdout.trim();
    if (branch.length > 0) {
      return branch;
    }
  }

  const currentBranch = await runGitAllowNonZero(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (currentBranch.code === 0) {
    const branch = currentBranch.stdout.trim();
    if (branch.length > 0 && branch !== "HEAD") {
      return branch;
    }
  }

  return "main";
}

/**
 * Returns the durable Gitamesh `repository_id` for the repository whose
 * resolved git-common-dir is `gitCommonDir` — generating and persisting a
 * fresh UUID on first call, and returning the same value on every
 * subsequent call (from any worktree of the same repository).
 */
export async function getOrCreateRepositoryId(gitCommonDir: string): Promise<string> {
  const markerPath = path.join(gitCommonDir, REPOSITORY_ID_MARKER_FILENAME);

  try {
    const existing = await fs.readFile(markerPath, "utf8");
    const trimmed = existing.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const id = randomUUID();
  // Write to a temp file then rename, so a crash mid-write never leaves a
  // half-written marker that a later reader would treat as a valid id.
  const tmpPath = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, `${id}\n`, "utf8");
  await fs.rename(tmpPath, markerPath);
  return id;
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

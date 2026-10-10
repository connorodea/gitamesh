import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { Worktree } from "@gitamesh/protocol";

import { runGit, runGitAllowNonZero } from "./exec.js";
import { getOrCreateRepositoryId, getRepositoryIdentity } from "./identity.js";

interface RawWorktreeBlock {
  worktreePath: string;
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
}

/**
 * Parses `git worktree list --porcelain` output. Only the PORCELAIN
 * format is parsed — never the human-readable default table — because the
 * default format's column widths and wording are not a stable contract
 * across Git versions.
 *
 * Porcelain format is a blank-line-separated sequence of blocks, each a
 * sequence of `key value` (or bare `key`) lines, e.g.:
 *
 *   worktree /path/to/repo
 *   HEAD 3d3b2f...
 *   branch refs/heads/main
 *
 *   worktree /path/to/repo/../linked
 *   HEAD 9a9f1e...
 *   detached
 */
export function parseWorktreePorcelain(porcelain: string): RawWorktreeBlock[] {
  const blocks: RawWorktreeBlock[] = [];
  let current: RawWorktreeBlock | null = null;

  for (const line of porcelain.split("\n")) {
    if (line.trim() === "") {
      if (current) {
        blocks.push(current);
        current = null;
      }
      continue;
    }

    const spaceIndex = line.indexOf(" ");
    const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
    const value = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1);

    if (key === "worktree") {
      if (current) {
        blocks.push(current);
      }
      current = {
        worktreePath: value,
        headSha: null,
        branch: null,
        detached: false,
        bare: false,
        prunable: false,
      };
      continue;
    }

    if (!current) {
      // Malformed/unexpected leading line outside a "worktree" block; skip.
      continue;
    }

    switch (key) {
      case "HEAD":
        current.headSha = value;
        break;
      case "branch":
        current.branch = value.replace(/^refs\/heads\//, "");
        break;
      case "detached":
        current.detached = true;
        break;
      case "bare":
        current.bare = true;
        break;
      case "prunable":
        current.prunable = true;
        break;
      default:
        // locked / lock reasons etc. — not modeled yet.
        break;
    }
  }

  if (current) {
    blocks.push(current);
  }

  return blocks;
}

/**
 * Lists every worktree of the repository containing `cwd`, resolved
 * against the `Worktree` protocol schema.
 *
 * `canonical_path` is resolved to an absolute, SYMLINK-RESOLVED real path
 * (`fs.realpath`) — this is the concrete filesystem safety net that
 * `packages/core/resource-keys.ts` explicitly defers to "the not-yet-built
 * Git adapter": a resource key that is lexically safe can still escape the
 * repository root via a symlinked worktree path on disk, and only a real
 * `realpath` call against the actual filesystem can catch that.
 *
 * `dirty` is determined via a separate `git status --porcelain=v1` run
 * per worktree (the `worktree list --porcelain` output does not include
 * working-tree dirtiness).
 *
 * `worktree_id` is derived deterministically from the worktree's resolved
 * canonical path (paths are unique per worktree within a repository, and
 * stable across repeated calls — unlike a freshly generated UUID, which
 * would make `listWorktrees` non-idempotent for identity purposes). Callers
 * that need a daemon-assigned `worktree_id` should treat this as a stable
 * local key to correlate against, not as the daemon's own id.
 */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const { gitCommonDir } = await getRepositoryIdentity(cwd);
  const repositoryId = await getOrCreateRepositoryId(gitCommonDir);

  const listResult = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  const blocks = parseWorktreePorcelain(listResult.stdout);

  const worktrees: Worktree[] = [];
  const now = new Date().toISOString();

  for (const block of blocks) {
    if (block.bare || block.prunable) {
      // Bare repositories have no working tree to report dirtiness for.
      // Prunable entries point at worktrees that no longer exist on disk.
      continue;
    }

    const canonicalPath = await fs.realpath(path.resolve(block.worktreePath));
    const dirty = await isWorkingTreeDirty(canonicalPath);

    worktrees.push({
      worktree_id: canonicalPath,
      repository_id: repositoryId,
      canonical_path: canonicalPath,
      head_sha: block.headSha ?? "",
      branch: block.detached ? null : block.branch,
      detached: block.detached,
      dirty,
      last_seen_at: now,
    });
  }

  return worktrees;
}

async function isWorkingTreeDirty(worktreePath: string): Promise<boolean> {
  const status = await runGitAllowNonZero(worktreePath, ["status", "--porcelain=v1"]);
  if (status.code !== 0) {
    // Could not determine status (e.g. worktree path vanished); treat as
    // dirty-unknown but do not throw — this is a read-only reporting path.
    return true;
  }
  return status.stdout.trim().length > 0;
}

import { runGitAllowNonZero } from "./exec.js";

export type MergeAssessment = "ready" | "conflicted" | "stale";

/**
 * A READ-ONLY assessment of whether `sourceBranch` can be integrated into
 * `targetBranch` without conflicts.
 *
 * This module NEVER calls `git merge`, `git checkout`, `git rebase`, or
 * anything else that mutates the working tree, the index, or HEAD — per
 * the project spec: "Gitamesh schedules and protects integrations. It
 * must not silently force merges or rewrite history." It uses
 * `git merge-tree`, which computes an in-memory merge and writes a tree
 * object to the object database, but never touches the working tree,
 * index, or any ref.
 *
 * Uses the modern single-invocation `git merge-tree --write-tree
 * <branch1> <branch2>` form (available since Git 2.38; this repo's
 * toolchain targets a newer Git where this is the primary, non-legacy
 * form). Exit code is the primary signal:
 *   - 0: merge completed with no conflicts -> caller should treat this as
 *     mergeable ("ready" once combined with the branch-resolution check
 *     below).
 *   - 1: merge completed WITH conflicts (conflict markers/info are
 *     written to stdout) -> "conflicted".
 *   - anything else: a real git failure (invalid refs, etc.) -> rejects.
 *
 * `"stale"` semantics: this function's signature intentionally takes only
 * branch NAMES, not a recorded `base_sha` (that richer check — comparing
 * a Task's own tracked `base_sha` against a branch's live tip — is
 * `isBaseShaStale` in `staleness.ts`, and callers that have a tracked base
 * should prefer calling that first). Given only two branch names, the one
 * staleness condition this function can detect on its own is a branch ref
 * that no longer resolves — i.e. `sourceBranch` (or `targetBranch`) was
 * deleted, force-pushed away, or renamed since the integration was queued.
 * That is reported as `"stale"` rather than thrown, because from the
 * `IntegrationState` lifecycle's point of view a vanished ref is exactly
 * what "stale" describes for a queued integration attempt: the thing it
 * was queued against no longer exists in its expected form, and it needs
 * to be re-queued rather than treated as a hard error.
 */
export async function assessMergeConflict(
  cwd: string,
  targetBranch: string,
  sourceBranch: string,
): Promise<MergeAssessment> {
  const targetResolved = await resolvesToCommit(cwd, targetBranch);
  const sourceResolved = await resolvesToCommit(cwd, sourceBranch);
  if (!targetResolved || !sourceResolved) {
    return "stale";
  }

  const mergeTree = await runGitAllowNonZero(cwd, [
    "merge-tree",
    "--write-tree",
    "--no-messages",
    targetBranch,
    sourceBranch,
  ]);

  if (mergeTree.code === 0) {
    return "ready";
  }
  if (mergeTree.code === 1) {
    return "conflicted";
  }

  throw new Error(
    `git merge-tree --write-tree ${targetBranch} ${sourceBranch} (cwd=${cwd}) exited with unexpected code ${mergeTree.code}: ${mergeTree.stderr.trim()}`,
  );
}

async function resolvesToCommit(cwd: string, ref: string): Promise<boolean> {
  const result = await runGitAllowNonZero(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.code === 0;
}

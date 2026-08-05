import { runGit, runGitAllowNonZero } from "./exec.js";

/**
 * Determines whether `baseSha` (typically a `Task.base_sha` an attempt was
 * scheduled against) has gone stale relative to `branch`'s current tip.
 *
 * Not stale ("fast-forward-compatible") when either:
 *   - `baseSha` IS `branch`'s current tip (nothing has moved), or
 *   - `baseSha` is an ancestor of `branch`'s current tip (branch has moved
 *     forward, but strictly ahead of — not diverged from — the base).
 *
 * Stale (diverged) when `baseSha` is NOT an ancestor of the current tip —
 * i.e. `branch` has commits that are not reachable from `baseSha` in a way
 * that a plain fast-forward could reconcile, so whatever was planned
 * against `baseSha` needs to be re-evaluated against the new tip.
 *
 * Implemented via `git merge-base --is-ancestor <baseSha> <branch>`, whose
 * exit code IS the answer: 0 means ancestor (not stale), nonzero means
 * diverged (stale) — including exit codes for "no such commit", which we
 * also treat conservatively as stale rather than throwing, since a base
 * that no longer resolves is definitionally no longer valid.
 */
export async function isBaseShaStale(
  cwd: string,
  baseSha: string,
  branch: string,
): Promise<boolean> {
  const tipResult = await runGit(cwd, ["rev-parse", branch]);
  const tip = tipResult.stdout.trim();
  if (tip === baseSha) {
    return false;
  }

  const ancestorCheck = await runGitAllowNonZero(cwd, [
    "merge-base",
    "--is-ancestor",
    baseSha,
    branch,
  ]);
  return ancestorCheck.code !== 0;
}

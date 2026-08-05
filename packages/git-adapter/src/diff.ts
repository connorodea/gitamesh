import { runGit } from "./exec.js";

/**
 * Repo-relative paths changed between `baseSha` and `headSha` (exclusive
 * of `baseSha`'s own state, inclusive of `headSha`'s), via
 * `git diff --name-only <base>..<head>`. Argument array, not a shell
 * string — `baseSha`/`headSha` may be attacker- or agent-controlled and
 * must never be interpolated into a shell command.
 */
export async function getChangedPaths(
  cwd: string,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const result = await runGit(cwd, ["diff", "--name-only", `${baseSha}..${headSha}`]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The merge base (best common ancestor) of two commit-ish refs `a` and `b`. */
export async function getMergeBase(cwd: string, a: string, b: string): Promise<string> {
  const result = await runGit(cwd, ["merge-base", a, b]);
  return result.stdout.trim();
}

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { invalidResourceKey } from "@gitamesh/protocol";
import { validateResourceKey } from "@gitamesh/core";

/**
 * Combines `packages/core`'s pure, lexical `validateResourceKey` with the
 * real filesystem check that module explicitly defers to this package:
 * resolving the (already lexically-canonicalized) key against the actual
 * repository root on disk and verifying the REAL, symlink-resolved path
 * still lives inside the repository root.
 *
 * This is invariant #7 from the spec: "Absolute paths, NUL bytes,
 * traversal, repository escape, and symlink escape are rejected." The
 * lexical layer (`validateResourceKey`) already rejects the first three;
 * this function adds the last two, which require touching a real
 * checkout: a resource key can be lexically perfect (`vendor/lib.ts`) and
 * still resolve, via a symlink planted somewhere along that path, to a
 * location outside `repoRoot` entirely.
 *
 * Returns the resolved, canonical, repo-relative resource key (using
 * forward slashes) on success; throws the same `invalidResourceKey`
 * problem-details error `packages/core` uses, so callers get one uniform
 * error shape regardless of which layer rejected the key.
 */
export async function resolveAndValidateResourceKey(
  repoRoot: string,
  resourceKey: string,
): Promise<string> {
  const canonicalKey = validateResourceKey(resourceKey);

  const realRepoRoot = await fs.realpath(repoRoot);
  const candidatePath = path.join(realRepoRoot, canonicalKey);

  const realResolvedPath = await realpathAllowingMissingLeaf(candidatePath);

  const relative = path.relative(realRepoRoot, realResolvedPath);
  const escapesRoot =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

  if (escapesRoot) {
    throw invalidResourceKey({
      resourceKey,
      reason: "resolves (after symlink resolution) to a path outside the repository root",
    });
  }

  return canonicalKey;
}

/**
 * Resolves symlinks along `candidatePath`, tolerating a final path segment
 * that does not yet exist on disk (a resource key may name a file that
 * will be created by the task that claims it — only a REAL, existing
 * symlink hop should be able to redirect the path, not the mere absence of
 * the leaf file). Walks up to the nearest existing ancestor, realpaths
 * that, then re-appends the missing suffix.
 */
async function realpathAllowingMissingLeaf(candidatePath: string): Promise<string> {
  try {
    return await fs.realpath(candidatePath);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const parent = path.dirname(candidatePath);
  if (parent === candidatePath) {
    // Reached filesystem root without finding an existing ancestor.
    return candidatePath;
  }

  const realParent = await realpathAllowingMissingLeaf(parent);
  return path.join(realParent, path.basename(candidatePath));
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

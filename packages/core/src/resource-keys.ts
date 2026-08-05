import { invalidResourceKey } from "@gitamesh/protocol";
import type { ResourceMode } from "@gitamesh/protocol";

/**
 * Pure string-processing validation and canonicalization for resource
 * keys (the `resource_key` field of a ResourceClaim).
 *
 * IMPORTANT SCOPE NOTE: this function does purely lexical/string-level
 * canonicalization and traversal rejection. It does NOT resolve symlinks,
 * does NOT touch the filesystem, and cannot detect a resource key that is
 * lexically safe but escapes the repository root via a symlink on disk.
 * That requires filesystem access scoped to a real checkout and belongs in
 * the (not-yet-built) Git adapter package, which will canonicalize a
 * resource key against an actual worktree before it reaches this layer in
 * production. This function only prevents encoding-level attacks
 * (`..` segments, absolute paths, NUL bytes) and normalizes equivalent
 * lexical forms (`./src/file.ts` === `src/file.ts`).
 */
export function validateResourceKey(rawKey: string): string {
  if (rawKey.includes("\0")) {
    throw invalidResourceKey({
      resourceKey: rawKey,
      reason: "contains a NUL byte",
    });
  }

  if (rawKey.trim().length === 0) {
    throw invalidResourceKey({
      resourceKey: rawKey,
      reason: "is empty",
    });
  }

  // Reject absolute POSIX paths and Windows drive-letter / UNC paths.
  if (
    rawKey.startsWith("/") ||
    rawKey.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(rawKey) ||
    rawKey.startsWith("~")
  ) {
    throw invalidResourceKey({
      resourceKey: rawKey,
      reason: "must be a repository-relative path, not absolute",
    });
  }

  // Normalize separators, split into segments.
  const rawSegments = rawKey.split(/[\\/]+/);

  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment === "" || segment === ".") {
      // Drop empty segments (from leading/trailing/duplicate slashes) and
      // no-op "." segments.
      continue;
    }
    if (segment === "..") {
      throw invalidResourceKey({
        resourceKey: rawKey,
        reason: 'contains a ".." traversal segment',
      });
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw invalidResourceKey({
      resourceKey: rawKey,
      reason: "resolves to an empty path after normalization",
    });
  }

  return segments.join("/");
}

/**
 * Splits an already-canonical resource key into its `/`-delimited
 * segments. Used for hierarchical prefix comparison.
 */
export function segmentsOf(canonicalKey: string): string[] {
  return canonicalKey.split("/");
}

/**
 * Two canonical resource keys "overlap" if one's segment path is a prefix
 * of the other's (inclusive of equality) at a `/` segment boundary. This
 * is a segment-wise comparison, not a raw string-prefix comparison — so
 * `src` overlaps `src/file.ts` but NOT `src2` (which would false-positive
 * under naive `startsWith`).
 */
export function pathsOverlap(canonicalA: string, canonicalB: string): boolean {
  const a = segmentsOf(canonicalA);
  const b = segmentsOf(canonicalB);
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.every((seg, i) => longer[i] === seg);
}

/**
 * Two resource claims conflict when their keys overlap hierarchically AND
 * at least one of the two claims is not a pure read. Read/read claims on
 * overlapping (or identical) keys are compatible. `exclusive` conflicts
 * with everything, including another `exclusive` on the same/overlapping
 * key.
 */
export function claimsConflict(
  keyA: string,
  modeA: ResourceMode,
  keyB: string,
  modeB: ResourceMode,
): boolean {
  if (!pathsOverlap(keyA, keyB)) {
    return false;
  }
  if (modeA === "read" && modeB === "read") {
    return false;
  }
  return true;
}

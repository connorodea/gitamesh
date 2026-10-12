import { invalidPathGlob } from "@gitamesh/protocol";

/**
 * Path-lock globs: repository-relative, `/`-separated paths that may use
 * the usual glob wildcards. A path with NO wildcard locks that path and
 * everything under it (`src` covers `src/a.ts`), matching the hierarchical
 * behavior of resource keys in `resource-keys.ts`.
 */
const WILDCARD = /[*?[\]{}]/;

export function canonicalizePathGlob(raw: string): string {
  let value = raw.trim().replace(/\\/g, "/");
  if (value === "") {
    throw invalidPathGlob({ path: raw, reason: "is empty" });
  }
  if (value.startsWith("/")) {
    throw invalidPathGlob({ path: raw, reason: "must be relative to the repository root" });
  }
  while (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (value === "" || value === ".") {
    throw invalidPathGlob({ path: raw, reason: "resolves to the repository root; use ** to lock everything" });
  }
  if (value.split("/").includes("..")) {
    throw invalidPathGlob({ path: raw, reason: 'contains a ".." segment' });
  }
  return value;
}

function hasWildcard(glob: string): boolean {
  return WILDCARD.test(glob);
}

/** Text before the first wildcard character. */
function literalPrefix(glob: string): string {
  const index = glob.search(WILDCARD);
  return index === -1 ? glob : glob.slice(0, index);
}

/** Text after the last wildcard character. */
function literalSuffix(glob: string): string {
  for (let i = glob.length - 1; i >= 0; i -= 1) {
    if (WILDCARD.test(glob[i]!)) return glob.slice(i + 1);
  }
  return glob;
}

function plainOverlapsGlob(plain: string, glob: string): boolean {
  const prefix = literalPrefix(glob);
  // The glob can match `plain` itself or something under it only if its
  // literal prefix is a prefix of `plain`, or lies inside `plain/`.
  return plain.startsWith(prefix) || prefix.startsWith(`${plain}/`);
}

/**
 * True when two canonical path globs CAN match a common path.
 *
 * Deliberately conservative: it never reports "no overlap" for two globs
 * that really share a path, but it may report an overlap for two that do
 * not (e.g. `src/a*.ts` vs `src/*b.ts`). For a lock, a refused acquire is
 * a cheap error; two agents editing one file is not. The two tests used
 * are necessary conditions for a shared match: any shared path starts
 * with both literal prefixes and ends with both literal suffixes.
 */
export function pathGlobsOverlap(a: string, b: string): boolean {
  const aWild = hasWildcard(a);
  const bWild = hasWildcard(b);

  if (!aWild && !bWild) {
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  }
  if (!aWild) return plainOverlapsGlob(a, b);
  if (!bWild) return plainOverlapsGlob(b, a);

  const prefixA = literalPrefix(a);
  const prefixB = literalPrefix(b);
  if (!prefixA.startsWith(prefixB) && !prefixB.startsWith(prefixA)) return false;

  const suffixA = literalSuffix(a);
  const suffixB = literalSuffix(b);
  return suffixA.endsWith(suffixB) || suffixB.endsWith(suffixA);
}

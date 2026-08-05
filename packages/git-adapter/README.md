# `@gitamesh/git-adapter`

A thin, safe wrapper around the `git` CLI. This is the filesystem-aware
layer that `packages/core/src/resource-keys.ts` explicitly defers to (see
its module doc comment): pure lexical resource-key validation lives in
`core`, and the *real filesystem/symlink safety net* — resolving a
resource key or worktree path against an actual checkout and rejecting
anything that escapes the repository root — lives here.

## Security posture

Every `git` invocation goes through `runGit`/`runGitAllowNonZero` in
`src/exec.ts`, which spawn `git` with `child_process.execFile` and an
**argument array** — never a shell-interpolated string. Branch names,
SHAs, and paths that flow through this package may originate from
untrusted agent output, and `execFile` has no shell in the loop, so there
is no `;`/`` ` ` ``/`$()` injection surface.

This package is **read-only with respect to the working tree, index, and
HEAD**. `assessMergeConflict` uses `git merge-tree --write-tree` (which
writes a tree object to the object database but never touches the
working tree or any ref) instead of `git merge`. Nothing in this package
calls `git merge`, `git checkout`, `git rebase`, or `git reset`.

## API

- **`getRepositoryIdentity(cwd)`** → `{ gitCommonDir, defaultBranch }`.
  `gitCommonDir` comes from `git rev-parse --git-common-dir`, which
  resolves to the SAME path from any worktree of a repository — this is
  the repository-identity stability property the daemon needs.
  `defaultBranch` resolution order: `origin/HEAD`'s symbolic ref → local
  `init.defaultBranch` config → current branch (if not detached) → `"main"`.

- **`getOrCreateRepositoryId(gitCommonDir)`** → a durable Gitamesh
  `repository_id`. On first call, generates a UUID and writes it to a
  `.gitamesh-repository-id` marker file inside the resolved
  `gitCommonDir` (via write-to-temp-then-rename, so a crash mid-write
  never leaves a corrupt marker). On every subsequent call — from ANY
  worktree of the same repository, since they all share the same
  `gitCommonDir` — it reads back the same id. This is what lets multiple
  worktrees of one repo resolve to the same `repository_id` even before
  the daemon has ever seen the repo.

- **`listWorktrees(cwd)`** → `Worktree[]` (the `@gitamesh/protocol`
  schema). Parses `git worktree list --porcelain` — the PORCELAIN format
  only; the default human-readable table is never parsed, since its
  column widths/wording are not a stable cross-version contract.
  `canonical_path` is `fs.realpath`-resolved, which is exactly the
  symlink-escape safety net `packages/core` defers to this package.
  `dirty` comes from a separate `git status --porcelain=v1` per worktree.
  `worktree_id` is set to the worktree's resolved canonical path
  (deterministic and stable across calls, unlike a fresh UUID each time).

- **`getChangedPaths(cwd, baseSha, headSha)`** → repo-relative paths via
  `git diff --name-only <base>..<head>`.

- **`getMergeBase(cwd, a, b)`** → `git merge-base <a> <b>`.

- **`isBaseShaStale(cwd, baseSha, branch)`** → `boolean`. Not stale when
  `baseSha` equals or is an ancestor of `branch`'s current tip
  (fast-forward-compatible); stale when `branch` has diverged from
  `baseSha`. Implemented via `git merge-base --is-ancestor`'s exit code.

- **`assessMergeConflict(cwd, targetBranch, sourceBranch)`** →
  `"ready" | "conflicted" | "stale"`, a READ-ONLY assessment via
  `git merge-tree --write-tree`. `"stale"` is returned (not thrown) when
  either branch ref no longer resolves to a commit — see the doc comment
  in `src/merge-assessment.ts` for the full reasoning on why that's the
  one staleness signal derivable from branch names alone (a richer,
  `Task.base_sha`-aware staleness check is `isBaseShaStale`, above).

- **`resolveAndValidateResourceKey(repoRoot, resourceKey)`** → the
  canonical, repo-relative resource key, after combining `@gitamesh/core`'s
  lexical `validateResourceKey` with a real `fs.realpath` check that the
  resolved path stays inside `repoRoot` — rejecting a symlink escape that
  no purely lexical check could catch. Tolerates a not-yet-created leaf
  path (a resource key may name a file the claiming task will create),
  while still rejecting an escape via a symlinked *parent* directory.

## Testing

Tests in `test/` build small, real, throwaway git repositories under
`fs.mkdtemp` (via `child_process.execFileSync`) — this is the one package
in the monorepo that legitimately shells out to real `git` and touches a
real (temporary) filesystem, including actual worktrees, branches,
detached HEADs, and a symlink deliberately planted to escape the repo
root.

Run just this package's tests: `pnpm --filter @gitamesh/git-adapter test`.

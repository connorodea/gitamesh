# LoopMem + Gitamesh global engineering continuity

## Ownership and authority

| Layer | Responsibility | Authoritative for |
|---|---|---|
| Git + tests | Current source and observed behavior | Code and validation |
| Gitamesh core/daemon | Task state, ownership, leases, resource claims, fencing, events | Concurrent coordination |
| LoopMem 0.3 shared store | Durable attributed constraints, decisions, facts, failures, next actions | Memory journal, **not** verified truth |
| `.agent/progress.md` | Human-readable chronological handoff | Local narrative, **not** exclusive locks |

Use the existing Gitamesh MCP LoopMem bridge, shipped previously, rather than implementing a second memory database. Gitamesh selects LoopMem namespace `repo-<sha256(repositoryId)>`, stable across worktrees. LoopMem supports local concurrent processes with short store locks; cross-host distributed writers and network filesystems are **not validated**.

## Prerequisites

- Rust >= 1.89 to build LoopMem from `connorodea/loopmem`.
- Gitamesh daemon and MCP server built and configured as described in their READMEs.
- Install LoopMem: `cargo install --path . --locked` from a trusted LoopMem checkout.
- Set `GITAMESH_LOOPMEM_BIN` to the installed binary (optional when on PATH).
- Set `GITAMESH_LOOPMEM_STORE` to an **absolute, persistent local path** in the Gitamesh MCP process environment.
- Configure Claude Code and Codex to use Gitamesh MCP (see `packages/mcp-server/README.md`); do not commit tokens.
- Gitamesh daemon defaults to 8787; the CLI's documented 4477 placeholder is stale.

Memory tools are disabled when `GITAMESH_LOOPMEM_STORE` is absent. The global installer only installs instructions and a Claude startup hook; it does not assume daemon availability or credentials.

## Agent lifecycle

1. Detect Git root and read local progress.
2. Obtain the **actual** Gitamesh repository ID; never derive a replacement ID from directory names.
3. Check Gitamesh daemon status, register agent, inspect tasks and claims.
4. Initialize LoopMem namespace once via `gitamesh_memory_init`; an already initialized namespace is expected and must not be overwritten.
5. Call `gitamesh_memory_context` or `gitamesh_memory_recall` at session start; verify retrieved claims against Git/tests.
6. Claim a task and required resources before overlapping edits. Respect 409 conflicts and fencing tokens. Heartbeat claimed attempts.
7. Record meaningful findings through `gitamesh_memory_remember` with `repositoryId`, `agentId`, `workspaceSessionId`, `kind`, `text`, and evidence; include task/attempt IDs where relevant.
8. Before compaction, restart, or handoff, save durable constraints, decisions, failures, and next actions; append local progress.
9. Complete task only after independent verification; never infer completion from LoopMem memory or the agent's narrative.

Memory kinds: `constraint`, `decision`, `fact`, `failure`, `next`. To correct a record, explicitly `supersedes` its active ID; if another writer wins, recall current memory and reconsider. Retrieval is text matching plus exact filters, **not semantic search**. Inspect truncation/limits.

## Existing LoopMem features to preserve

- Provider-agnostic shared CLI and MCP.
- Attributed memory and immutable event history.
- Concurrent local readers/writers with OS locking.
- Deterministic bounded context packets and compaction.
- Explicit supersession, provenance and evidence references.
- Optional legacy `--repo` loop runner and `loopmem-codex` adapter.
- Independent `--verify` checks for runner completion.

Do **not** conflate the legacy `loopmem --repo` local runner store with shared `--store` namespaces. The legacy `run` mode rejects `--store` and does not automatically publish its handoff to shared memory. Do not invoke shared-memory writes from a legacy adapter while its parent owns the same local store lock.

## Safety

- No secrets or sensitive content in memory or progress.
- Namespace labels are **not** authentication boundaries.
- Evidence references and agent labels are not proof.
- A successful memory write is not a successful build/test.
- Never auto-deploy, merge, or perform destructive actions without authorization.
- When LoopMem is unavailable, preserve progress locally and explicitly disclose missing cross-session memory.

## Verification plan (not yet executed)

1. Build and test LoopMem: `cargo test --locked --all-targets`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo fmt --all -- --check`.
2. Build/test Gitamesh MCP and daemon: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test`.
3. Run Gitamesh's real-binary integration tests with `LOOPMEM_TEST_BIN`.
4. Two agents, one repository ID: write/retrieve across sessions and worktrees.
5. Two repositories: verify namespace isolation.
6. Concurrent supersession: only one replacement succeeds; loser rereads.
7. Daemon down / memory store absent: degrade clearly, never fake ownership.
8. Test session restart, context budget exhaustion, secret handling, and idempotent global installation.

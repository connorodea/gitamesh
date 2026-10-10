# Global engineering continuity integration

Gitamesh owns **distributed task claims, leases, fencing tokens, and events**. The new global engineering continuity skill owns **agent behavior, evidence-based validation, repository-local progress history, and handoffs**. These are complementary, not competing state stores.

## Install

From a trusted local checkout:

```bash
bash scripts/install-engineering-continuity.sh
```

This installs the skill globally for Claude Code and Codex, appends idempotent instructions to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, and configures a Claude Code SessionStart hook. The hook initializes `.agent/progress.md` when opening a writable Git repository.

**Codex:** Global AGENTS.md instructs the agent to initialize and maintain the log, but this installer does not claim a Codex SessionStart hook exists. **Neither runtime is a background daemon**: automatic means when an agent session starts, not continuous monitoring while the agents are closed.

## Connect coordination

Build and run the existing Gitamesh daemon and MCP server following `apps/daemon/README.md` and `packages/mcp-server/README.md`. The MCP server documents global Claude and Codex configuration. Do not put bearer tokens in repository files. Gitamesh's daemon uses port **8787** by default; the CLI README documents an older 4477 placeholder, so explicitly configure the URL when using the CLI.

Use Gitamesh claims for concurrent work, not the progress Markdown file. A successful claim returns an attempt ID and fencing token; heartbeat while working, and complete/fail with that token. A 409 means ownership was not obtained. If the daemon is unreachable, report degraded coordination and avoid overlapping edits.

Optional LoopMem integration is documented in `packages/mcp-server/README.md`; it stores durable context, not exclusive ownership or verified test evidence.

## Scope and limitations

- Domain-agnostic: works for any project, language, or repository.
- Existing repositories initialize when opened, not in a destructive bulk migration.
- The progress log is append-only by instruction, but is **not** a concurrency-safe database.
- This installer does not auto-start the daemon, configure MCP credentials, create remote tasks, or install background services.
- Do not commit sensitive progress entries or credentials.
- Before deployment, test the installer on a disposable HOME and run repository CI.

## Next milestones

1. Add integration tests for idempotent install, pre-existing settings, malformed settings, and read-only repositories.
2. Add atomic per-session progress journals and a deterministic consolidation mechanism.
3. Expose an agent-session lifecycle bridge to Gitamesh's existing task and event API.
4. Resolve CLI/MCP daemon default URL divergence and verify end-to-end coordination.
5. Add optional OS-managed daemon service with explicit opt-in, health checks, and secure credential handling.

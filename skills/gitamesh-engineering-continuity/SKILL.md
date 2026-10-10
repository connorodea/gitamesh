---
name: gitamesh-engineering-continuity
description: Domain-agnostic, evidence-driven engineering progress and Gitamesh coordination for Claude Code and Codex.
---

# Gitamesh Engineering Continuity

Apply to every software development session, irrespective of project domain.

## Operating rules
- SEARCH BEFORE BUILD; COMPARE BEFORE MERGE; PROVE BEFORE PROMOTE.
- PRESERVE BEFORE REPLACE; INTEGRATE BEFORE EXPAND.
- Inspect repository instructions, git status, existing code, tests, and `.agent/progress.md` before implementation.
- Never claim a test passed without running it. Never claim a feature integrated merely because code exists.
- Do not silently overwrite another agent's work or make destructive repository changes.

## Session workflow
1. Locate the Git root (or current directory for a non-Git project); read existing `.agent/progress.md`.
2. Identify the immediate goal and acceptance criteria. Search for existing implementations.
3. If the Gitamesh MCP server is available, check `gitamesh_status`, list relevant tasks/claims, and register the agent as appropriate.
4. Before editing overlapping resources, claim the task with a workspace session ID and resource claims; honor 409 conflicts. Do not treat Markdown logs as locks.
5. Work incrementally. Record decisions, changed paths, executed validation commands, results, blockers, and next actions.
6. While a task is claimed, heartbeat its attempt with the returned fencing token. Never reuse a stale token.
7. Complete a Gitamesh task only after actual verification. If blocked or failed, report that state rather than inventing success.
8. On handoff, append a timestamped entry to `.agent/progress.md` with objective, agent, branch, paths, evidence, validation, status, risks, and next action.
9. If LoopMem is configured, recall relevant context at session start and persist durable decisions with provenance. Do not treat memory as a task lock or verified evidence.

## Progress format
```markdown
### YYYY-MM-DD HH:MM TZ — EVENT
- Agent:
- Session:
- Objective:
- Branch:
- Paths:
- Actions:
- Evidence:
- Validation: (command and actual outcome, or NOT RUN)
- Status: planned | in_progress | verified | blocked | deferred
- Risks:
- Next action:
```

Append only; never store secrets or personal data. Concurrent agents should coordinate log writes through a real serialization mechanism or separate per-session logs before consolidation.

## Degraded mode
When Gitamesh daemon, MCP, or network is unavailable, proceed only with work safe without coordination, preserve local progress, and clearly state that distributed ownership was NOT acquired. Do not claim a lease or task completion without the server acknowledging it.

## Boundaries
Do not auto-merge, force push, deploy, delete data, or bypass approvals. Repository policy takes precedence. Existing architectural direction must be evaluated before any replacement.

## LoopMem integration (required when configured)
Follow `docs/loopmem-global-continuity.md`. Use Gitamesh's existing `gitamesh_memory_*` MCP tools, not a new store. Obtain the actual repository ID first; the bridge hashes it into a stable namespace shared across worktrees. Initialize once, recall/context at session start, and remember attributed durable decisions, constraints, facts, failures, and next actions before compaction or handoff. Include agent ID, workspace session ID, and evidence; include task/attempt IDs when relevant. Correct stale entries using explicit supersession and reread after conflicts. Treat memory as fallible observations, not authority over source, tests, or task claims. LoopMem 0.3 only guarantees concurrency for local processes on a host; do not assume cross-machine synchronization. If the store is not configured, disclose memory unavailability and continue safely.

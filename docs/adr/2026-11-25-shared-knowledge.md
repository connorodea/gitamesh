# Shared knowledge with user-owned files

Date: November 25, 2026.

Status: Accepted direction; first local integration milestone implemented on the
feature branch. Deployment and live agent-client acceptance remain separate.

## Context

The owner accepted an agent-neutral shared workspace inspired by Obsidian's
local files and agent integrations. Gitamesh already provides coordination,
messages, claims, leases, and a LoopMem memory bridge. The missing connection is
between those agent-facing tools and readable knowledge that the owner can
retain and edit independently of an agent provider.

The intended experience is to maintain project goals and decisions once, let
different runtimes retrieve relevant context, preserve attributed findings, and
resume work without copying entire conversations between products.

## Decision

Adopt local open files as the authored knowledge surface. Add a small
`@gitamesh/knowledge` package shared by CLI and MCP. Obsidian is an optional
human interface to those files; it is not a runtime dependency.

Preserve distinct authorities:

| Concern | Authority |
| --- | --- |
| Authored knowledge and requirements | Original documents/files |
| Code and verified behavior | Git and observed test evidence |
| Coordination state and ownership | Existing Gitamesh daemon and configured storage; PostgreSQL remains the existing shared deployment option |
| Attributed memory, provenance, corrections | Existing LoopMem journal |
| Readable historical handoffs | Generated Markdown projection of a specific memory record |

The feature does not replace PostgreSQL with files, move task ownership into
Markdown, or introduce a second memory store. It does not change the daemon's
storage mode. Authored notes and agent memory remain fallible context for work;
neither alone establishes successful execution or completion.

## First milestone

- Bind one absolute local folder to one exact repository ID per MCP process.
- Read visible UTF-8 Markdown with relative paths and SHA-256 revisions.
- Build bounded context from authored notes, optional current LoopMem context,
  and optional task/claim reads. Report each source's availability and truncation.
- Reuse existing `gitamesh_memory_remember` for durable reports.
- Export an existing memory ID into immutable historical Markdown only when
  `GITAMESH_KNOWLEDGE_WRITABLE=true`; default access is read-only.
- Support optional source-hash preflight checks and idempotent export retries.
- Exclude generated `Handoffs/` history from automatic authored-note selection.

The concrete CLI and MCP tools, settings, budgets, and operational flow are in
[Local knowledge and durable handoffs](../local-knowledge.md).

## Why this shape

**Portable knowledge.** People can read and edit the same files through Obsidian
or other editors. An agent change does not require a knowledge migration.

**Reuse of existing coordination and memory.** Task ownership stays in the
existing coordination engine. Memory stays in LoopMem with attribution and
explicit supersession. The new package focuses on file access and projection.

**Recoverable export.** Saving memory and exporting it are distinct operations.
A failed export is retried with the existing ID, which avoids creating duplicate
memory records merely to retry a file write. Historical exports never overwrite
authored decisions.

**Visible uncertainty.** Source status distinguishes unavailable or intentionally
omitted information from a successful empty read. Hashes identify what was read;
timestamps and claims are observations rather than guarantees of ongoing ownership.

**Bounded scope.** Exact text matching and supplied paths are sufficient for the
first handoff. Semantic indexing, rich views, and broad document editing are
separate product decisions rather than prerequisites for local continuity.

## Consequences and limits

This implementation requires an MCP host or CLI that can access the configured
local filesystem. It does not create a cloud connector to a user's machine.
The current MCP transport remains stdio.

Source checks occur before export and do not lock out a human editor or sync
client. Filesystem checks are not an operating-system sandbox against another
hostile process. Generated history may refer to a superseded memory; clients
must use current LoopMem context when they need current memory state.

LoopMem's documented concurrency scope remains local processes on one host.
PostgreSQL coordination and vault synchronization do not independently provide
distributed LoopMem consistency. Cross-host memory and publishing require a
separate design with an enforced write boundary.

The next product slice should prove a live two-runtime handoff against the
same configured project. Transport and fixture-based tests establish software
contracts; provider sessions and the user's Obsidian environment require direct
acceptance evidence.

## Deferred

Reviewed authored-note publishing; approvals enforced on writes; automatic
agent installation and lifecycle wiring; Canvas, Bases, and graph views;
semantic indexing; cross-host memory services and sync reconciliation; and
production deployment. No completed task or approved decision is inferred from
a generated handoff.

# @gitamesh/mcp-server

An MCP ([Model Context Protocol](https://modelcontextprotocol.io)) **stdio
server** exposing Gitamesh coordination (agents, tasks, claims, events) as
tools an AI coding agent — Claude Code, Codex, Cursor, or any other
MCP-capable client — can call directly, instead of shelling out to
`gitamesh` or hand-rolling HTTP calls against the daemon.

Every tool's response is a schema-validated, structured JSON object (zod
schemas, `{ ok: true, ... } | { ok: false, error }`) — never a freeform
prose string, and never a thrown exception for an expected daemon-level
failure (404 not found, 409 conflict, network-unreachable). See "Design
notes" below.

## Dependency on the daemon client (temporary internal client)

This package is specified to be built on top of `@gitamesh/sdk-typescript`.
That package does not exist in this repo yet (as of this package's initial
implementation, it is being built concurrently by another agent working in
this same repo, uncommitted). Rather than block on it, `src/internal-client.ts`
is a small, private HTTP client written directly against `apps/daemon`'s
documented routes (`apps/daemon/README.md` + `apps/daemon/src/routes/*.ts`).
It is explicitly marked **temporary** in its own file header — once
`@gitamesh/sdk-typescript` lands with a stable client export, swap the
`workspace:*` dependency in and delete `internal-client.ts`; every tool
module only touches its small `DaemonClient` interface, so the swap is
localized to that one file plus the tool modules' imports.

## Running

```bash
# From the repo root, after `pnpm install`:
pnpm --filter @gitamesh/mcp-server build       # tsc -> dist/
pnpm --filter @gitamesh/mcp-server dev          # tsx src/index.ts (stdio)
pnpm --filter @gitamesh/mcp-server typecheck
pnpm --filter @gitamesh/mcp-server test         # vitest, fake-fetch, no real network
```

The built entry point is `dist/index.js` (also published as the
`gitamesh-mcp-server` bin). It speaks MCP over **stdio** — stdout is
reserved for the protocol stream, so all of this package's own logging
goes to stderr.

## Configuration

Resolved once at process start (`src/config.ts`), in this precedence order:

| Setting | Precedence |
|---|---|
| Daemon URL | `GITAMESH_URL` env var → `GITAMESH_DAEMON_URL` env var (CLI-compat) → `.gitamesh/config.yaml`'s `daemonUrl` → `http://127.0.0.1:8787` |
| Token | `GITAMESH_TOKEN` env var → a `token:` line in `.gitamesh/config.yaml` (unusual; config files get committed, tokens should not) → none |

`.gitamesh/config.yaml` is the same file, in the same location, in the same
flat `key: value` format that `packages/cli` (`gitamesh init`) writes and
reads. This package does **not** take a `workspace:*` dependency on
`@gitamesh/cli` to reuse its loader — `@gitamesh/cli` is an application
package (its `index.ts` barrel pulls in `commander` and every CLI
subcommand), and depending on it just to reuse ~20 lines of YAML-subset
parsing would be the wrong coupling for a small MCP adapter. Instead
`src/config.ts` re-implements the same minimal parser against the same
file, documented in that file's own header.

**Known cross-package inconsistency (not this package's to fix):**
`packages/cli/src/config.ts`'s own default daemon URL is
`http://127.0.0.1:4477`, documented in its own source as a placeholder
chosen before `apps/daemon` had a committed HTTP entry point. The daemon's
actual default (`GITAMESH_PORT`, see `apps/daemon/README.md`) is `8787`.
This package's default matches the **daemon's real default** (`8787`), not
the CLI's stale placeholder. If you run both the CLI and this MCP server
against the same daemon without setting an explicit URL, they currently
disagree — set `GITAMESH_URL`/`GITAMESH_DAEMON_URL` explicitly (or fix the
CLI's default) to avoid that.

## Tools

| Tool | Description |
|---|---|
| `gitamesh_status` | Daemon health plus this repository's open task and active-claim counts. Never returns `ok:false` for a merely-unreachable daemon — that IS the reported status. |
| `gitamesh_register_agent` | Registers an agent runtime (`{ agentId?, displayName, runtime, capabilities, namespaceId? }`). `agentId` is a caller hint stored as metadata — the daemon always assigns the real `agent_id` server-side; read it from the result. |
| `gitamesh_create_task` | Creates a task in a repository's workflow. |
| `gitamesh_list_tasks` | Lists tasks with `owner` (who holds each, last heartbeat), `readiness` (`ready`/`blocked`) and `blocked_by`. Filters: `repositoryId`, `status`, `agentId` (tasks that agent holds), `unclaimed` (free to claim). |
| `gitamesh_get_task` | One task with its owner, readiness, progress notes and revision history. |
| `gitamesh_update_task` | Changes `title`, `description`, `priority`, `branch`, `baseSha` or `dependencies` (replaces the list; `[]` clears it). Each change writes an append-only revision; pass `agentId` so it names you. |
| `gitamesh_add_task_note` | Appends a progress note (`{ taskId, agentId, body }`). |
| `gitamesh_claim_task` | Claims a task for an agent's workspace session, atomically acquiring any required resource locks. On conflict (already claimed / resource contention / not claimable / dependencies not complete) returns a **structured `ok:false` result**, never a thrown error. |
| `gitamesh_heartbeat` | Renews an in-progress attempt's lease via its fencing token. |
| `gitamesh_complete_task` | Marks a claimed attempt (and its task) complete, releasing its resource claims. |
| `gitamesh_fail_task` | Marks a claimed attempt failed; the task requeues unless the retry limit is exhausted. |
| `gitamesh_list_claims` | Lists active (unreleased) resource claims, optionally filtered by `repositoryId`. |
| `gitamesh_send_message` | Sends a message to one agent or to `"all"` (`{ from, to, body, repositoryId?, taskId? }`). Append-only. Use it instead of creating a task to talk to another agent. |
| `gitamesh_list_messages` | Lists messages, oldest first. Inbox: `{ to: <me>, unread: true }` (includes messages to `"all"`). Other filters: `from`, `since`, `repositoryId`, `taskId`. |
| `gitamesh_ack_message` | Marks a message read by an agent. A repeat returns `alreadyAcked: true`. |
| `gitamesh_acquire_lock` | Locks repository paths/globs for an agent (`{ agentId, repositoryId, paths, taskId?, ttlSeconds? }`, default 900 s). An overlap with another agent's live lock returns `ok:false` (`path-lock-conflict`) naming the holder; nothing is locked. |
| `gitamesh_list_locks` | Active path locks with holder and paths; optional `repositoryId` / `agentId`. |
| `gitamesh_heartbeat_lock` | Renews a path lock you hold. An expired lock returns `ok:false`; acquire again. |
| `gitamesh_release_lock` | Releases a path lock you hold. The record is kept. |
| `gitamesh_enqueue_integration` | **Not supported yet.** `apps/daemon` has no integration-candidate lifecycle (`packages/core` has no state machine for it; `packages/protocol`'s `IntegrationState` enum is unconsumed by any route). This tool stays **registered** — so the gap is discoverable via MCP tool listing — and always returns `{ ok: true, supported: false, reason: "..." }` rather than calling a nonexistent endpoint or silently disappearing. |
| `gitamesh_watch_events` | Returns up to `limit` events since cursor `since`, via the daemon's `GET /v1/events` — a request/response page, **not** a live subscription. See "Design notes" below for why. |

Every tool's Zod input/output schema lives alongside its handler in
`src/tools/*.ts`, reusing `packages/protocol`'s entity schemas
(`AgentSchema`, `TaskSchema`, `TaskAttemptSchema`, `ResourceClaimSchema`,
`EventEnvelopeSchema`, and the relevant enums) for output shapes, and
purpose-built request schemas for tool inputs (the daemon's creation/claim
bodies aren't full entities). `src/tool-result.ts` defines the shared
`{ ok: true, ... } | { ok: false, error }` envelope every tool uses.

## Design notes

**Why every tool returns `{ ok, ... }` instead of throwing.** The spec for
this package requires that MCP tool responses be structured and that a
claim conflict never throw an opaque error. This package applies that
uniformly: every daemon call funnels through
`fromDaemonResult()` (`src/tool-result.ts`), which turns *any* daemon-level
failure — 400 validation errors, 404 not-found, 409 conflicts, or a
completely unreachable daemon — into the same structured `ok: false`
shape, so a calling agent has exactly one pattern to branch on regardless
of which tool it called or why it failed.

**Why `gitamesh_watch_events` polls a cursor instead of streaming.** The
daemon exposes both a one-shot page (`GET /v1/events`) and a long-lived
WebSocket (`GET /v1/events/stream`) over the same event log. An MCP tool
call is a single request/response round trip with no standard mechanism
for a tool to "stay open" and keep pushing results after it returns.
Holding a WebSocket open inside a tool handler would either time out the
calling agent's tool call or require inventing a non-standard streaming
convention on top of MCP. So this tool implements "watch" as "fetch events
since a cursor" — pass the previous call's `nextCursor` back in as `since`
to poll with no gaps, exactly like the daemon's own WebSocket reconnect
semantics (both routes share the same `listEventsSince` storage method). A
genuinely live push mechanism belongs to a future daemon-side push
capability the agent runtime subscribes to directly, or a separate
long-running client process — not this stdio tool call.

## Usage examples

Build first (`pnpm --filter @gitamesh/mcp-server build`) so `dist/index.js`
exists, then point your MCP client at it. **This package never modifies
your global tool configuration for you** — wiring the server into a
specific client's config (the snippets below) is something you do
yourself.

### Claude Code

Either register it with the CLI:

```bash
claude mcp add gitamesh -- node /absolute/path/to/gitamesh/packages/mcp-server/dist/index.js
```

or add it directly to a project's `.mcp.json` (or `~/.claude.json` for a
user-wide install):

```json
{
  "mcpServers": {
    "gitamesh": {
      "command": "node",
      "args": ["/absolute/path/to/gitamesh/packages/mcp-server/dist/index.js"],
      "env": {
        "GITAMESH_URL": "http://127.0.0.1:8787",
        "GITAMESH_TOKEN": "gm_..."
      }
    }
  }
}
```

### Codex

Codex CLI reads MCP server definitions from `~/.codex/config.toml`:

```toml
[mcp_servers.gitamesh]
command = "node"
args = ["/absolute/path/to/gitamesh/packages/mcp-server/dist/index.js"]

[mcp_servers.gitamesh.env]
GITAMESH_URL = "http://127.0.0.1:8787"
GITAMESH_TOKEN = "gm_..."
```

### Cursor

Cursor reads project-local `.cursor/mcp.json` (or a user-wide
`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "gitamesh": {
      "command": "node",
      "args": ["/absolute/path/to/gitamesh/packages/mcp-server/dist/index.js"],
      "env": {
        "GITAMESH_URL": "http://127.0.0.1:8787",
        "GITAMESH_TOKEN": "gm_..."
      }
    }
  }
}
```

### A "remote" worker

There is no separate remote-transport variant built in this package — only
the standard stdio MCP server process above. For a worker running on a
different machine, "remote" simply means: run this same
`node dist/index.js` process **on that machine**, with `GITAMESH_URL`
pointed at a daemon it can reach over the network (and `GITAMESH_TOKEN` set
appropriately), and register it with whichever MCP client runs on that
machine using the same config shape as above. That is the normal, correct
way stdio MCP servers are deployed today — there is no special "remote
mode" to build here.

## What's NOT implemented (be honest about the gaps)

- **`gitamesh_enqueue_integration`** always reports `supported: false` — no
  daemon route exists for it yet (see the tools table above and
  `src/tools/enqueue-integration.ts`'s own doc comment).
- **`gitamesh_watch_events`** is a cursor-page poll, not a live push — see
  "Design notes" above.
- **No global-config auto-wiring.** This package does not touch
  `~/.claude.json`, `.cursor/mcp.json`, `~/.codex/config.toml`, or any
  other client config on your behalf; the snippets above are for you to
  add yourself.
- **The `@gitamesh/sdk-typescript` dependency is a placeholder.**
  `src/internal-client.ts` is intentionally minimal (no retries, no
  pagination helpers, no schema-generation tooling) — just enough to make
  these tools work and be tested. It is not a general-purpose SDK.


## Shared memory with LoopMem

The optional LoopMem bridge exposes provider-neutral memory to any agent that
uses this MCP server. Install LoopMem 0.3 or later and set these environment
variables on the Gitamesh MCP process:

```sh
GITAMESH_LOOPMEM_BIN=/absolute/path/to/loopmem
GITAMESH_LOOPMEM_STORE=/absolute/path/to/shared-memory
```

`GITAMESH_LOOPMEM_BIN` defaults to `loopmem` on PATH. Memory stays disabled until
`GITAMESH_LOOPMEM_STORE` is set to an absolute path. The bridge does not alter
client configuration. The existing coordination tools work without LoopMem.

| Tool | Use |
| --- | --- |
| `gitamesh_memory_init` | Initialize once with `repositoryId` and an optional `goal`. |
| `gitamesh_memory_remember` | Save `kind`, `text`, `agentId`, and `workspaceSessionId`; optionally add evidence, supersedes, taskId, or attemptId. |
| `gitamesh_memory_recall` | Read matching memory; optional query, kind, agentId, workspaceSessionId, includeSuperseded, and limit (1–500). |
| `gitamesh_memory_get` | Read a complete memory with `repositoryId` and `id`. |
| `gitamesh_memory_context` | Build bounded Markdown context from saved memory. |

Use `init` once, then `recall` or `context` at each session start. Use `remember`
to save durable facts, decisions, constraints, failed approaches, and next steps
before compaction or session end. Other agents read those entries using the same
`repositoryId`. Calls are explicit: the bridge does not capture conversations,
invoke models, compact a host session, or change Gitamesh task claims and leases.

The namespace is `repo-` followed by the SHA-256 hex digest of the exact UTF-8
`repositoryId`. This safely supports arbitrary repository IDs and remains stable
across worktrees and sessions. It does not use the current directory. Use the
same shared store path across MCP processes on a host. Access from another host
requires a separately supported shared service; this local bridge does not sync
files or make a network filesystem safe. Repository namespaces separate records;
they are not an authorization boundary between clients that can use this server.

Every memory write records agent and session provenance. Agent and session labels
must contain 1–256 UTF-8 bytes and no control characters. Optional task/attempt
references are saved as `gitamesh:task:ID` and `gitamesh:attempt:ID` evidence.
Evidence remains an unverified reference. Initialization does not create a memory
entry. Reads support legacy entries with absent or null provenance.

The bridge executes the CLI with an argument array, never a shell. Each command
has a 10-second timeout and a 1 MiB limit for each output stream. CLI JSON is
validated before it is returned. Failures use the existing structured `ok:false`
envelope. An already superseded replacement returns `loopmem-memory-conflict` and
instructs the caller to recall current memory before replacing it. Raw command arguments and child stderr are not echoed in errors. No
automatic retry occurs, so a write that times out has an unknown outcome: inspect
memory before repeating it. Context returns Markdown unchanged within that output
limit; LoopMem's own context budget governs content selection.

Run the optional real-binary integration test after building LoopMem:

```sh
LOOPMEM_TEST_BIN=/absolute/path/to/loopmem pnpm --filter @gitamesh/mcp-server test
```

It checks two agents sharing a repository namespace, explicit replacement,
preserved provenance, and separation between repository namespaces. The regular
tests need no daemon, model, API key, or LoopMem installation.

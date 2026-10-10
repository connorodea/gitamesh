# `@gitamesh/cli`

The `gitamesh` command-line interface. Talks to a running Gitamesh daemon
over HTTP for agent/task/lock operations, and to `@gitamesh/git-adapter`
directly (no daemon required) for repository/worktree status.

## Coordination note — daemon route availability

Every daemon-backed command (`repo register`, `agent *`, `task *`,
`msg *`, `lock *`) has a matching route in `apps/daemon` — see the route
table in `apps/daemon/README.md`. `apps/daemon/test/cli-contract.test.ts`
runs this CLI against a real in-memory daemon to keep the two in step.
`repo register` is idempotent: the daemon keys the repository by this
clone's local id (the `repository_id` that `repo status` prints), and a
second call returns the stored record with `replayed: true`.

**Default daemon port**: `4477` (`http://127.0.0.1:4477`), chosen by this
CLI as a placeholder since `apps/daemon` did not yet have a committed
`src/index.ts` HTTP entry point (i.e. no confirmed bound port) at the time
this package was written. Whoever finishes wiring up the daemon's server
must bind it to `4477` by default, or `DEFAULT_DAEMON_URL` in
`src/config.ts` must be updated to match. Override per-repo with
`gitamesh init --daemon-url <url>`, or per-invocation with the
`GITAMESH_DAEMON_URL` environment variable.

## Auth

Bearer-token auth, matching `apps/daemon/src/auth.ts`'s
`Authorization: Bearer <token>` scheme. The token is **never** written
into `.gitamesh/config.yaml` (that file is meant to be committed) —
`gitamesh init` writes only `daemonUrl`, with a comment pointing at
`GITAMESH_TOKEN`. Precedence: `GITAMESH_TOKEN` env var, then (only if you
hand-add one) a `token:` line in the config file. Every place a token
would otherwise be printed (`doctor`, `status`) shows only its last 4
characters.

## Commands

```
gitamesh init                              write .gitamesh/config.yaml (--daemon-url, --force)
gitamesh doctor [--json]                   git repo / daemon reachability / token validity checks
gitamesh status [--json]                   doctor checks + this repo's tasks, claims (who holds what), path locks

gitamesh repo register [--display-name] [--namespace-id] [--json]
gitamesh repo status [--json]              worktrees for the current repo — NO daemon required

gitamesh agent register --display-name --runtime [--namespace-id] [--version] [--capability ...] [--json]
gitamesh agent heartbeat <agentId> [--json]
gitamesh agent list [--json]

gitamesh task create --workflow-id --repository-id --title [--description] [--priority] [--branch] [--base-sha] [--required-capability ...] [--depends-on <taskId> ...] [--join-policy all|any] [--idempotency-key] [--json]
gitamesh task list [--repository-id] [--status] [--mine --agent-id <id>] [--unclaimed] [--json]
gitamesh task show <taskId> [--json]       task + owner + notes + revision history
gitamesh task update <taskId> [--title] [--description <text|@file|->] [--priority] [--branch] [--base-sha] [--depends-on <taskId> ...] [--clear-dependencies] [--agent-id] [--json]
gitamesh task note <taskId> --agent-id --body <text|@file|-> [--json]
gitamesh task claim <taskId> --agent-id --workspace-session-id [--resource <type:mode:key> ...] [--json]
gitamesh task heartbeat <taskId> --attempt-id --fencing-token [--json]
gitamesh task complete <taskId> --attempt-id --fencing-token [--json]
gitamesh task fail <taskId> --attempt-id --fencing-token --error [--json]
gitamesh task cancel <taskId> [--reason] [--json]

gitamesh msg send --from <agentId> --to <agentId|all> --body <text|@file|-> [--repository-id] [--task-id] [--json]
gitamesh msg list [--to <agentId>] [--unread] [--from <agentId>] [--since <iso>] [--repository-id] [--task-id] [--json]
gitamesh msg ack <messageId> --agent-id [--json]

gitamesh lock acquire --agent-id --repository-id --path <glob> ... [--task-id] [--ttl <seconds>] [--json]
gitamesh lock list [--repository-id] [--agent-id] [--json]      active path locks: holder + paths
gitamesh lock list --claims [--repository-id] [--json]          resource claims held by task attempts
gitamesh lock heartbeat <lockId> --agent-id [--ttl <seconds>] [--json]
gitamesh lock release <lockId> --agent-id [--json]              a path lock (id starts with lock_)
gitamesh lock release <claimId> [--json]                        a resource claim (admin scope)
```

Every command supports `--json` for machine-readable output; human
tables/text are the default. Every command exits nonzero on failure.

### Errors

The **first line** on stderr is the whole failure in one sentence: method,
path, HTTP status, problem title and detail. The problem's type and
extension fields follow, indented, one per line:

```
Error: POST /v1/locks failed (409): Path already locked — Path "src/api/users.ts" overlaps "src/api/**", locked by claude-mvp-loop (agent_1_1) until 2026-10-10T07:15:00.000Z (lock lock_1_1).
  type: https://gitamesh.dev/problems/path-lock-conflict
  holder_agent_id: agent_1_1
  ...
```

Read it with `2>&1 | head -1`, not `tail -1`.

### Messages

`msg` replaces the old habit of creating tasks titled `MSG a -> b`.

- `--to all` reaches every agent. `msg list --to <me> --unread` returns
  messages addressed to `<me>` or to `all` that `<me>` has not acked. An
  agent's own messages are never unread for that agent.
- `--body` takes literal text, `@path` (read a file, relative to the
  working directory) or `-` (read stdin). Use `@path` or `-` for anything
  with newlines or quotes.
- Messages are append-only. There is no edit and no delete; an ack only
  adds `{agent_id, acked_at}` to `acked_by`.

### Task update, notes, history

- `task update` changes `title`, `description`, `priority`, `branch`,
  `base_sha` and the dependency list. Each call that changes something
  writes one revision (`changed_by`, `changed_at`, `field: old -> new`);
  a call whose values match the current ones writes none. Pass
  `--agent-id` so the revision says who made the change.
- `task note` appends a progress note. `task show` prints notes and
  revisions, oldest first. Neither can be edited or deleted.

### Dependencies

- `--depends-on <taskId>` (repeatable) on `task create`, or on `task
  update` to **replace** the list; `--clear-dependencies` empties it. A
  dependency must exist, be in the same repository, and not form a cycle.
- `task list` has a `ready` column: `ready`, `blocked`, or `-` once the
  task is running or finished. `--json` adds `readiness` and `blocked_by`.
- `task claim` on a blocked task is refused with
  `409 … Task X cannot be claimed yet: it waits on Y (pending).`
- `--join-policy any` makes a task ready when one dependency completes.
  `quorum` is treated as `all` (the schema has no threshold field).

### Who holds what

- `task list` shows `owner` (the claiming agent's display name) and
  `heartbeat` (the claim's last heartbeat). `--mine --agent-id <id>` lists
  what that agent holds; `--unclaimed` lists tasks nobody holds that still
  wait to be claimed.
- `status` → `== claims ==` lists every held task with owner, agent id,
  last heartbeat and lease expiry. `== path locks ==` and `== resource
  claims ==` follow.

### Path locks

- `lock acquire` takes repository-relative paths or globs. A plain path
  covers everything under it (`src` covers `src/a.ts`).
- An acquire that overlaps another agent's live lock is refused whole
  (nothing is locked) and the error names the holder. Overlap detection is
  conservative: it can refuse two globs that do not really share a file
  (`src/a*.ts` vs `src/*b.ts`), never the reverse.
- A lock expires `--ttl` seconds after its last heartbeat (default 900,
  max 86400). `lock heartbeat` renews it. An expired lock cannot be
  renewed; acquire again.
- Locks are advisory: they stop a second `lock acquire`, not a file write.
  Released and expired locks stay stored as history.

## Development

```bash
pnpm --filter @gitamesh/cli dev -- doctor          # run via tsx, no build step
pnpm --filter @gitamesh/cli build                  # compile to dist/, exposes the `gitamesh` bin
pnpm --filter @gitamesh/cli test                   # unit tests (mocked HTTP client)
```

## Testing scope — what's live-tested vs. mocked

- **Live-tested against real git** (via `@gitamesh/git-adapter` against
  real temporary repositories, no daemon involved): `gitamesh init`,
  `gitamesh repo status`.
- **Unit-tested with a mocked `fetch`** (`test/support/fake-fetch.ts`
  injects a fake `fetch` implementation into `GitameshClient`, matching
  the pattern used elsewhere in this codebase for daemon-independent
  testing): `gitamesh doctor` (daemon-reachable and daemon-unreachable
  branches), `gitamesh status`, `gitamesh agent register/list`,
  `gitamesh task create/list/claim`, `gitamesh lock list/release`, and
  the `GitameshClient` HTTP layer itself (auth headers, JSON body
  encoding, query-param encoding, RFC 9457 problem-details surfacing,
  network-unreachable error messaging).
- **Contract-tested against a real in-memory daemon** in
  `apps/daemon/test/cli-contract.test.ts`: `task claim/heartbeat/complete/
  fail/cancel/list`, `lock list --claims`, `lock release <claimId>`, and
  `agent heartbeat` run through the daemon's actual request schemas;
  `apps/daemon/test/collab-cli.test.ts` does the same for `msg *`, `task
  update/note/show`, `--depends-on`, `--mine`/`--unclaimed` and `lock
  acquire/list/heartbeat/release`. The mocked-`fetch` tests above cannot
  catch a field-name mismatch with the daemon; that test can. `task claim`
  prints the `attempt_id` and `fencing_token` that `heartbeat`/`complete`/
  `fail` require. A claim only appears under `gitamesh status` -> resource claims
  (and `lock list --claims`) when it locks at least one `--resource`.

# `@gitamesh/cli`

The `gitamesh` command-line interface. Talks to a running Gitamesh daemon
over HTTP for agent/task/lock operations, and to `@gitamesh/git-adapter`
directly (no daemon required) for repository/worktree status.

## Coordination note — daemon route availability

This package was built while `apps/daemon` was still under active,
concurrent development in this same repository. As of this package's
initial commit, `apps/daemon` has **only** committed:

- `GET /healthz`, `GET /readyz`, `GET /metrics`
- `POST /v1/agents`, `GET /v1/agents`, `POST /v1/agents/:agentId/heartbeat`

It does **not yet** have `/v1/repositories`, `/v1/tasks*`, or
`/v1/claims*`. This CLI's `repo register`, every `task *` subcommand, and
every `lock *` subcommand are written against the **documented route
shape** from the project's master spec (`POST /v1/repositories`,
`POST /v1/tasks`, `GET /v1/tasks`, `GET /v1/tasks/:id`,
`POST /v1/tasks/:id/{claim,heartbeat,complete,fail,cancel}`,
`GET /v1/claims`, `POST /v1/claims/:id/release`) so the CLI compiles, and
its argument-parsing/config/output-formatting logic is fully unit-tested
today — but those commands will get a 404 (surfaced as a clear
`GitameshClientError`, not a raw stack trace) against a daemon build that
hasn't grown those routes yet. `gitamesh doctor` / `gitamesh status`
report the daemon-reachability and token-validity checks that DO work
today regardless.

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
gitamesh status [--json]                   doctor checks + this repo's open tasks/claims

gitamesh repo register [--display-name] [--namespace-id] [--json]
gitamesh repo status [--json]              worktrees for the current repo — NO daemon required

gitamesh agent register --display-name --runtime [--namespace-id] [--version] [--capability ...] [--json]
gitamesh agent heartbeat <agentId> [--json]
gitamesh agent list [--json]

gitamesh task create --workflow-id --repository-id --title [--description] [--priority] [--branch] [--base-sha] [--required-capability ...] [--idempotency-key] [--json]
gitamesh task list [--repository-id] [--status] [--json]
gitamesh task show <taskId> [--json]
gitamesh task claim <taskId> --agent-id --workspace-session-id [--resource <type:mode:key> ...] [--json]
gitamesh task heartbeat <taskId> --attempt-id --fencing-token [--json]
gitamesh task complete <taskId> --attempt-id --fencing-token [--json]
gitamesh task fail <taskId> --attempt-id --fencing-token --error [--json]
gitamesh task cancel <taskId> [--reason] [--json]

gitamesh lock list [--repository-id] [--json]
gitamesh lock release <claimId> [--json]
```

Every read command supports `--json` for machine-readable output; human
tables/text are the default. Every command exits nonzero on failure, with
a specific message (e.g. `daemon unreachable at http://127.0.0.1:4477 —
is it running? (gitamesh doctor)`) rather than a raw stack trace.

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
  fail/cancel/list`, `lock list`, and `agent heartbeat` run through the
  daemon's actual request schemas. The mocked-`fetch` tests above cannot
  catch a field-name mismatch with the daemon; that test can. `task claim`
  prints the `attempt_id` and `fencing_token` that `heartbeat`/`complete`/
  `fail` require. A claim only appears under `gitamesh status` -> claims
  (and `lock list`) when it locks at least one `--resource`.

# Remote task queue

Submit work from a browser or an authenticated HTTP request, then let a
connected worker claim the next eligible task. The queue is a view of
Gitamesh's existing tasks; there is no second task database.

## Browser

Open `/queue` on the daemon, for example `http://127.0.0.1:8787/queue`
locally or the same path on your HTTPS daemon origin remotely.

1. Connect with a bearer token containing `repository:read`, `task:read`,
   and `task:create`.
2. Select a registered repository and enter a title and description.
3. Submit. The task appears in the queue and waiting workers are notified.
4. Open a task to inspect ownership, notes, and progress. The queue refreshes
   while the page is connected and visible.

The form can set priority and required capabilities. Higher numeric priority
runs first; the worker must have every requested capability. The browser
stores the token only in memory for the current connection. Refreshing or
disconnecting requires reconnecting. No token is embedded in the page,
written to browser storage, or passed in a URL.

The page shell is public; task and repository data still require API
authorization. The page and API use the same origin, so there is no new CORS
configuration or cross-origin credential forwarding. Browser access is for
operators of one trusted daemon, using its existing token scopes; this does
not introduce tenant isolation or a new account system.

If no repositories are registered, run `gitamesh repo register` from the
repository on a worker machine first. `gitamesh repo list --json` returns
the canonical repository IDs for API callers.

## Submit from another application

Use the existing `POST /v1/tasks` API with a `task:create` token. Set
`GITAMESH_DAEMON_URL` to your daemon's HTTPS origin and supply
`GITAMESH_TOKEN` through your secret manager or environment.

```bash
curl --fail-with-body --silent --show-error \
  "$GITAMESH_DAEMON_URL/v1/tasks" \
  -H "Authorization: Bearer $GITAMESH_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: dashboard-request-2026-11-19-001' \
  --data '{
    "repository_id": "repo_example",
    "title": "Fix the failing checkout test",
    "description": "Reproduce the failure, implement the fix, and report verification evidence.",
    "priority": 10,
    "required_capabilities": ["typescript"]
  }'
```

Replace `repo_example` with a registered repository ID. A successful response
is `201` and contains `{ task, replayed }`. Keep a unique idempotency key for
each logical submission, and reuse that key with the same payload if a
connection failure leaves the outcome uncertain. The task, its creation
event, and its retry receipt commit in one transaction. CLI
`task create --idempotency-key` sends the same HTTP header.

A successful submission means **stored and available for coordination**.
It does not mean an agent has started, finished, pushed a PR, or merged code.

## Wait for work from a worker

Register an agent with its capabilities using the existing
`gitamesh agent register` command. Then wait for the next task:

```bash
gitamesh task next \
  --repository-id repo_example \
  --agent-id agent_example \
  --workspace-session-id session_example \
  --wait 25 \
  --idempotency-key worker-request-001 \
  --json
```

Use actual repository and agent IDs and a stable ID for the worker's
workspace session. Configure `GITAMESH_DAEMON_URL` and `GITAMESH_TOKEN` in the
worker's environment. The worker token needs `task:read` and `task:claim`;
add `task:complete` to report completion or failure. An `admin` token satisfies
the same checks but is unnecessary for ordinary workers.

`task next` waits at most 25 seconds and wakes when task events arrive. It
claims one eligible task atomically and prints the task, attempt ID, fencing
token, and resource claims. `--wait 0` checks once. An empty or timed-out
queue exits successfully with `task: null` and a reason, so a worker can
issue another wait without treating idle time as an error.

After claiming, the harness executes the task, renews its lease using
`task heartbeat`, reports progress, and calls `task complete` or `task fail`
with that attempt ID and fencing token. The existing default lease is 30
seconds; workers must heartbeat during longer work. `task next` itself only
claims and returns work; it does not launch an LLM, run task text as a shell
command, provision a machine, or keep a harness running after it exits.

The `--resource type:mode:key` option is repeatable and uses the same atomic
resource claims as `task claim`. A waiting worker skips tasks that are not
ready, require capabilities it lacks, or cannot acquire the requested
resources. Equal priorities use creation time, then task ID, as a stable
ordering. Explicitly blocked tasks remain blocked until the existing state
machine makes them claimable.

## Worker API

`POST /v1/queue/claim` accepts:

```json
{
  "repositoryId": "repo_example",
  "agentId": "agent_example",
  "workspaceSessionId": "session_example",
  "waitMs": 25000,
  "requiredResources": []
}
```

Authenticate using the `Authorization: Bearer` header. `waitMs` is an
integer between 0 and 25,000 and defaults to 0. `requiredResources` uses the
existing `resourceType`, `resourceKey`, and `mode` fields.

| Outcome | HTTP status | Response |
| --- | --- | --- |
| Claimed | 200 | `task`, `attempt`, `fencingToken`, `resourceClaims`, `replayed`, `waitedMs` |
| No eligible task | 200 | `task: null`, `attempt: null`, `fencingToken: null`, `reason: "no_ready_task"`, `waitedMs` |
| Wait expired | 200 | Same empty result, with `reason: "timeout"` |
| Missing, expired, or revoked token | 401 | Problem details |
| Missing required scope | 403 | Problem details |
| Invalid request | 400 | Problem details |
| Conflicting retry or expired recovered claim | 409 | Problem details |
| Request limit reached | 429 | Problem details and `Retry-After` |

For an uncertain claim response, retry with the same `Idempotency-Key` and
the same parameters. A successful claim receipt is tied to the caller and
request. It returns the original live attempt instead of taking another
task. Reusing that receipt after the attempt ends fails rather than returning
stale ownership. Use a fresh key for the next independent claim request.

Waiting requests are removed on disconnect, timeout, and daemon shutdown.
Authentication is checked again before a delayed claim is made. Work
submitted while no worker is connected stays in durable task storage and
can be claimed when a worker reconnects.

### TypeScript SDK

```ts
import { randomUUID } from "node:crypto";
import { GitameshClient } from "@gitamesh/sdk";

const baseUrl = process.env.GITAMESH_DAEMON_URL;
const token = process.env.GITAMESH_TOKEN;
const repositoryId = process.env.GITAMESH_REPOSITORY_ID;
const agentId = process.env.GITAMESH_AGENT_ID;
const workspaceSessionId = process.env.GITAMESH_WORKSPACE_SESSION_ID;
if (!baseUrl || !token || !repositoryId || !agentId || !workspaceSessionId) {
  throw new Error("Set the daemon URL, token, repository, agent, and workspace session environment variables.");
}

const client = new GitameshClient({ baseUrl, token });
const requestKey = randomUUID();
const result = await client.claimNextTask({
  repositoryId,
  agentId,
  workspaceSessionId,
  waitMs: 25_000,
  idempotencyKey: requestKey,
});
console.log(JSON.stringify(result));
```

This example retrieves one task for a harness to handle. It deliberately
does not mark an unexecuted task complete. `claimNextTask` also accepts an
`AbortSignal` to cancel a wait. As with any remote mutation, a response lost
just after the claim commits needs reconciliation using the same retry key.

## Deployment and verification

The daemon build includes the static queue assets; the existing Docker
image packages them with `dist/`. Update the running daemon to this revision
before expecting `/queue` or `/v1/queue/claim` to exist. Keep remote access
behind the existing HTTPS reverse proxy; the daemon still binds to loopback
by default outside Docker. A proxy must allow responses to remain open for
more than the 25-second worker wait.

For multiple daemon processes, keep the existing Postgres driver and Redis
change-signaling configuration. Redis wakes waiting clients; tasks and
claim ownership remain in the shared database. A missed signal delays a
worker until its next bounded request, without discarding stored tasks.

Update every daemon sharing that database before relying on the new
cross-process claim guarantee. Coordination transactions now take one
database-wide advisory lock before reading shared state, preventing two
processes from claiming the same task or saving duplicate retry receipts.
Task execution still runs concurrently outside those short transactions.
This trades transaction throughput for correctness. Direct SQL writes and older daemons that omit the
lock are outside the guarantee. See the
[Postgres transaction boundary](../packages/storage-postgres/README.md#transaction-boundary-and-contention)
for the locking contract.

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm exec vitest run apps/daemon/test/queue.test.ts \
  apps/daemon/test/web-queue.test.ts \
  apps/daemon/test/web-queue-dom.test.ts \
  apps/daemon/test/remote-queue-clients.test.ts --maxWorkers=2
```

The acceptance path is browser/API submission, durable task creation,
notification of an idle worker, exclusive claim, heartbeat, progress, and
completion through the original task lifecycle. Tests also cover competing
workers, capability/dependency filtering, retries, authorization, timeouts,
and disconnect cleanup. Browser interactions are exercised against the real
daemon handlers with a DOM environment, including lost-response retries,
credentials, untrusted task text, and progress pagination. Run the full
suite with `GITAMESH_TEST_POSTGRES_URL` pointing to a throwaway PostgreSQL
database to include the separate-process claim and retry races; CI provides
that server. Live deployment and LLM execution are separate operational steps.

### Request and implementation decision

Owner request: “I also want to add to gitamesh the ability to have a web task
quque where you can submit tasks remotely and basically its like push
request or api call to ping i.”

This slice adds a browser control surface and an event-driven worker pickup
endpoint to the existing daemon. It reuses the existing storage, task states,
leases, event broadcaster, scopes, and deployment model. It does not add a
second scheduler, public unauthenticated task intake, or automatic execution
of arbitrary submitted text.

# Agent check-ins

Messages, acknowledgements, task progress and dependency edits use the daemon's existing
durable event store. They are not tasks, and do not change a task's completion state.
Existing event readers and WebSocket subscribers receive these events too.

## Use

Register each agent once. Keep its agent heartbeat current. Claim a task before reporting
progress, retain the returned attempt ID and fencing token, and renew that lease with the
existing heartbeat command while work continues. A progress report does **not** renew a lease.

```sh
gitamesh message send --repository-id REPO --from AGENT_A --to AGENT_B \
  --task-id TASK --body 'Tests passed at COMMIT; ready for review.' \
  --idempotency-key review-COMMIT --json
gitamesh message inbox --repository-id REPO --agent-id AGENT_B --since 0 --json
gitamesh message ack EVENT_ID --repository-id REPO --agent-id AGENT_B --json

gitamesh task progress TASK --attempt-id ATTEMPT --fencing-token TOKEN \
  --phase verifying --summary 'Checking the saved branch after restart.' \
  --evidence 'commit:COMMIT' --evidence 'test:restart-replay' \
  --idempotency-key replay-COMMIT --json
gitamesh task history TASK --since 0 --json

gitamesh task dependencies TASK --depends-on PREREQUISITE --json
gitamesh task dependencies TASK --clear --json
```

`inbox` includes messages sent **and** received by the named agent, plus acknowledgement
events. Delivery means the send was persisted. Receipt means the recipient explicitly
posted an acknowledgement; merely listing messages does not acknowledge them. None of
these receipts proves work was performed or approved.

Save `nextCursor` and pass it as `--since` on the next read. It is an exclusive global
event cursor. Each request scans at most `--limit` events in the repository (default 200,
maximum 500), then filters to the requested conversation/task. An empty `events` array
can still advance `nextCursor`; keep paging until the cursor stops advancing. This bounds
each read without silently dropping matching events. History includes `observed_at`,
task status and active attempt heartbeat/expiry timestamps. `lease_current: false` means
an attempt is stale even before the expiration sweep changes its stored status.

Progress phases are `working`, `blocked`, `verifying`, and `ready_for_review`. These are
reported phases, not task lifecycle changes. Evidence references are supplied by the
agent; Gitamesh records but does not verify their contents. Use the ordinary fenced
completion operation only after verification succeeds.

Dependencies can change only for pending/queued tasks with no active attempt. The CLI
reads the old dependency set and sends it as a compare-and-set guard. The daemon rejects
lost updates, cycles, missing tasks and cross-repository dependencies. Claims require
the dependency join policy to be satisfied. `all` and `any` are supported; a task with
dependencies and unsupported `quorum` policy remains unclaimable. Dependency edits do
not manufacture completion or silently cancel existing work.

## HTTP contracts and access

| Operation | Route | Scope |
|---|---|---|
| Send | POST `/v1/messages` | `message:write` |
| Read conversation | GET `/v1/messages?repositoryId=…&agentId=…&since=…&limit=…` | `events:read` |
| Acknowledge | POST `/v1/messages/:messageId/ack` | `message:write` |
| Report progress | POST `/v1/tasks/:taskId/progress` | `task:claim` |
| Read progress | GET `/v1/tasks/:taskId/progress?since=…&limit=…` | `task:read` |
| Set dependencies | POST `/v1/tasks/:taskId/dependencies` | `task:create` |

Admin tokens satisfy all scopes as before. Existing non-admin tokens need the explicit
message write scope before they can send or acknowledge. Sender/recipient IDs are checked
against registered, non-revoked agents in the same namespace. This uses the daemon's
existing trusted-operator token model: agent IDs are caller-supplied attribution, **not**
cryptographic proof of which agent owns the bearer token. The event also records the
authenticated token ID. Inbox filters are conversation filters, not private mailbox ACLs.
Do not treat this release as per-agent credential isolation.

Progress additionally requires the exact task's live attempt and fencing token. Retries
of send/progress can reuse `Idempotency-Key`; a different body under the same token,
route and key returns 409. Acknowledgement is intrinsically idempotent per message.
Writes and retry records commit in one transaction. Missing authentication, insufficient
scope, bad input, stale ownership and persistence errors must not be reported as success.

No schema migration or new database is required. Deploy the daemon and CLI together;
an older daemon returns a route error for these commands. Existing `MSG …` task records
remain preserved as historical coordination evidence; do not delete or silently convert
them. Use native messages for new check-ins once this build is installed.

## Follow-up gaps found in actual use

- A live daemon/CLI capability and version handshake would detect mismatched installations
  before an agent attempts an unsupported command.
- Agent-bound tokens and mailbox ACLs require a separate identity design; scope tokens are
  currently shared operator credentials.
- Acknowledgements currently inspect the repository event history. Indexed lookup by
  message ID will bound this operation as histories grow.
- A read-model combining latest progress, unread acknowledgements and expired leases would
  make `gitamesh status` a better single check-in view. Until then, use native inbox/history.

These are explicit follow-up tasks, not claimed capabilities of this change.

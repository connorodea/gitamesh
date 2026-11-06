# ADR-0002: Async multi-agent orchestration

**Status:** Accepted
**Date:** 2026-11-06

## Context

The Claude cookbook pattern
[Async multi-agent orchestration](https://platform.claude.com/cookbook/patterns-agents-async-multi-agent-orchestration)
(June 2026) shows two shapes of multi-agent work:

1. A **fixed team**: one lead and N helpers coordinate through a shared
   in-process `Hub` (`inbox`, `event`, `status` per agent). Every agent has
   two tools: `send_message(recipient_ids, content)` (the only way to reach
   another agent) and `wait_for_message()` (blocks on an `asyncio.Event`
   with a 60 s timeout that returns `"woke: 60s timeout"` instead of
   raising). Messages that arrive while an agent works are appended to the
   result of its next tool call, so agents never poll.
2. **Dynamic subagents**: the lead also gets `create_subagents(base_instruction,
   per_subagent_instructions[≤10])`, which starts each helper as a background
   `asyncio.Task` and *returns immediately*; `get_status()`, which lists each
   helper as `active` / `idling` / `done` / `crashed`; and
   `kill_subagents(subagent_ids)`, which cancels them. Helpers report back by
   messaging the lead; the lead fans in by calling `wait_for_message`
   repeatedly. A crashed helper is visible in `get_status`, and teardown
   gathers all tasks with `return_exceptions=True` so one failure cannot
   stop cleanup.

The cookbook's version is one Python process with no persistence, no
retries, no leases and no cross-machine reach. Gitamesh already supplies
those properties for tasks. The question is what is missing to run the same
pattern through Gitamesh, across processes, runtimes (Claude Code, Codex,
opencode/DeepSeek workers) and machines.

## What Gitamesh already has

| Cookbook piece | Gitamesh primitive (before this ADR) |
| --- | --- |
| `Hub` | the daemon + its `StorageAdapter` (durable, multi-process with Postgres) |
| `send_message` / `wait_for_message` | `POST/GET /v1/messages`, `ack` (append-only, `to: "all"` broadcast) |
| messages arriving inline | `GET /v1/events` / `GET /v1/events/stream` cursor feed, `gitamesh_watch_events` |
| a helper's unit of work | a task, claimed with a lease + fencing token, completed with an optional `result` object |
| helper lifetime / `crashed` | attempt leases expire, the sweeper requeues; retries up to 3, then `failed` |
| `get_status` | `GET /v1/tasks` with owner, heartbeat and readiness |
| helper progress | `POST /v1/tasks/:id/progress` (fenced, never renews the lease) |
| "wait for B before C" | `dependencies` + `join_policy` (`all`/`any`), `evaluateFanIn` unblocks dependents |
| parent / child | `parent_task_id`; `cancelTask` cascades to `pending`/`blocked` children |

## The gap

Nothing let an orchestrator treat a set of children **as one unit**:

1. **Async dispatch of N subtasks.** Creating N children took N
   `POST /v1/tasks` calls, not atomic, with nothing recording that they form
   one fan-out.
2. **Fan-in with result collection.** The `result` a worker passes to
   `complete` was only stored in the `attempt.completed` event payload. No
   route returned the children's results, and nothing summarised them.
3. **Orchestrator wait-for-results.** An orchestrator could only poll
   `GET /v1/tasks` or tail the event stream and re-derive state itself.
4. **Timeouts / cancel.** `cancelTask` on a parent cascades only to
   children nobody has claimed; there was no "stop every straggler" call,
   which is what `kill_subagents` does.
5. **Partial-failure policy.** No shared vocabulary for "two of three
   succeeded".

## Decision

Add four calls on top of the existing parent/child relation. No schema,
storage-adapter or existing-route change; the only shared-code change is an
additive `EventBroadcaster.onChange` hook and an additive `--result` flag on
`gitamesh task complete`.

| Cookbook | New daemon route | CLI | MCP tool |
| --- | --- | --- | --- |
| `create_subagents` | `POST /v1/tasks/:id/dispatch` | `task dispatch` | `gitamesh_dispatch_subtasks` |
| `get_status` + reading reports | `GET /v1/tasks/:id/subtasks` | `task subtasks` | `gitamesh_get_subtask_results` |
| lead's `wait_for_message` loop | `POST /v1/tasks/:id/wait` | `task wait` | `gitamesh_wait_for_subtasks` |
| `kill_subagents` | `POST /v1/tasks/:id/cancel-subtasks` | `task cancel-subtasks` | `gitamesh_cancel_subtasks` |

Logic lives in `packages/core/src/orchestration.ts` (pure functions over
`StorageAdapter`, run inside the caller's transaction like `evaluateFanIn`);
routes in `apps/daemon/src/routes/orchestration.ts`.

**Dispatch.** `dispatchSubtasks` creates 1–100 children in one transaction
with `parent_task_id` set, the parent's repository, the parent's workflow
(unless overridden), and an optional shared `deadline_at`. Children start
`pending` like any task, so every existing worker path (claim, heartbeat,
progress, complete, fail) works on them unchanged. One
`task.subtasks_dispatched` event on the parent lists the child ids. The
route honours `Idempotency-Key`. A parent that is `completed`, `cancelled`
or `dead_letter` cannot take new children (409 `invalid-dispatch`). The
route does not require the caller to hold the parent: Gitamesh routes do not
tie a token to an agent, and the cookbook's lead does not hold a lock either.

**Fan-in.** `collectSubtaskResults` reads each child's latest
`attempt.completed.result` and `attempt.failed.error` from the event log the
engine already writes, so no new storage is needed. A child is **settled**
in `completed`, `failed`, `cancelled` or `dead_letter`. `failed` counts as
settled because the engine leaves a task `failed` only after its retries are
exhausted; a retryable failure goes back to `queued` and stays unsettled
(its last `error` is still reported). `overdue` marks an unsettled child
past its `deadline_at`.

**Partial-failure policy** is the `outcome` field, computed once all
children settle: `succeeded` (all completed), `partial` (at least one
completed, at least one not), `failed` (none completed, at least one
failed), `cancelled` (all cancelled); `running` before that and `empty` for
no children. The daemon reports; the orchestrator decides. Choosing what to
do with a partial result is domain logic, so Gitamesh does not retry,
re-dispatch or fail the parent on its own.

**Wait.** `POST /v1/tasks/:id/wait { until: "all"|"any", fail_fast,
timeout_ms ≤ 120000 }` returns at once if the condition already holds;
otherwise it registers an `EventBroadcaster.onChange` listener and re-checks
on every change notification (every mutating route already calls
`notifyNew()`; Redis signals from other daemon processes arrive through the
same path). Like the cookbook's `wait_for_message`, a timeout is a normal
`200 { woke: "timeout" }`, not an error, and the response always carries the
current summary. `woke` is one of `all_settled`, `any_succeeded`,
`failure` (`fail_fast` and a child failed for good), `no_subtasks`,
`timeout`. The 120 s cap keeps one wait under Node's default 300 s request
timeout; orchestrators loop for longer waits.

**Cancel.** `cancel-subtasks` calls the existing `CoordinationEngine.cancelTask`
on every unsettled child, *including claimed and running ones*: their
attempts are cancelled and their leases and resource claims released, and
grandchildren cascade as before. This differs on purpose from the automatic
cascade in `cancellation.ts` (which leaves running children alone): here an
orchestrator explicitly asked to stop them, as with `kill_subagents`. A
worker that later calls `complete` gets the existing stale-attempt 409. The
parent itself is not changed. `task wait --cancel-remaining` in the CLI is
wait followed by cancel when not everything settled.

**Not added.** Inline message delivery (agents in Gitamesh are separate
processes; the event stream and `gitamesh_watch_events` already cover it),
an `agent status` field (`owner` + heartbeat on each task already shows it),
quorum join (still blocked on a threshold field, see `fan-in.ts`), and an
automatic deadline sweeper (deadlines are reported as `overdue`; cancelling
is the orchestrator's call).

## Consequences

- Any runtime that can call the CLI or MCP can be an orchestrator or a
  worker, on any machine, and a crashed orchestrator can resume: the fan-out
  and every result survive in storage.
- Workers should pass a `result` object on complete (`--result '<json>'` in
  the CLI) for the orchestrator to collect.
- `collectSubtaskResults` scans the repository's events once per call. That
  is fine at current sizes; if repositories grow to very large event logs, a
  stored per-attempt result (or an index on `task_id`) is the follow-up.
- A long-poll holds an HTTP connection and an in-process listener; it is
  cleaned up on wake, timeout or client disconnect.
- Example: `apps/daemon/examples/async-orchestration.ts`.

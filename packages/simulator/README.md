# @gitamesh/simulator

A deterministic, seedable adversarial test harness for `@gitamesh/core`'s
`CoordinationEngine` — the master-spec "`gitamesh simulate`" scenario
runner (section 16).

It drives dozens of synthetic agents and tasks against a real
`CoordinationEngine` backed by a real, in-memory `@gitamesh/storage-sqlite`
adapter (`createInMemorySqliteStorage()`) — no real git repos, no real
HTTP daemon, no real worktrees. This is a **logical/protocol-level**
simulation of coordination correctness, not an integration test of
`apps/daemon` or `@gitamesh/git-adapter`.

## Usage

```sh
# from the repo root
pnpm --filter @gitamesh/simulator start -- --seed 42

# or, once built:
pnpm --filter @gitamesh/simulator build
node packages/simulator/dist/bin/gitamesh-simulate.js --seed 42
```

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--seed <n>` | `1` | PRNG seed. The same seed always produces the same sequence of scheduling decisions and the same pass/fail outcome. |
| `--scenario <name>` | (all) | Run exactly one scenario instead of the full registry. See "Scenarios" below for names. |
| `--agents <n>` | `20` | Synthetic agent fleet size (scenarios that don't need a full fleet size their own fixtures independently). |
| `--tasks <n>` | `40` | Task pool size hint (individual scenarios size their own fixtures; this is currently informational). |
| `--out <path>` | `./simulation-report.json` | Where to write the JSON report. |

Every run prints a human-readable console summary (one line per
scenario: `PASS` / `FAIL` / `SKIP` + a reason) and writes
`simulation-report.json` (or wherever `--out` points), and **exits
non-zero if any scenario's invariant assertion actually failed**
(`SKIP` does not count as a failure — see "Honest gaps" below).

Every failed scenario's report entry includes a `reproductionCommand`
string (e.g. `gitamesh simulate --seed 42 --scenario claim-race`) that
reproduces that scenario in isolation with the identical PRNG sequence
it got inside the full run — each scenario's PRNG seed is derived from
`(baseSeed, scenarioName)`, never from run order, so isolating one
scenario never changes its outcome.

## Determinism

The **only** source of randomness anywhere in this package is
`src/prng.ts`'s `mulberry32` generator (see its file comment). No
scenario, fixture, or the runner itself ever calls `Math.random()` or
lets wall-clock time influence a scheduling decision.

`simulation-report.json` deliberately never embeds:
- wall-clock timestamps (`occurred_at`, `created_at`, `expires_at`,
  etc. are all real-time-derived by `@gitamesh/storage-sqlite`'s
  `now()`, which is not clock-injectable in this milestone), or
- storage-generated ids (`attempt_id`, `lease_id`,
  `resource_claim_id`, `event_id` — `SqliteStorageAdapter.generateId`
  uses a module-level counter that only resets on a fresh process, so
  embedding these verbatim would make two runs *within the same
  process* diverge byte-for-byte even though the simulation logic
  didn't).

Task/workflow/repository ids and fencing tokens ARE embedded — they're
either caller-supplied (deterministic by construction) or a per-adapter-
instance DB counter that restarts at 1 for every fresh in-memory
database, so they're safe.

`test/determinism.test.ts` proves the strongest version of this claim:
it spawns the actual `gitamesh-simulate` CLI entrypoint as **two
separate OS processes** with the same `--seed` and asserts the two
`simulation-report.json` files are byte-identical. `test/scenarios.test.ts`
additionally proves every individual scenario module resolves to the
exact same `status`/`reason`/`timeline` across two in-process runs at a
fixed seed, and `test/prng.test.ts` proves the PRNG primitive itself is
deterministic.

## Scenarios

| # | name | status | what it proves |
| - | --- | --- | --- |
| 1 | `claim-race` | **implemented** | N agents race to claim the same pending task in one tick; exactly one wins, the rest get a clean 409. |
| 2 | `resource-claim-race` | **implemented** | Tasks with hierarchically-overlapping resource keys contend; only the non-conflicting ones (and at most one of the conflicting group) succeed. |
| 3 | `duplicate-claim-idempotency` | **implemented** | The same `idempotencyKey` submitted twice to `claimTask` replays instead of double-claiming. |
| 4 | `worker-crash-requeue` | **implemented** | An agent stops heartbeating mid-attempt; `expireStaleLeases` requeues the task and the next claim gets a strictly higher fencing token. |
| 5 | `stale-fencing-token-rejection` | **implemented** | A superseded ("zombie") agent's heartbeat/complete/fail calls are all rejected once a fresh attempt has taken over. |
| 6 | `snapshot-staleness-gap` | **honest gap** | See below. |
| 7 | `cancellation-cascade-gap` | **honest gap** | See below. |
| 8 | `fan-in-join-policy-gap` | **honest gap** | See below. |
| 9 | `integration-candidates-skipped` | **blocked, skipped** | See below. |
| 10 | `path-traversal-symlink` | **implemented** | Malicious resource keys (`../..`, absolute paths, NUL bytes, `~/...`) are rejected lexically, both directly via `validateResourceKey` and via `claimTask`, before anything is acquired. |
| 11 | `retry-idempotency-complete-fail` | **implemented** | A redelivered `completeAttempt`/`failAttempt` call (ack lost, retried) replays instead of double-mutating. |
| 12 | `redis-outage-equivalent` | **trivially skipped** | See below. |

Run `gitamesh simulate --help` (or `--scenario <name>` on its own) to
see each scenario's one-line description from the CLI itself.

### Honest gaps — real `packages/core` limitations, not simulator bugs

The spec (section 16) asks for scenarios that exercise several
coordination behaviors `packages/core` does not implement yet. Rather
than fabricate passing assertions against invented behavior, each of
these scenarios documents the gap and verifies the actual (absence of)
behavior instead:

- **`snapshot-staleness-gap`** (base branch / snapshot changing during
  analysis): `Task.base_sha` is a real, stored field, but
  `CoordinationEngine` never reads it. Real staleness detection
  (`isBaseShaStale`, comparing a recorded `base_sha` against a live
  branch tip via `git merge-base --is-ancestor`) lives entirely in
  `@gitamesh/git-adapter/src/staleness.ts` and requires a real git
  checkout — out of scope for a protocol/engine-level simulator. The
  scenario confirms two tasks with different `base_sha` values
  claim/complete identically, because nothing in the engine
  distinguishes them.
- **`cancellation-cascade-gap`** (cancellation propagation to child
  tasks): `CoordinationEngine` exposes exactly five operations
  (`claimTask`, `heartbeatAttempt`, `completeAttempt`, `failAttempt`,
  `expireStaleLeases`) — there is no `cancelTask`, and no logic
  anywhere that walks `Task.parent_task_id` / `Task.dependencies` to
  cascade a cancellation. `cancelled` IS a legal `TASK_TRANSITIONS`
  target state, so the state machine supports it, but nothing drives a
  task there or propagates it. The scenario cancels a parent directly
  via storage (there being no engine method to call) and confirms its
  child and dependent tasks are left untouched and independently
  claimable.
- **`fan-in-join-policy-gap`** (partial fan-in under a join policy):
  `Task.join_policy` (`"all" | "any" | "quorum"`) and
  `Task.dependencies` are real, validated schema fields, but nothing in
  `packages/core/src/engine.ts` ever reads either one — there is no
  fan-in evaluator. The scenario completes one of two `"any"`-policy
  dependencies and confirms the depending task's status is completely
  unaffected.
- **`integration-candidates-skipped`** (conflicting integration
  candidates): `IntegrationState` / `INTEGRATION_TRANSITIONS` are
  defined in `packages/core/src/state-machines.ts`, but there is no
  integration-candidate entity, no `StorageAdapter` methods for one,
  and no `CoordinationEngine` operation that creates, claims, verifies,
  or resolves one — the enum is otherwise unused. This scenario runs no
  engine calls at all; building a fake integration-candidate lifecycle
  here would test invented behavior, not Gitamesh's.
- **`redis-outage-equivalent`** ("Redis outage" equivalent): there is
  no Redis (or any pub/sub/notification) dependency anywhere in this
  repository. SQLite is the sole source of truth. "The system stays
  correct when signaling is absent" is vacuously true today because
  there is nothing to take down — this scenario intentionally
  constructs no fake Redis client and asserts nothing beyond that fact.

None of the five gap scenarios above are counted as failures — the
runner treats `"skipped"` as a distinct status from `"fail"` and only a
genuine assertion failure inside an implemented scenario produces a
non-zero exit code.

### A genuine nuance the simulator surfaced (not a defect, documented in `stale-fencing-token-rejection.ts`)

`heartbeatAttempt` has an explicit terminal-status guard that always
throws the specific 409 `stale-attempt-token` error for a non-
leased/running attempt. `completeAttempt` / `failAttempt` don't have
that same guard for the `"expired"` status (only for their own
`"completed"`/`"failed"` replay case) — once `expireStaleLeases` has
already flipped a zombie's attempt to `"expired"`, its own
`fencing_token` field is untouched, so the fencing-token comparison
passes, and the actual rejection instead comes from the generic 422
`invalid-state-transition` guard (`expired -> completed`/`failed` isn't
a legal edge). Both are correct rejections of the zombie's request
under the same underlying invariant (the request must not mutate
state) — they just surface through different one of core's two guard
mechanisms depending on which operation is called. The scenario
accepts either status code as a pass, matching how
`packages/core/test/engine.invariants.test.ts`'s own invariant #8 test
asserts generically (`toThrow(GitameshError)`) rather than pinning one
status code.

## Wiring into the `gitamesh` CLI

This is currently a **standalone package** with its own bin
(`gitamesh-simulate`), not a `gitamesh simulate` subcommand of
`@gitamesh/cli`. `@gitamesh/cli`'s existing commands
(`packages/cli/src/commands/*.ts`) are all built around talking to a
*running daemon* over HTTP (`packages/cli/src/client.ts`); this
simulator deliberately drives the in-process engine directly against an
in-memory store for speed and determinism, which doesn't fit that
pattern without either adding an HTTP round-trip it doesn't need or
teaching the CLI a second, daemon-less code path. Given
`packages/mcp-server` and `packages/sdk-typescript` were being built
concurrently in this same repo at the time this package was written,
adding a new subcommand to `packages/cli` risked stepping on that work
for a small ergonomic win. Wiring `gitamesh simulate` in as a thin
subcommand that imports `runSimulation`/`runSimulatorCli` from this
package's public exports (`src/index.ts`) is a natural, low-risk follow-up.

## Package layout

```
src/
  prng.ts                    deterministic mulberry32 PRNG + helpers (the ONLY randomness source)
  fixtures.ts                deterministic Task/agent-id builders (no wall clock, no real randomness)
  report.ts                  SimulationReport shape + JSON serialization
  runner.ts                  runSimulation() — orchestrates scenario execution
  cli.ts                     argv parsing + the CLI entrypoint logic (testable, no process.exit)
  bin/gitamesh-simulate.ts   thin shebang wrapper around cli.ts
  scenarios/
    types.ts                 Scenario / ScenarioContext / ScenarioResult / TimelineEntry types
    error-detail.ts           report-safe (deterministic) error description helper
    index.ts                  ALL_SCENARIOS registry, in a fixed order
    claim-race.ts
    resource-claim-race.ts
    duplicate-claim-idempotency.ts
    worker-crash-requeue.ts
    stale-fencing-token-rejection.ts
    snapshot-staleness-gap.ts
    cancellation-cascade-gap.ts
    fan-in-join-policy-gap.ts
    integration-candidates-skipped.ts
    path-traversal-symlink.ts
    retry-idempotency-complete-fail.ts
    redis-outage-equivalent-skipped.ts
test/
  prng.test.ts                PRNG determinism proofs
  scenarios.test.ts            every scenario resolves to its committed status at a fixed seed + timeline determinism
  runner.test.ts                report shape / reproduction-command contract
  determinism.test.ts          true end-to-end (separate-process) report byte-identity proof
```

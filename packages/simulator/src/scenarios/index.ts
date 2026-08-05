import { claimRaceScenario } from "./claim-race.js";
import { resourceClaimRaceScenario } from "./resource-claim-race.js";
import { duplicateClaimIdempotencyScenario } from "./duplicate-claim-idempotency.js";
import { workerCrashRequeueScenario } from "./worker-crash-requeue.js";
import { staleFencingTokenRejectionScenario } from "./stale-fencing-token-rejection.js";
import { snapshotStalenessGapScenario } from "./snapshot-staleness-gap.js";
import { cancellationCascadeGapScenario } from "./cancellation-cascade-gap.js";
import { fanInJoinPolicyScenario } from "./fan-in-join-policy.js";
import { integrationCandidatesSkippedScenario } from "./integration-candidates-skipped.js";
import { pathTraversalSymlinkScenario } from "./path-traversal-symlink.js";
import { retryIdempotencyCompleteFailScenario } from "./retry-idempotency-complete-fail.js";
import { redisOutageEquivalentSkippedScenario } from "./redis-outage-equivalent-skipped.js";
import type { Scenario } from "./types.js";

export type { Scenario, ScenarioContext, ScenarioResult, TimelineEntry, ScenarioStatus } from "./types.js";

/**
 * Every scenario, in a fixed, stable order (registration order is part
 * of the report's determinism contract — the runner iterates this array
 * in order, never `Object.keys`/`Map` iteration derived from anything
 * environment-dependent).
 */
export const ALL_SCENARIOS: Scenario[] = [
  claimRaceScenario,
  resourceClaimRaceScenario,
  duplicateClaimIdempotencyScenario,
  workerCrashRequeueScenario,
  staleFencingTokenRejectionScenario,
  snapshotStalenessGapScenario,
  cancellationCascadeGapScenario,
  fanInJoinPolicyScenario,
  integrationCandidatesSkippedScenario,
  pathTraversalSymlinkScenario,
  retryIdempotencyCompleteFailScenario,
  redisOutageEquivalentSkippedScenario,
];

export function findScenario(name: string): Scenario | undefined {
  return ALL_SCENARIOS.find((s) => s.name === name);
}

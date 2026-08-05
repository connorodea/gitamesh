import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 12: "Redis outage" equivalent.
 *
 * SKIPPED — nothing to inject, honestly. There is no Redis dependency
 * anywhere in this repository (checked: no `redis` / `ioredis` package
 * in any `package.json`, no signaling/pub-sub layer of any kind).
 * SQLite (via `packages/storage-sqlite`) is the sole source of truth and
 * the sole coordination substrate `packages/core`'s `CoordinationEngine`
 * talks to. "The system must remain correct when signaling/notification
 * is entirely absent" is therefore trivially, vacuously true today — you
 * cannot lose an outage-prone dependency that was never wired in. This
 * scenario deliberately does not construct a fake Redis client just to
 * then simulate it being down; that would test invented infrastructure,
 * not Gitamesh's.
 *
 * When a real pub/sub or cache layer is introduced in a later milestone,
 * this scenario should be replaced with one that actually severs that
 * dependency mid-run and asserts the engine's correctness invariants
 * (not just its uptime) survive the outage.
 */
export const redisOutageEquivalentSkippedScenario: Scenario = {
  name: "redis-outage-equivalent",
  title: "Redis-outage-equivalent (signaling layer absence)",
  description:
    "No Redis/signaling dependency exists anywhere in this codebase yet; there is nothing to take down, so this scenario intentionally runs nothing.",
  run(_ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    record({
      action: "no-op: no Redis/signaling dependency exists to outage-test",
      outcome: "info",
      detail:
        "SQLite (packages/storage-sqlite) is the sole source of truth; there is no pub/sub, cache, or notification layer in this repository to fail.",
    });

    return {
      name: "redis-outage-equivalent",
      title: "Redis-outage-equivalent (signaling layer absence)",
      status: "skipped",
      blockedOn:
        "no Redis (or any) signaling dependency exists in this codebase to simulate an outage of",
      reason:
        "Trivially/vacuously true today, not meaningfully testable: correctness cannot depend on a dependency that was never introduced. Revisit once a real signaling layer exists.",
      timeline: entries,
    };
  },
};

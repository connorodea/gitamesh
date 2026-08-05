import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 9: conflicting integration candidates.
 *
 * SKIPPED — blocked, not faked. `packages/protocol/src/entities.ts`
 * defines an `INTEGRATION_STATES` enum and `packages/core/src/state-machines.ts`
 * defines `INTEGRATION_TRANSITIONS` / `canTransitionIntegration` for it,
 * but there is no integration-candidate entity, no storage-adapter
 * methods for one (nothing in `packages/core/src/storage-adapter.ts`
 * references integration candidates), and no `CoordinationEngine`
 * operation that creates, claims, verifies, or resolves one. The
 * `IntegrationState` enum is defined but wholly unused outside its own
 * transition-graph test. There is no "conflicting integration
 * candidates" behavior anywhere in `packages/core` to exercise, so this
 * scenario runs no engine calls and asserts nothing — building a fake
 * integration-candidate lifecycle here would test invented behavior,
 * not Gitamesh's.
 */
export const integrationCandidatesSkippedScenario: Scenario = {
  name: "integration-candidates-skipped",
  title: "Conflicting integration candidates",
  description:
    "packages/core has no integration-candidate lifecycle (only an unused IntegrationState enum); this scenario is blocked and intentionally runs nothing.",
  run(_ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    record({
      action: "no-op: integration-candidate lifecycle does not exist",
      outcome: "info",
      detail:
        "IntegrationState/INTEGRATION_TRANSITIONS are defined in packages/core/src/state-machines.ts but nothing creates, stores, or transitions an integration candidate — there is no CoordinationEngine method and no StorageAdapter method for one.",
    });

    return {
      name: "integration-candidates-skipped",
      title: "Conflicting integration candidates",
      status: "skipped",
      blockedOn:
        "packages/core has no integration-candidate lifecycle (only an unused IntegrationState enum) — see docs/adr/0001 and the daemon milestone report referenced in this scenario's file header",
      reason:
        "Nothing to inject or assert: there is no integration-candidate entity, storage, or engine operation to drive conflicting candidates through.",
      timeline: entries,
    };
  },
};

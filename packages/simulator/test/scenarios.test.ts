import { describe, expect, it } from "vitest";
import { CoordinationEngine } from "@gitamesh/core";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import { mulberry32 } from "../src/prng.js";
import { ALL_SCENARIOS } from "../src/scenarios/index.js";
import type { ScenarioStatus } from "../src/scenarios/types.js";

const SEED = 42;

/** Every scenario must genuinely resolve to exactly the status the spec commits to for it — no scenario should ever silently "fail" in a way the report can't explain. */
const EXPECTED_STATUS: Record<string, ScenarioStatus> = {
  "claim-race": "pass",
  "resource-claim-race": "pass",
  "duplicate-claim-idempotency": "pass",
  "worker-crash-requeue": "pass",
  "stale-fencing-token-rejection": "pass",
  "snapshot-staleness-gap": "skipped",
  "cancellation-cascade": "pass",
  "fan-in-join-policy": "pass",
  "integration-candidates-skipped": "skipped",
  "path-traversal-symlink": "pass",
  "retry-idempotency-complete-fail": "pass",
  "redis-outage-equivalent": "skipped",
};

function runOne(name: string, seed: number) {
  const scenario = ALL_SCENARIOS.find((s) => s.name === name);
  if (!scenario) throw new Error(`no such scenario: ${name}`);
  const storage = createInMemorySqliteStorage();
  const engine = new CoordinationEngine(storage);
  const rng = mulberry32(seed);
  try {
    return scenario.run({ rng, engine, storage, agentCount: 20, taskCount: 40 });
  } finally {
    storage.close();
  }
}

describe("every registered scenario resolves to its committed status at a fixed seed", () => {
  it("the registry covers exactly the expected scenario set", () => {
    expect(ALL_SCENARIOS.map((s) => s.name).sort()).toEqual(
      Object.keys(EXPECTED_STATUS).sort(),
    );
  });

  for (const scenario of ALL_SCENARIOS) {
    it(`${scenario.name} -> ${EXPECTED_STATUS[scenario.name]}`, () => {
      const result = runOne(scenario.name, SEED);
      expect(result.status).toBe(EXPECTED_STATUS[scenario.name]);
      expect(result.reason.length).toBeGreaterThan(0);
      if (result.status === "skipped") {
        expect(result.blockedOn).toBeTruthy();
      }
    });
  }
});

describe("scenario determinism: same seed -> identical outcome and timeline shape", () => {
  for (const scenario of ALL_SCENARIOS) {
    it(`${scenario.name} produces the same status and timeline length across two runs with the same seed`, () => {
      const first = runOne(scenario.name, SEED);
      const second = runOne(scenario.name, SEED);
      expect(second.status).toBe(first.status);
      expect(second.reason).toBe(first.reason);
      expect(second.timeline.map((t) => ({ ...t }))).toEqual(
        first.timeline.map((t) => ({ ...t })),
      );
    });
  }

  it("a different seed CAN change PRNG-dependent scenario details (sanity: PRNG is actually wired in)", () => {
    // worker-crash-requeue's timeline length depends on a PRNG-chosen
    // healthy-heartbeat count and PRNG-chosen rescue agent — across many
    // seeds, at least one pair must differ, or the PRNG isn't actually
    // driving anything.
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shapes = seeds.map((seed) => {
      const r = runOne("worker-crash-requeue", seed);
      return r.timeline.length;
    });
    const distinctShapes = new Set(shapes);
    expect(distinctShapes.size).toBeGreaterThan(1);
  });
});

describe("claim-race scales its rejection count with the configured agent fleet", () => {
  it("with a larger fleet, exactly 1 winner and (agents - 1) rejections", () => {
    const scenario = ALL_SCENARIOS.find((s) => s.name === "claim-race")!;
    const storage = createInMemorySqliteStorage();
    const engine = new CoordinationEngine(storage);
    const rng = mulberry32(SEED);
    const result = scenario.run({ rng, engine, storage, agentCount: 35, taskCount: 40 });
    storage.close();
    expect(result.status).toBe("pass");
    const errorEntries = result.timeline.filter((t) => t.outcome === "error");
    const okEntries = result.timeline.filter((t) => t.outcome === "ok");
    expect(okEntries).toHaveLength(1);
    expect(errorEntries).toHaveLength(34);
  });
});

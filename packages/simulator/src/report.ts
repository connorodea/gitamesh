import type { ScenarioResult } from "./scenarios/types.js";

export interface SimulationReport {
  seed: number;
  agentCount: number;
  taskCount: number;
  /** The exact scenario names run, in the exact order run — part of the determinism contract. */
  scenariosRun: string[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  scenarios: Array<{
    name: string;
    title: string;
    status: ScenarioResult["status"];
    reason: string;
    blockedOn?: string;
    /** Only populated for failed scenarios — the exact operation sequence leading to the failure. */
    failureTimeline?: ScenarioResult["timeline"];
    reproductionCommand: string;
  }>;
}

export function buildReport(params: {
  seed: number;
  agentCount: number;
  taskCount: number;
  results: ScenarioResult[];
}): SimulationReport {
  const { seed, agentCount, taskCount, results } = params;

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  return {
    seed,
    agentCount,
    taskCount,
    scenariosRun: results.map((r) => r.name),
    summary: {
      total: results.length,
      passed,
      failed,
      skipped,
    },
    scenarios: results.map((r) => ({
      name: r.name,
      title: r.title,
      status: r.status,
      reason: r.reason,
      ...(r.blockedOn ? { blockedOn: r.blockedOn } : {}),
      ...(r.status === "fail" ? { failureTimeline: r.timeline } : {}),
      reproductionCommand: `gitamesh simulate --seed ${seed} --scenario ${r.name}`,
    })),
  };
}

/**
 * Deterministic JSON serialization: stable 2-space indentation, and
 * (defensively, in case any future field is ever built via object-spread
 * from unordered sources) a fixed key order defined by `buildReport`'s
 * own construction — plain `JSON.stringify` already preserves insertion
 * order for string-keyed objects, which is what makes two runs with the
 * same seed byte-identical, since nothing here is ever built from a Map
 * or Set whose iteration order could vary.
 */
export function serializeReport(report: SimulationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

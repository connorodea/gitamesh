import { CoordinationEngine } from "@gitamesh/core";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import { mulberry32 } from "./prng.js";
import { ALL_SCENARIOS, findScenario } from "./scenarios/index.js";
import type { ScenarioResult } from "./scenarios/types.js";
import { buildReport, serializeReport } from "./report.js";
import type { SimulationReport } from "./report.js";

export interface RunSimulationOptions {
  seed: number;
  /** If set, run only this one scenario (by name) instead of the full registry. */
  scenario?: string;
  agentCount?: number;
  taskCount?: number;
}

export interface RunSimulationOutput {
  report: SimulationReport;
  serialized: string;
  exitCode: number;
}

/**
 * FNV-1a-style string hash, folded with `baseSeed`, to derive a
 * per-scenario PRNG seed that depends ONLY on `(baseSeed, scenarioName)`
 * — never on scenario order or which other scenarios are running. This
 * is what makes `gitamesh simulate --seed 42 --scenario claim-race`
 * reproduce the exact same run as scenario `claim-race` got inside a
 * full `gitamesh simulate --seed 42` batch.
 */
function scenarioSeed(baseSeed: number, scenarioName: string): number {
  let hash = 0x811c9dc5 ^ (baseSeed >>> 0);
  for (let i = 0; i < scenarioName.length; i += 1) {
    hash ^= scenarioName.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function runSimulation(options: RunSimulationOptions): RunSimulationOutput {
  const agentCount = options.agentCount ?? 20;
  const taskCount = options.taskCount ?? 40;

  const scenarios = options.scenario
    ? (() => {
        const found = findScenario(options.scenario!);
        if (!found) {
          throw new Error(
            `Unknown scenario "${options.scenario}". Known scenarios: ${ALL_SCENARIOS.map((s) => s.name).join(", ")}`,
          );
        }
        return [found];
      })()
    : ALL_SCENARIOS;

  const results: ScenarioResult[] = scenarios.map((scenario) => {
    const storage = createInMemorySqliteStorage();
    const engine = new CoordinationEngine(storage);
    const rng = mulberry32(scenarioSeed(options.seed, scenario.name));
    try {
      return scenario.run({ rng, engine, storage, agentCount, taskCount });
    } finally {
      storage.close();
    }
  });

  const report = buildReport({
    seed: options.seed,
    agentCount,
    taskCount,
    results,
  });

  const exitCode = report.summary.failed > 0 ? 1 : 0;

  return { report, serialized: serializeReport(report), exitCode };
}

export function printConsoleSummary(
  report: SimulationReport,
  log: (line: string) => void = (line) => console.log(line),
): void {
  log(`Gitamesh simulator — seed ${report.seed} (agents=${report.agentCount}, tasks=${report.taskCount})`);
  log("");
  for (const s of report.scenarios) {
    const marker = s.status === "pass" ? "PASS" : s.status === "fail" ? "FAIL" : "SKIP";
    log(`  [${marker}] ${s.name} — ${s.title}`);
    log(`         ${s.reason}`);
    if (s.status === "fail") {
      log(`         reproduce: ${s.reproductionCommand}`);
    }
  }
  log("");
  log(
    `Summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped (of ${report.summary.total})`,
  );
}

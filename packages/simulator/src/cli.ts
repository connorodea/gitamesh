import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSimulation, printConsoleSummary } from "./runner.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";

export interface ParsedArgs {
  seed: number;
  scenario?: string;
  agentCount?: number;
  taskCount?: number;
  outPath: string;
  help: boolean;
}

const DEFAULT_OUT = "simulation-report.json";
const DEFAULT_SEED = 1;

export function parseArgs(argv: string[]): ParsedArgs {
  let seed = DEFAULT_SEED;
  let scenario: string | undefined;
  let agentCount: number | undefined;
  let taskCount: number | undefined;
  let outPath = DEFAULT_OUT;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--seed":
        seed = Number(argv[++i]);
        break;
      case "--scenario":
        scenario = argv[++i];
        break;
      case "--agents":
        agentCount = Number(argv[++i]);
        break;
      case "--tasks":
        taskCount = Number(argv[++i]);
        break;
      case "--out":
        outPath = argv[++i]!;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: "${arg}". Run with --help for usage.`);
    }
  }

  if (!Number.isFinite(seed)) {
    throw new Error("--seed must be a finite number");
  }

  return { seed, scenario, agentCount, taskCount, outPath, help };
}

function printHelp(log: (line: string) => void): void {
  log("gitamesh simulate — deterministic adversarial coordination-engine harness");
  log("");
  log("Usage:");
  log("  gitamesh simulate [--seed <n>] [--scenario <name>] [--agents <n>] [--tasks <n>] [--out <path>]");
  log("");
  log("Options:");
  log(`  --seed <n>       PRNG seed (default: ${DEFAULT_SEED}). Same seed => same event sequence => same outcome.`);
  log("  --scenario <name> Run only this one scenario instead of the full registry.");
  log("  --agents <n>      Synthetic agent fleet size (default: 20).");
  log("  --tasks <n>       Synthetic task pool size hint (default: 40; individual scenarios size their own fixtures).");
  log(`  --out <path>      Where to write the JSON report (default: ./${DEFAULT_OUT}).`);
  log("");
  log("Scenarios:");
  for (const s of ALL_SCENARIOS) {
    log(`  ${s.name.padEnd(32)} ${s.description}`);
  }
}

/**
 * Runs the simulator end to end: parses argv, runs the requested
 * scenario(s), prints the console summary, writes the JSON report, and
 * returns the process exit code (does not call `process.exit` itself,
 * so it stays testable).
 */
export function runSimulatorCli(
  argv: string[],
  io: { log: (line: string) => void; error: (line: string) => void } = {
    log: (l) => console.log(l),
    error: (l) => console.error(l),
  },
): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (args.help) {
    printHelp(io.log);
    return 0;
  }

  try {
    const { report, serialized, exitCode } = runSimulation({
      seed: args.seed,
      scenario: args.scenario,
      agentCount: args.agentCount,
      taskCount: args.taskCount,
    });

    printConsoleSummary(report, io.log);

    const outPath = resolve(process.cwd(), args.outPath);
    writeFileSync(outPath, serialized, "utf8");
    io.log("");
    io.log(`Report written to ${outPath}`);

    return exitCode;
  } catch (error) {
    io.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

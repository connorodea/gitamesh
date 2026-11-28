import { Command } from "commander";

import type { CliDeps } from "../context.js";
import { CliError } from "../output.js";

const COMMANDS = ["doctor", "status", "plan", "next", "audit", "run", "verify", "reconcile"] as const;

export function registerEngineeringCommands(program: Command, _deps: CliDeps): void {
  const engineering = program.command("engineering").description("Delegate engineering commands to a repository adapter");
  for (const name of COMMANDS) {
    const command = engineering.command(name === "verify" ? "verify <task>" : name)
      .description(`Run the repository adapter's ${name} command`)
      .requiredOption("--repo <owner/name>", "repository owner/name")
      .option("--json", "print the adapter JSON envelope")
      .option("--trusted-main <path>", "trusted repository checkout (GITAMESH_ENGINEERING_TRUSTED_MAIN)")
      .option("--repository-id <id>", "coordinator repository id (GITAMESH_REPOSITORY_ID)")
      .option("--python <executable>", "Python interpreter (GITAMESH_ENGINEERING_PYTHON)")
      .option("--task-register <path>", "task register manifest")
      .option("--harness <path>", "harness manifest");
    if (name === "run") {
      command.option("--max-workers <count>", "worker limit")
        .option("--once", "request one tick")
        .option("--continuous", "request bounded continuous mode")
        .option("--max-ticks <count>", "tick limit")
        .option("--deadline <timestamp>", "absolute deadline")
        .option("--max-duration-seconds <seconds>", "duration limit");
    }
    if (name === "run" || name === "verify") command.option("--execute", "request live execution");
    if (name === "reconcile") command.option("--apply", "request reconciliation writes");
    if (name === "run" || name === "verify" || name === "reconcile") command.option("--dry-run", "request preview only");
    command.action(() => { throw new CliError("ADAPTER_MISSING: repository adapter is not configured", 2); });
  }
}

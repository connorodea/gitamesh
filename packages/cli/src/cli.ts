import { Command } from "commander";

import { registerAgentCommands } from "./commands/agent.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerInitCommand } from "./commands/init.js";
import { registerLockCommands } from "./commands/lock.js";
import { registerMsgCommands } from "./commands/msg.js";
import { registerRepoCommands } from "./commands/repo.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerTaskCommands } from "./commands/task.js";
import type { CliDeps } from "./context.js";
import { CliError } from "./output.js";
import { GitameshClientError } from "./client.js";

export type { CliDeps } from "./context.js";

export function buildProgram(deps: CliDeps): Command {
  const program = new Command();
  program
    .name("gitamesh")
    .description("CLI for the Gitamesh coordination mesh: agents, tasks, messages, locks, repo status.")
    .version("0.1.0");

  registerInitCommand(program, deps);
  registerDoctorCommand(program, deps);
  registerRepoCommands(program, deps);
  registerAgentCommands(program, deps);
  registerTaskCommands(program, deps);
  registerLockCommands(program, deps);
  registerMsgCommands(program, deps);
  registerStatusCommand(program, deps);

  return program;
}

/**
 * Parses and runs `argv` (in Node's full `process.argv` shape — i.e.
 * `[execPath, scriptPath, ...args]`) against a fresh program built from
 * `deps`, and returns the process exit code, WITHOUT calling
 * `process.exit` itself — so it is safe to call from tests.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const program = buildProgram(deps);
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => deps.sink.log(str.replace(/\n$/, "")),
    writeErr: (str) => deps.sink.error(str.replace(/\n$/, "")),
  });

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      deps.sink.error(`Error: ${error.message}`);
      return error.exitCode;
    }
    if (error instanceof GitameshClientError) {
      // Line 1 is the whole failure in one sentence (status + title +
      // detail); the problem's machine-readable fields follow it.
      deps.sink.error(`Error: ${error.message}`);
      for (const line of problemDetailLines(error)) deps.sink.error(line);
      return 1;
    }
    if (isCommanderError(error)) {
      // e.g. --help / --version / usage errors: commander already printed
      // the relevant message via configureOutput above.
      return error.exitCode;
    }
    deps.sink.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Indented `key: value` lines for a failed request's problem type and extensions. */
function problemDetailLines(error: GitameshClientError): string[] {
  const problem = error.problem;
  if (!problem) return [];
  const lines: string[] = [];
  if (typeof problem.type === "string") lines.push(`  type: ${problem.type}`);
  const extensions = problem.extensions;
  if (extensions && typeof extensions === "object") {
    for (const [key, value] of Object.entries(extensions as Record<string, unknown>)) {
      // `issues` is the raw zod list line 1 already summarizes.
      if (key === "issues" || value === undefined || value === null) continue;
      lines.push(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }
  return lines;
}

function isCommanderError(error: unknown): error is { exitCode: number; code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    "code" in error &&
    typeof (error as { exitCode: unknown }).exitCode === "number"
  );
}

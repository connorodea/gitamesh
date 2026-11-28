import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Command } from "commander";

import { resolveSettings } from "../config.js";
import type { CliDeps } from "../context.js";

const COMMANDS = ["doctor", "status", "plan", "next", "audit", "run", "verify", "reconcile"] as const;
const PROTOCOL = "gitamesh-engineering/1";

/** An adapter exit is already rendered; runCli must not add another error. */
export class EngineeringExit extends Error {
  constructor(readonly exitCode: number) { super("engineering command finished"); }
}

interface EngineeringOptions {
  repo: string;
  json?: boolean;
  trustedMain?: string;
  repositoryId?: string;
  python?: string;
}

function invoke(python: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string; started: boolean }>((resolve) => {
    execFile(python, argv, { cwd, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 2) : 0,
        stdout, stderr, started: !error || typeof error.code === "number" });
    });
  });
}

async function delegate(name: string, raw: string[], options: EngineeringOptions, deps: CliDeps): Promise<void> {
  const fail = (code: string, message: string): never => {
    if (options.json) {
      deps.sink.log(JSON.stringify({ protocol: PROTOCOL, command: name, ok: false, repo: options.repo,
        mutations: 0, result: null, blockers: [], error: { code, message } }));
    } else {
      deps.sink.error(`${code}: ${message}`);
    }
    throw new EngineeringExit(2);
  };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(options.repo)) {
    fail("UNKNOWN_REPO", "--repo must name an owner/repository");
  }
  const trustedMain = options.trustedMain ?? deps.env.GITAMESH_ENGINEERING_TRUSTED_MAIN;
  const repositoryId = options.repositoryId ?? deps.env.GITAMESH_REPOSITORY_ID;
  const python = options.python ?? deps.env.GITAMESH_ENGINEERING_PYTHON;
  if (!trustedMain?.trim()) fail("TRUSTED_MAIN_MISSING", "set --trusted-main or GITAMESH_ENGINEERING_TRUSTED_MAIN");
  if (!repositoryId?.trim()) fail("REPOSITORY_ID_MISSING", "set --repository-id or GITAMESH_REPOSITORY_ID");
  if (!python?.trim()) fail("PYTHON_MISSING", "set --python or GITAMESH_ENGINEERING_PYTHON");
  const adapter = path.resolve(deps.cwd, trustedMain!, "scripts/engineering_adapter.py");
  if (!(await fs.stat(adapter).catch(() => null))?.isFile()) fail("ADAPTER_MISSING", "scripts/engineering_adapter.py is unavailable in the trusted checkout");

  // The protocol probe gets no coordinator token. Never use a shell or include credentials in argv.
  const probeEnv = { ...deps.env };
  delete probeEnv.GITAMESH_TOKEN;
  const probe = await invoke(python!, ["-I", "-B", adapter, "--protocol"], deps.cwd, probeEnv);
  if (!probe.started) fail("ADAPTER_MISSING", "the configured Python interpreter could not start the adapter");
  let identity: { protocol?: unknown } | null = null;
  try { identity = JSON.parse(probe.stdout); } catch { /* Refuse malformed protocol output below. */ }
  if (probe.code !== 0 || identity?.protocol !== PROTOCOL) fail("ADAPTER_INCOMPATIBLE", `adapter must report protocol ${PROTOCOL} and exit 0`);

  const argv = ["-I", "-B", adapter, name];
  for (let i = 0; i < raw.length; i++) {
    // --python configures this launcher, not the Python adapter.
    if (raw[i] === "--python") { i++; continue; }
    if (raw[i]!.startsWith("--python=")) continue;
    argv.push(raw[i]!);
  }
  if (options.trustedMain === undefined) argv.push("--trusted-main", trustedMain!);
  if (options.repositoryId === undefined) argv.push("--repository-id", repositoryId!);
  const settings = await resolveSettings(deps.cwd, deps.env);
  argv.push("--coordinator-url", settings.daemonUrl);
  const childEnv = { ...deps.env };
  if (settings.token) childEnv.GITAMESH_TOKEN = settings.token;
  else delete childEnv.GITAMESH_TOKEN;
  const child = await invoke(python!, argv, deps.cwd, childEnv);
  if (!child.started) fail("ADAPTER_FAILED", "adapter process could not finish");
  let envelope: Record<string, unknown>;
  try { envelope = JSON.parse(child.stdout); }
  catch { fail("ADAPTER_INVALID_OUTPUT", "adapter did not return one JSON envelope"); }
  if (!envelope! || envelope!.protocol !== PROTOCOL || typeof envelope!.ok !== "boolean") {
    fail("ADAPTER_INVALID_OUTPUT", "adapter returned an invalid JSON envelope");
  }
  if (child.stderr) deps.sink.error(child.stderr.replace(/\n$/, ""));
  if (options.json) {
    deps.sink.log(child.stdout.replace(/\n$/, ""));
  } else {
    deps.sink.log(`ok: ${envelope!.ok}`);
    if (Array.isArray(envelope!.blockers)) {
      for (const blocker of envelope!.blockers) deps.sink.log(`blocker: ${typeof blocker === "string" ? blocker : JSON.stringify(blocker)}`);
    }
    if (envelope!.error) deps.sink.log(`error: ${JSON.stringify(envelope!.error)}`);
    if (envelope!.result !== undefined && envelope!.result !== null) {
      deps.sink.log(JSON.stringify(envelope!.result, null, 2).split("\n").slice(0, 6).join("\n"));
    }
  }
  if (child.code !== 0) throw new EngineeringExit(child.code);
}

export function registerEngineeringCommands(program: Command, deps: CliDeps): void {
  const engineering = program.command("engineering").description("Delegate engineering commands to a repository adapter")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => deps.sink.log(str.replace(/\n$/, "")),
      writeErr: (str) => deps.sink.error(str.replace(/\n$/, "")),
    });
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
    command.action(async () => { await delegate(name, program.args.slice(2), command.opts<EngineeringOptions>(), deps); });
  }
}

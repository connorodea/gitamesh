import { getRepositoryIdentity } from "@gitamesh/git-adapter";
import { Command } from "commander";

import { maskToken, resolveSettings } from "../config.js";
import { GitameshClient, GitameshClientError } from "../client.js";
import type { CliDeps } from "../context.js";
import { CliError, printCheck, printJson } from "../output.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

/**
 * Runs every doctor check and returns a structured report. Exported
 * separately from the command wiring so `gitamesh status` can reuse it
 * without shelling back out to itself.
 */
export async function runDoctorChecks(deps: CliDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 1. Is this a git repository, and can git-adapter resolve its identity?
  let gitCommonDir: string | undefined;
  try {
    const identity = await getRepositoryIdentity(deps.cwd);
    gitCommonDir = identity.gitCommonDir;
    checks.push({
      name: "git repository",
      ok: true,
      detail: `git_common_dir=${identity.gitCommonDir}, default_branch=${identity.defaultBranch}`,
    });
  } catch (error) {
    checks.push({
      name: "git repository",
      ok: false,
      detail: `not a git repository (or git-adapter could not resolve identity): ${(error as Error).message}`,
    });
  }
  void gitCommonDir;

  // 2. Daemon URL configured + reachable.
  const settings = await resolveSettings(deps.cwd, deps.env);
  checks.push({ name: "daemon URL configured", ok: true, detail: settings.daemonUrl });

  let daemonReachable = false;
  const client = new GitameshClient({
    baseUrl: settings.daemonUrl,
    token: settings.token,
    fetchImpl: deps.fetchImpl,
  });
  try {
    await client.healthz();
    daemonReachable = true;
    checks.push({ name: "daemon reachable", ok: true, detail: `GET ${settings.daemonUrl}/healthz` });
  } catch (error) {
    const detail =
      error instanceof GitameshClientError ? error.message : (error as Error).message;
    checks.push({ name: "daemon reachable", ok: false, detail });
  }

  // 3. Token configured / valid.
  if (!settings.token) {
    checks.push({
      name: "token configured",
      ok: false,
      detail: `no token found (checked $GITAMESH_TOKEN and config file); run "gitamesh init" then export GITAMESH_TOKEN`,
    });
  } else {
    checks.push({
      name: "token configured",
      ok: true,
      detail: `source=${settings.tokenSource}, token=${maskToken(settings.token)}`,
    });

    if (daemonReachable) {
      try {
        await client.listAgents();
        checks.push({ name: "token valid", ok: true });
      } catch (error) {
        const detail =
          error instanceof GitameshClientError ? error.message : (error as Error).message;
        checks.push({ name: "token valid", ok: false, detail });
      }
    } else {
      checks.push({
        name: "token valid",
        ok: false,
        detail: "skipped — daemon is unreachable",
      });
    }
  }

  return { checks, ok: checks.every((c) => c.ok) };
}

export function registerDoctorCommand(program: Command, deps: CliDeps): void {
  program
    .command("doctor")
    .description("Check git-adapter resolution, daemon reachability, and token validity")
    .option("--json", "machine-readable output", false)
    .action(async (options: { json: boolean }) => {
      const report = await runDoctorChecks(deps);
      if (options.json) {
        printJson(deps.sink, report);
      } else {
        for (const check of report.checks) {
          printCheck(deps.sink, check.name, check.ok, check.detail);
        }
      }
      if (!report.ok) {
        throw new CliError("one or more doctor checks failed", 1);
      }
    });
}

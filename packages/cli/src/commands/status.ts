import { getOrCreateRepositoryId, getRepositoryIdentity } from "@gitamesh/git-adapter";
import { Command } from "commander";

import { createClient } from "../context.js";
import type { CliDeps } from "../context.js";
import { printCheck, printJson, printTable } from "../output.js";
import { runDoctorChecks } from "./doctor.js";

export function registerStatusCommand(program: Command, deps: CliDeps): void {
  program
    .command("status")
    .description("Combined dashboard: doctor checks plus this repository's open tasks/claims")
    .option("--json", "machine-readable output", false)
    .action(async (options: { json: boolean }) => {
      const doctorReport = await runDoctorChecks(deps);

      let repositoryId: string | undefined;
      try {
        const identity = await getRepositoryIdentity(deps.cwd);
        repositoryId = await getOrCreateRepositoryId(identity.gitCommonDir);
      } catch {
        repositoryId = undefined;
      }

      let tasks: unknown[] = [];
      let claims: unknown[] = [];
      const daemonReachable = doctorReport.checks.find((c) => c.name === "daemon reachable")?.ok;

      if (daemonReachable && repositoryId) {
        const { client } = await createClient(deps);
        try {
          const taskResult = (await client.listTasks({ repository_id: repositoryId })) as {
            tasks?: unknown[];
          };
          tasks = taskResult.tasks ?? [];
        } catch {
          tasks = [];
        }
        try {
          const claimResult = (await client.listClaims({ repository_id: repositoryId })) as {
            claims?: unknown[];
          };
          claims = claimResult.claims ?? [];
        } catch {
          claims = [];
        }
      }

      if (options.json) {
        printJson(deps.sink, { doctor: doctorReport, repository_id: repositoryId, tasks, claims });
        return;
      }

      deps.sink.log("== doctor ==");
      for (const check of doctorReport.checks) {
        printCheck(deps.sink, check.name, check.ok, check.detail);
      }
      deps.sink.log("");
      deps.sink.log(`== tasks (repository_id=${repositoryId ?? "unknown"}) ==`);
      printTable(
        deps.sink,
        ["task_id", "title", "status"],
        tasks as Array<Record<string, unknown>>,
      );
      deps.sink.log("");
      deps.sink.log("== claims ==");
      printTable(
        deps.sink,
        ["resource_claim_id", "resource_key", "mode"],
        claims as Array<Record<string, unknown>>,
      );
    });
}

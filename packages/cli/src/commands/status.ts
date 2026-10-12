import { getOrCreateRepositoryId, getRepositoryIdentity } from "@gitamesh/git-adapter";
import { Command } from "commander";

import { createClient } from "../context.js";
import type { CliDeps } from "../context.js";
import { printCheck, printJson, printTable } from "../output.js";
import { runDoctorChecks } from "./doctor.js";
import { pathLockRows, type PathLockRecord } from "./lock.js";
import { taskRows, type TaskRecord } from "./task.js";

export function registerStatusCommand(program: Command, deps: CliDeps): void {
  program
    .command("status")
    .description(
      "Combined dashboard: doctor checks plus this repository's tasks, who holds them, and locks",
    )
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

      let tasks: TaskRecord[] = [];
      let claims: unknown[] = [];
      let locks: PathLockRecord[] = [];
      const daemonReachable = doctorReport.checks.find((c) => c.name === "daemon reachable")?.ok;

      if (daemonReachable && repositoryId) {
        const { client } = await createClient(deps);
        try {
          const taskResult = (await client.listTasks({ repositoryId })) as {
            tasks?: TaskRecord[];
          };
          tasks = taskResult.tasks ?? [];
        } catch {
          tasks = [];
        }
        try {
          const claimResult = (await client.listClaims({ repositoryId })) as {
            claims?: unknown[];
          };
          claims = claimResult.claims ?? [];
        } catch {
          claims = [];
        }
        try {
          const lockResult = (await client.listLocks({ repositoryId })) as {
            locks?: PathLockRecord[];
          };
          locks = lockResult.locks ?? [];
        } catch {
          locks = [];
        }
      }

      // A "claim" on a task is its live attempt: who holds it and when
      // that agent last heartbeated.
      const taskClaims = tasks
        .filter((task) => task.owner)
        .map((task) => ({
          task_id: task.task_id,
          title: task.title,
          owner: task.owner!.display_name,
          agent_id: task.owner!.agent_id,
          heartbeat: task.owner!.heartbeat_at,
          expires_at: task.owner!.expires_at,
        }));

      if (options.json) {
        printJson(deps.sink, {
          doctor: doctorReport,
          repository_id: repositoryId,
          tasks,
          task_claims: taskClaims,
          locks,
          claims,
        });
        return;
      }

      deps.sink.log("== doctor ==");
      for (const check of doctorReport.checks) {
        printCheck(deps.sink, check.name, check.ok, check.detail);
      }
      deps.sink.log("");
      deps.sink.log(`== tasks (repository_id=${repositoryId ?? "unknown"}) ==`);
      printTable(deps.sink, ["task_id", "title", "status", "ready", "owner", "heartbeat"], taskRows(tasks));
      deps.sink.log("");
      deps.sink.log("== claims ==");
      printTable(
        deps.sink,
        ["task_id", "title", "owner", "agent_id", "heartbeat", "expires_at"],
        taskClaims,
      );
      deps.sink.log("");
      deps.sink.log("== path locks ==");
      printTable(deps.sink, ["lock_id", "holder", "paths", "task_id", "expires_at"], pathLockRows(locks));
      deps.sink.log("");
      deps.sink.log("== resource claims ==");
      printTable(
        deps.sink,
        ["resource_claim_id", "resource_key", "mode"],
        claims as Array<Record<string, unknown>>,
      );
    });
}

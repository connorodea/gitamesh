import { Command } from "commander";

import { createClient } from "../context.js";
import type { CliDeps } from "../context.js";
import { CliError, printJson, printTable } from "../output.js";

interface TaskRecord {
  task_id: string;
  title: string;
  status: string;
  priority: number;
  repository_id: string;
  branch: string | null;
}

export function registerTaskCommands(program: Command, deps: CliDeps): void {
  const task = program.command("task").description("Task lifecycle: create, list, claim, complete, fail, cancel");

  task
    .command("create")
    .description("Create a new task")
    .requiredOption("--workflow-id <id>", "workflow id this task belongs to")
    .requiredOption("--repository-id <id>", "repository id")
    .requiredOption("--title <title>", "task title")
    .option("--description <description>", "task description", "")
    .option("--priority <n>", "priority (higher runs first)", "0")
    .option("--branch <branch>", "target branch, if any")
    .option("--base-sha <sha>", "base commit SHA this task was scheduled against")
    .option(
      "--required-capability <cap>",
      "a required agent capability (repeatable)",
      collect,
      [] as string[],
    )
    .option("--idempotency-key <key>", "idempotency key for safe retries")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        workflowId: string;
        repositoryId: string;
        title: string;
        description: string;
        priority: string;
        branch?: string;
        baseSha?: string;
        requiredCapability: string[];
        idempotencyKey?: string;
        json: boolean;
      }) => {
        const { client } = await createClient(deps);
        const result = await client.createTask({
          workflow_id: options.workflowId,
          repository_id: options.repositoryId,
          title: options.title,
          description: options.description,
          priority: Number(options.priority),
          branch: options.branch ?? null,
          base_sha: options.baseSha ?? null,
          required_capabilities: options.requiredCapability,
          idempotency_key: options.idempotencyKey ?? null,
        });
        if (options.json) {
          printJson(deps.sink, result);
        } else {
          deps.sink.log("Task created.");
        }
      },
    );

  task
    .command("list")
    .description("List tasks")
    .option("--repository-id <id>", "filter by repository id")
    .option("--status <status>", "filter by task status")
    .option("--json", "machine-readable output", false)
    .action(async (options: { repositoryId?: string; status?: string; json: boolean }) => {
      const { client } = await createClient(deps);
      const result = (await client.listTasks({
        repositoryId: options.repositoryId,
        status: options.status,
      })) as { tasks?: TaskRecord[] };
      const tasks = result.tasks ?? [];
      if (options.json) {
        printJson(deps.sink, tasks);
      } else {
        printTable(deps.sink, ["task_id", "title", "status", "priority", "branch"], tasks);
      }
    });

  task
    .command("show <taskId>")
    .description("Show a single task")
    .option("--json", "machine-readable output", false)
    .action(async (taskId: string, options: { json: boolean }) => {
      const { client } = await createClient(deps);
      const result = await client.getTask(taskId);
      if (options.json) {
        printJson(deps.sink, result);
      } else {
        printJson(deps.sink, result);
      }
    });

  task
    .command("claim <taskId>")
    .description("Claim a task for an agent/workspace session")
    .requiredOption("--agent-id <id>", "claiming agent id")
    .requiredOption("--workspace-session-id <id>", "workspace session id")
    .option(
      "--resource <type:mode:key>",
      "a resource to lock with the claim, e.g. path:write:src/app.ts (repeatable)",
      collect,
      [] as string[],
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (
        taskId: string,
        options: { agentId: string; workspaceSessionId: string; resource: string[]; json: boolean },
      ) => {
        const requiredResources = options.resource.map(parseResource);
        const { client } = await createClient(deps);
        const result = (await client.claimTask(taskId, {
          agentId: options.agentId,
          workspaceSessionId: options.workspaceSessionId,
          requiredResources,
        })) as { attempt?: { attempt_id?: string }; fencingToken?: number };
        if (options.json) {
          printJson(deps.sink, result);
        } else {
          // The attempt id + fencing token are required by heartbeat/complete/fail.
          deps.sink.log(
            `Task ${taskId} claimed. attempt_id=${result.attempt?.attempt_id ?? "unknown"} fencing_token=${result.fencingToken ?? "unknown"}`,
          );
        }
      },
    );

  task
    .command("heartbeat <taskId>")
    .description("Heartbeat the active attempt on a task")
    .requiredOption("--attempt-id <id>", "attempt id")
    .requiredOption("--fencing-token <n>", "fencing token returned by `task claim`")
    .option("--json", "machine-readable output", false)
    .action(
      async (taskId: string, options: { attemptId: string; fencingToken: string; json: boolean }) => {
        const fencingToken = parseFencingToken(options.fencingToken);
        const { client } = await createClient(deps);
        const result = await client.heartbeatTask(taskId, {
          attemptId: options.attemptId,
          fencingToken,
        });
        if (options.json) {
          printJson(deps.sink, result);
        } else {
          deps.sink.log(`Heartbeat sent for task ${taskId}.`);
        }
      },
    );

  task
    .command("complete <taskId>")
    .description("Mark a task's active attempt complete")
    .requiredOption("--attempt-id <id>", "attempt id")
    .requiredOption("--fencing-token <n>", "fencing token returned by `task claim`")
    .option("--json", "machine-readable output", false)
    .action(
      async (taskId: string, options: { attemptId: string; fencingToken: string; json: boolean }) => {
        const fencingToken = parseFencingToken(options.fencingToken);
        const { client } = await createClient(deps);
        const result = await client.completeTask(taskId, {
          attemptId: options.attemptId,
          fencingToken,
        });
        if (options.json) {
          printJson(deps.sink, result);
        } else {
          deps.sink.log(`Task ${taskId} marked complete.`);
        }
      },
    );

  task
    .command("fail <taskId>")
    .description("Mark a task's active attempt failed")
    .requiredOption("--attempt-id <id>", "attempt id")
    .requiredOption("--fencing-token <n>", "fencing token returned by `task claim`")
    .requiredOption("--error <message>", "error message")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        taskId: string,
        options: { attemptId: string; fencingToken: string; error: string; json: boolean },
      ) => {
        const fencingToken = parseFencingToken(options.fencingToken);
        const { client } = await createClient(deps);
        const result = await client.failTask(taskId, {
          attemptId: options.attemptId,
          fencingToken,
          error: options.error,
        });
        if (options.json) {
          printJson(deps.sink, result);
        } else {
          deps.sink.log(`Task ${taskId} marked failed.`);
        }
      },
    );

  task
    .command("cancel <taskId>")
    .description("Cancel a task")
    .option("--reason <reason>", "cancellation reason", "")
    .option("--json", "machine-readable output", false)
    .action(async (taskId: string, options: { reason: string; json: boolean }) => {
      const { client } = await createClient(deps);
      const result = await client.cancelTask(taskId, { reason: options.reason });
      if (options.json) {
        printJson(deps.sink, result);
      } else {
        deps.sink.log(`Task ${taskId} cancelled.`);
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseFencingToken(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new CliError(`--fencing-token must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

/** Parses `<type>:<mode>:<key>`; the key itself may contain colons. */
function parseResource(raw: string): { resourceType: string; mode: string; resourceKey: string } {
  const [resourceType, mode, ...rest] = raw.split(":");
  const resourceKey = rest.join(":");
  if (!resourceType || !mode || !resourceKey) {
    throw new CliError(`--resource must look like <type>:<mode>:<key>, got "${raw}"`);
  }
  return { resourceType, mode, resourceKey };
}

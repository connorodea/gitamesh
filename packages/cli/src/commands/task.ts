import { Command } from "commander";

import { createClient } from "../context.js";
import type { CliDeps } from "../context.js";
import { printJson, printTable } from "../output.js";

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
        repository_id: options.repositoryId,
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
    .option("--json", "machine-readable output", false)
    .action(
      async (
        taskId: string,
        options: { agentId: string; workspaceSessionId: string; json: boolean },
      ) => {
        const { client } = await createClient(deps);
        const result = await client.claimTask(taskId, {
          agent_id: options.agentId,
          workspace_session_id: options.workspaceSessionId,
        });
        if (options.json) {
          printJson(deps.sink, result);
        } else {
          deps.sink.log(`Task ${taskId} claimed.`);
        }
      },
    );

  task
    .command("heartbeat <taskId>")
    .description("Heartbeat the active attempt on a task")
    .requiredOption("--attempt-id <id>", "attempt id")
    .option("--json", "machine-readable output", false)
    .action(async (taskId: string, options: { attemptId: string; json: boolean }) => {
      const { client } = await createClient(deps);
      const result = await client.heartbeatTask(taskId, { attempt_id: options.attemptId });
      if (options.json) {
        printJson(deps.sink, result);
      } else {
        deps.sink.log(`Heartbeat sent for task ${taskId}.`);
      }
    });

  task
    .command("complete <taskId>")
    .description("Mark a task's active attempt complete")
    .requiredOption("--attempt-id <id>", "attempt id")
    .option("--json", "machine-readable output", false)
    .action(async (taskId: string, options: { attemptId: string; json: boolean }) => {
      const { client } = await createClient(deps);
      const result = await client.completeTask(taskId, { attempt_id: options.attemptId });
      if (options.json) {
        printJson(deps.sink, result);
      } else {
        deps.sink.log(`Task ${taskId} marked complete.`);
      }
    });

  task
    .command("fail <taskId>")
    .description("Mark a task's active attempt failed")
    .requiredOption("--attempt-id <id>", "attempt id")
    .option("--error <message>", "error message", "")
    .option("--json", "machine-readable output", false)
    .action(
      async (taskId: string, options: { attemptId: string; error: string; json: boolean }) => {
        const { client } = await createClient(deps);
        const result = await client.failTask(taskId, {
          attempt_id: options.attemptId,
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

import { Command } from "commander";

import { createClient } from "../context.js";
import type { CliDeps } from "../context.js";
import { resolveBody } from "../body.js";
import { CliError, printJson, printTable, printWarnings } from "../output.js";

const PROGRESS_PHASES = ["working", "blocked", "verifying", "ready_for_review"];

export interface TaskOwnerRecord {
  agent_id: string;
  display_name: string;
  attempt_id: string;
  heartbeat_at: string;
  expires_at: string;
}

export interface TaskRecord {
  task_id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  repository_id: string;
  workflow_id: string;
  branch: string | null;
  base_sha: string | null;
  dependencies: string[];
  join_policy: string;
  owner: TaskOwnerRecord | null;
  readiness: "ready" | "blocked" | null;
  blocked_by: string[];
}

interface TaskNoteRecord {
  note_id: string;
  agent_id: string;
  body: string;
  created_at: string;
}

interface TaskRevisionRecord {
  revision_id: string;
  changed_by: string | null;
  changed_at: string;
  changes: Record<string, { old: unknown; new: unknown }>;
}

/** Flat rows for `task list` / `status`: owner name and last heartbeat as columns. */
export function taskRows(tasks: TaskRecord[]): Array<Record<string, unknown>> {
  return tasks.map((task) => ({
    task_id: task.task_id,
    title: task.title,
    status: task.status,
    ready: task.readiness,
    owner: task.owner?.display_name ?? null,
    heartbeat: task.owner?.heartbeat_at ?? null,
    priority: task.priority,
    branch: task.branch,
  }));
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
    .option(
      "--depends-on <taskId>",
      "a task that must complete before this one can be claimed (repeatable)",
      collect,
      [] as string[],
    )
    .option("--join-policy <all|any>", "claimable when all (default) or any dependency completes")
    .option("--idempotency-key <key>", "idempotency key for safe retries")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        dependsOn: string[];
        joinPolicy?: string;
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
        const result = (await client.createTask({
          workflow_id: options.workflowId,
          repository_id: options.repositoryId,
          title: options.title,
          description: options.description,
          priority: Number(options.priority),
          branch: options.branch ?? null,
          base_sha: options.baseSha ?? null,
          required_capabilities: options.requiredCapability,
          dependencies: options.dependsOn,
          ...(options.joinPolicy ? { join_policy: options.joinPolicy } : {}),
          idempotency_key: options.idempotencyKey ?? null,
        })) as { task?: TaskRecord };
        printWarnings(deps.sink, result);
        if (options.json) {
          printJson(deps.sink, result);
        } else {
          deps.sink.log(result.task ? `Task ${result.task.task_id} created.` : "Task created.");
        }
      },
    );

  task
    .command("list")
    .description("List tasks with owner, last heartbeat and blocked/ready state")
    .option("--repository-id <id>", "filter by repository id")
    .option("--status <status>", "filter by task status")
    .option("--mine", "only tasks --agent-id currently holds", false)
    .option("--agent-id <id>", "agent id for --mine")
    .option("--unclaimed", "only tasks nobody holds that still wait to be claimed", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        repositoryId?: string;
        status?: string;
        mine: boolean;
        agentId?: string;
        unclaimed: boolean;
        json: boolean;
      }) => {
        if (options.mine && !options.agentId) {
          throw new CliError("--mine needs --agent-id <id>");
        }
        if (options.mine && options.unclaimed) {
          throw new CliError("--mine and --unclaimed cannot be used together");
        }
        const { client } = await createClient(deps);
        const result = (await client.listTasks({
          repositoryId: options.repositoryId,
          status: options.status,
          agentId: options.mine ? options.agentId : undefined,
          unclaimed: options.unclaimed ? "true" : undefined,
        })) as { tasks?: TaskRecord[] };
        const tasks = result.tasks ?? [];
        if (options.json) {
          printJson(deps.sink, tasks);
        } else {
          printTable(
            deps.sink,
            ["task_id", "title", "status", "ready", "owner", "heartbeat", "priority", "branch"],
            taskRows(tasks),
          );
        }
      },
    );

  task
    .command("show <taskId>")
    .description("Show a single task with its notes and revision history")
    .option("--json", "machine-readable output", false)
    .action(async (taskId: string, options: { json: boolean }) => {
      const { client } = await createClient(deps);
      const result = (await client.getTask(taskId)) as {
        task: TaskRecord;
        notes?: TaskNoteRecord[];
        revisions?: TaskRevisionRecord[];
      };
      if (options.json) {
        printJson(deps.sink, result);
        return;
      }
      const { task } = result;
      const log = (line: string) => deps.sink.log(line);
      log(`task_id:      ${task.task_id}`);
      log(`title:        ${task.title}`);
      log(`status:       ${task.status}${task.readiness ? ` (${task.readiness})` : ""}`);
      log(
        `owner:        ${
          task.owner
            ? `${task.owner.display_name} (${task.owner.agent_id}), last heartbeat ${task.owner.heartbeat_at}`
            : "-"
        }`,
      );
      log(`priority:     ${task.priority}`);
      log(`branch:       ${task.branch ?? "-"}`);
      log(`base_sha:     ${task.base_sha ?? "-"}`);
      log(`depends_on:   ${task.dependencies.join(", ") || "-"}`);
      if (task.blocked_by.length > 0) log(`blocked_by:   ${task.blocked_by.join(", ")}`);
      log(`workflow_id:  ${task.workflow_id}`);
      log(`repository:   ${task.repository_id}`);
      log("description:");
      for (const line of (task.description || "-").split("\n")) log(`    ${line}`);
      log("");
      log("== notes ==");
      const notes = result.notes ?? [];
      if (notes.length === 0) log("(none)");
      for (const note of notes) {
        log(`${note.created_at}  ${note.agent_id}`);
        for (const line of note.body.split("\n")) log(`    ${line}`);
      }
      log("");
      log("== revisions ==");
      const revisions = result.revisions ?? [];
      if (revisions.length === 0) log("(none)");
      for (const revision of revisions) {
        log(`${revision.changed_at}  ${revision.changed_by ?? "unknown"}`);
        for (const [field, change] of Object.entries(revision.changes)) {
          log(`    ${field}: ${JSON.stringify(change.old)} -> ${JSON.stringify(change.new)}`);
        }
      }
    });

  task
    .command("progress <taskId>")
    .description("Report progress on a task you hold. Needs the attempt id and fencing token from `claim`; never renews the lease")
    .requiredOption("--attempt-id <id>", "attempt id returned by the claim")
    .requiredOption("--fencing-token <n>", "fencing token returned by the claim")
    .requiredOption("--summary <text|@file|->", "what happened: text, @path, or - for stdin")
    .requiredOption("--phase <phase>", "working | blocked | verifying | ready_for_review")
    .option("--evidence <text>", "supporting detail such as a log line or test name (repeatable)", collect, [] as string[])
    .option("--idempotency-key <key>", "idempotency key for safe retries")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        taskId: string,
        options: {
          attemptId: string;
          fencingToken: string;
          summary: string;
          phase: string;
          evidence: string[];
          idempotencyKey?: string;
          json: boolean;
        },
      ) => {
        const fencingToken = Number(options.fencingToken);
        if (!Number.isInteger(fencingToken) || fencingToken < 0) {
          throw new CliError(`--fencing-token must be a non-negative integer, got "${options.fencingToken}"`);
        }
        if (!PROGRESS_PHASES.includes(options.phase)) {
          throw new CliError(`--phase must be one of ${PROGRESS_PHASES.join(", ")}, got "${options.phase}"`);
        }
        const summary = await resolveBody(options.summary, deps);
        const { client } = await createClient(deps);
        const result = (await client.reportTaskProgress(taskId, {
          attemptId: options.attemptId,
          fencingToken,
          summary,
          phase: options.phase,
          evidence: options.evidence,
        })) as { replayed: boolean };
        if (options.json) {
          printJson(deps.sink, result);
        } else {
          deps.sink.log(
            result.replayed
              ? `Progress for ${taskId} was already recorded (retry).`
              : `Progress recorded for ${taskId} (${options.phase}).`,
          );
        }
      },
    );

  task
    .command("progress-list <taskId>")
    .description("List the progress reports recorded for a task, oldest first")
    .option("--since <cursor>", "only events after this cursor (use nextCursor from a previous call)")
    .option("--limit <n>", "maximum events to scan")
    .option("--json", "machine-readable output", false)
    .action(async (taskId: string, options: { since?: string; limit?: string; json: boolean }) => {
      const { client } = await createClient(deps);
      const result = (await client.listTaskProgress(taskId, {
        since: options.since,
        limit: options.limit,
      })) as {
        events: Array<{ occurred_at: string; agent_id: string | null; payload: { summary: string; phase: string } }>;
        nextCursor: number;
      };
      if (options.json) {
        printJson(deps.sink, result);
        return;
      }
      if (result.events.length === 0) deps.sink.log("(no progress reports)");
      for (const e of result.events) {
        deps.sink.log(`${e.occurred_at}  ${e.agent_id ?? "-"}  [${e.payload.phase}]`);
        for (const line of e.payload.summary.split("\n")) deps.sink.log(`    ${line}`);
      }
    });

  task
    .command("update <taskId>")
    .description("Change a task's title, description, priority, branch, base SHA or dependencies")
    .option("--title <title>", "new title")
    .option("--description <text|@file|->", "new description: text, @path, or - for stdin")
    .option("--priority <n>", "new priority")
    .option("--branch <branch>", "new target branch")
    .option("--base-sha <sha>", "new base commit SHA")
    .option(
      "--depends-on <taskId>",
      "replace the dependency list with these tasks (repeatable)",
      collect,
      [] as string[],
    )
    .option("--clear-dependencies", "remove every dependency", false)
    .option(
      "--expect-depends-on <taskId>",
      "only apply if the task's current dependencies are exactly these (repeatable); refuses with 409 if someone else changed them",
      collect,
      [] as string[],
    )
    .option("--expect-no-dependencies", "only apply if the task currently has no dependencies", false)
    .option("--agent-id <id>", "agent making the change (recorded in the revision history)")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        taskId: string,
        options: {
          title?: string;
          description?: string;
          priority?: string;
          branch?: string;
          baseSha?: string;
          dependsOn: string[];
          clearDependencies: boolean;
          expectDependsOn: string[];
          expectNoDependencies: boolean;
          agentId?: string;
          json: boolean;
        },
      ) => {
        if (options.clearDependencies && options.dependsOn.length > 0) {
          throw new CliError("--clear-dependencies and --depends-on cannot be used together");
        }
        if (options.expectNoDependencies && options.expectDependsOn.length > 0) {
          throw new CliError("--expect-no-dependencies and --expect-depends-on cannot be used together");
        }
        const expecting = options.expectNoDependencies || options.expectDependsOn.length > 0;
        if (expecting && options.dependsOn.length === 0 && !options.clearDependencies) {
          throw new CliError("--expect-depends-on / --expect-no-dependencies need --depends-on or --clear-dependencies");
        }
        const body: Record<string, unknown> = {};
        if (options.title !== undefined) body.title = options.title;
        if (options.description !== undefined) {
          body.description = await resolveBody(options.description, deps);
        }
        if (options.priority !== undefined) {
          const priority = Number(options.priority);
          if (!Number.isFinite(priority)) {
            throw new CliError(`--priority must be a number, got "${options.priority}"`);
          }
          body.priority = priority;
        }
        if (options.branch !== undefined) body.branch = options.branch;
        if (options.baseSha !== undefined) body.base_sha = options.baseSha;
        if (options.dependsOn.length > 0) body.dependencies = options.dependsOn;
        if (options.clearDependencies) body.dependencies = [];
        if (expecting) body.expected_dependencies = options.expectNoDependencies ? [] : options.expectDependsOn;
        if (Object.keys(body).length === 0) {
          throw new CliError(
            "nothing to update: give --title, --description, --priority, --branch, --base-sha, --depends-on or --clear-dependencies",
          );
        }
        if (options.agentId !== undefined) body.updated_by = options.agentId;

        const { client } = await createClient(deps);
        const result = (await client.updateTask(taskId, body)) as {
          revision: TaskRevisionRecord | null;
        };
        if (options.json) {
          printJson(deps.sink, result);
        } else if (result.revision) {
          deps.sink.log(
            `Task ${taskId} updated: ${Object.keys(result.revision.changes).join(", ")} (revision ${result.revision.revision_id}).`,
          );
        } else {
          deps.sink.log(`Task ${taskId} unchanged: the given values match the current ones.`);
        }
      },
    );

  task
    .command("note <taskId>")
    .description("Add a progress note to a task (append-only; shown by `task show`)")
    .requiredOption("--agent-id <id>", "agent writing the note")
    .requiredOption("--body <text|@file|->", "note text, @path to read a file, or - for stdin")
    .option("--json", "machine-readable output", false)
    .action(async (taskId: string, options: { agentId: string; body: string; json: boolean }) => {
      const body = await resolveBody(options.body, deps);
      const { client } = await createClient(deps);
      const result = (await client.addTaskNote(taskId, { agent_id: options.agentId, body })) as {
        note?: TaskNoteRecord;
      };
      if (options.json) {
        printJson(deps.sink, result);
      } else {
        deps.sink.log(`Note ${result.note?.note_id ?? "unknown"} added to task ${taskId}.`);
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

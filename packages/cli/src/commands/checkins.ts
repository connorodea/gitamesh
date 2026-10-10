import { Command, InvalidArgumentError } from "commander";
import { createClient, type CliDeps } from "../context.js";
import { printJson } from "../output.js";

function integer(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError("Must be a nonnegative safe integer.");
  }
  return Number(value);
}
function collect(value: string, previous: string[]): string[] { return [...previous, value]; }

export function registerCheckinCommands(program: Command, deps: CliDeps): void {
  const message = program.command("message").description("Send, read and acknowledge agent messages");
  message.command("send")
    .requiredOption("--repository-id <id>", "repository conversation scope")
    .requiredOption("--from <agentId>", "registered sending agent")
    .requiredOption("--to <agentId>", "registered recipient")
    .requiredOption("--body <text>", "message text")
    .option("--task-id <id>", "related task in this repository")
    .option("--idempotency-key <key>", "reuse this key when retrying the same send")
    .option("--json", "machine-readable result")
    .action(async (o) => {
      const { client } = await createClient(deps);
      printJson(deps.sink, await client.sendMessage({ repositoryId: o.repositoryId,
        fromAgentId: o.from, toAgentId: o.to, body: o.body, taskId: o.taskId }, o.idempotencyKey));
    });
  message.command("inbox")
    .description("Read sent/received messages and acknowledgements; retain nextCursor for the next check")
    .requiredOption("--repository-id <id>", "repository conversation scope")
    .requiredOption("--agent-id <id>", "registered agent")
    .option("--since <cursor>", "exclusive event cursor", integer, 0)
    .option("--limit <n>", "events to scan, at most 500", integer, 200)
    .option("--json", "machine-readable result")
    .action(async (o) => {
      const { client } = await createClient(deps);
      printJson(deps.sink, await client.listMessages({ repositoryId: o.repositoryId,
        agentId: o.agentId, since: o.since, limit: o.limit }));
    });
  message.command("ack <messageId>")
    .requiredOption("--repository-id <id>", "repository conversation scope")
    .requiredOption("--agent-id <id>", "message recipient")
    .option("--json", "machine-readable result")
    .action(async (messageId, o) => {
      const { client } = await createClient(deps);
      printJson(deps.sink, await client.acknowledgeMessage(messageId,
        { repositoryId: o.repositoryId, agentId: o.agentId }));
    });

  const task = program.commands.find((command) => command.name() === "task")!;
  task.command("progress <taskId>")
    .description("Append a progress report under the current attempt lease; does not complete or renew the task")
    .requiredOption("--attempt-id <id>", "current attempt")
    .requiredOption("--fencing-token <n>", "current fencing token", integer)
    .requiredOption("--summary <text>", "what changed and what remains")
    .requiredOption("--phase <phase>", "working, blocked, verifying, or ready_for_review")
    .option("--evidence <reference>", "test, commit or artifact reference (repeatable)", collect, [])
    .option("--idempotency-key <key>", "reuse for retries of this report")
    .option("--json", "machine-readable result")
    .action(async (taskId, o) => {
      const { client } = await createClient(deps);
      printJson(deps.sink, await client.reportProgress(taskId, { attemptId: o.attemptId,
        fencingToken: o.fencingToken, summary: o.summary, phase: o.phase, evidence: o.evidence }, o.idempotencyKey));
    });
  task.command("history <taskId>")
    .description("Read progress history, current task status and lease freshness")
    .option("--since <cursor>", "exclusive event cursor", integer, 0)
    .option("--limit <n>", "events to scan, at most 500", integer, 200)
    .option("--json", "machine-readable result")
    .action(async (taskId, o) => {
      const { client } = await createClient(deps);
      printJson(deps.sink, await client.getProgress(taskId, { since: o.since, limit: o.limit }));
    });
  task.command("dependencies <taskId>")
    .description("Replace dependencies of an unclaimed task after checking its current dependency set")
    .option("--depends-on <taskId>", "dependency (repeatable)", collect, [])
    .option("--clear", "explicitly remove all dependencies")
    .option("--json", "machine-readable result")
    .action(async (taskId, o) => {
      if ((!o.dependsOn.length && !o.clear) || (o.dependsOn.length && o.clear)) {
        throw new InvalidArgumentError("Use --depends-on or --clear, exclusively.");
      }
      const { client } = await createClient(deps);
      const current = await client.getTask(taskId) as { task: { dependencies: string[] } };
      printJson(deps.sink, await client.setDependencies(taskId,
        { dependencies: o.dependsOn, expectedDependencies: current.task.dependencies }));
    });
}

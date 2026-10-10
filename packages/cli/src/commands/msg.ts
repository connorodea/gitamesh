import { Command } from "commander";

import { resolveBody } from "../body.js";
import { createClient } from "../context.js";
import type { CliDeps } from "../context.js";
import { CliError, printJson } from "../output.js";

interface MessageRecord {
  message_id: string;
  from: string;
  to: string;
  repository_id: string | null;
  task_id: string | null;
  body: string;
  created_at: string;
  acked_by: Array<{ agent_id: string; acked_at: string }>;
}

export function registerMsgCommands(program: Command, deps: CliDeps): void {
  const msg = program
    .command("msg")
    .description("Messages between agents: send, list, ack (append-only, never deleted)");

  msg
    .command("send")
    .description("Send a message to one agent or to all agents")
    .requiredOption("--from <agentId>", "sending agent id")
    .requiredOption("--to <agentId|all>", 'receiving agent id, or "all"')
    .requiredOption("--body <text|@file|->", "message text, @path to read a file, or - for stdin")
    .option("--repository-id <id>", "repository this message is about")
    .option("--task-id <id>", "task this message is about")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        from: string;
        to: string;
        body: string;
        repositoryId?: string;
        taskId?: string;
        json: boolean;
      }) => {
        const body = await resolveBody(options.body, deps);
        const { client } = await createClient(deps);
        const result = (await client.sendMessage({
          from: options.from,
          to: options.to,
          body,
          repository_id: options.repositoryId ?? null,
          task_id: options.taskId ?? null,
        })) as { message?: MessageRecord };
        if (options.json) {
          printJson(deps.sink, result);
        } else {
          deps.sink.log(`Message ${result.message?.message_id ?? "unknown"} sent to ${options.to}.`);
        }
      },
    );

  msg
    .command("list")
    .description("List messages, oldest first")
    .option("--to <agentId>", 'messages for this agent (includes messages to "all")')
    .option("--from <agentId>", "messages this agent sent")
    .option("--unread", "only messages --to has not acked (needs --to)", false)
    .option("--since <iso>", "only messages created after this ISO-8601 time")
    .option("--repository-id <id>", "filter by repository id")
    .option("--task-id <id>", "filter by task id")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        to?: string;
        from?: string;
        unread: boolean;
        since?: string;
        repositoryId?: string;
        taskId?: string;
        json: boolean;
      }) => {
        if (options.unread && !options.to) {
          throw new CliError("--unread needs --to <agentId>: unread is per agent");
        }
        const { client } = await createClient(deps);
        const result = (await client.listMessages({
          to: options.to,
          from: options.from,
          unread: options.unread ? "true" : undefined,
          since: options.since,
          repositoryId: options.repositoryId,
          taskId: options.taskId,
        })) as { messages?: MessageRecord[] };
        const messages = result.messages ?? [];
        if (options.json) {
          printJson(deps.sink, messages);
          return;
        }
        if (messages.length === 0) {
          deps.sink.log("(none)");
          return;
        }
        for (const message of messages) {
          const task = message.task_id ? `  task=${message.task_id}` : "";
          const acks = message.acked_by.map((ack) => ack.agent_id).join(", ") || "nobody";
          deps.sink.log(
            `${message.message_id}  ${message.created_at}  ${message.from} -> ${message.to}${task}  acked by: ${acks}`,
          );
          for (const line of message.body.split("\n")) deps.sink.log(`    ${line}`);
        }
      },
    );

  msg
    .command("ack <messageId>")
    .description("Mark a message as read by an agent")
    .requiredOption("--agent-id <id>", "agent that read the message")
    .option("--json", "machine-readable output", false)
    .action(async (messageId: string, options: { agentId: string; json: boolean }) => {
      const { client } = await createClient(deps);
      const result = (await client.ackMessage(messageId, { agent_id: options.agentId })) as {
        already_acked?: boolean;
      };
      if (options.json) {
        printJson(deps.sink, result);
      } else {
        deps.sink.log(
          result.already_acked
            ? `Message ${messageId} was already acked by ${options.agentId}.`
            : `Message ${messageId} acked by ${options.agentId}.`,
        );
      }
    });
}

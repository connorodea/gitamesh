import { Command } from "commander";

import { createClient } from "../context.js";
import type { CliDeps } from "../context.js";
import { printJson, printTable } from "../output.js";

interface AgentRecord {
  agent_id: string;
  display_name: string;
  runtime: string;
  status: string;
  last_heartbeat_at: string | null;
}

export function registerAgentCommands(program: Command, deps: CliDeps): void {
  const agent = program.command("agent").description("Agent registration, heartbeat, and listing");

  agent
    .command("register")
    .description("Register a new agent with the daemon")
    .requiredOption("--display-name <name>", "human-readable agent name")
    .requiredOption("--runtime <runtime>", "agent runtime, e.g. claude-code, codex, cursor, custom")
    .option("--namespace-id <id>", "namespace id", "default")
    .option("--version <version>", "agent version string", "0.0.0")
    .option("--capability <cap>", "a capability tag (repeatable)", collect, [] as string[])
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        displayName: string;
        runtime: string;
        namespaceId: string;
        version: string;
        capability: string[];
        json: boolean;
      }) => {
        const { client } = await createClient(deps);
        const result = await client.registerAgent({
          namespace_id: options.namespaceId,
          display_name: options.displayName,
          runtime: options.runtime,
          version: options.version,
          capabilities: options.capability,
        });
        if (options.json) {
          printJson(deps.sink, result);
        } else {
          deps.sink.log("Agent registered.");
        }
      },
    );

  agent
    .command("heartbeat <agentId>")
    .description("Send a heartbeat for an agent")
    .option("--json", "machine-readable output", false)
    .action(async (agentId: string, options: { json: boolean }) => {
      const { client } = await createClient(deps);
      const result = await client.heartbeatAgent(agentId);
      if (options.json) {
        printJson(deps.sink, result);
      } else {
        deps.sink.log(`Heartbeat sent for agent ${agentId}.`);
      }
    });

  agent
    .command("list")
    .description("List registered agents")
    .option("--json", "machine-readable output", false)
    .action(async (options: { json: boolean }) => {
      const { client } = await createClient(deps);
      const result = (await client.listAgents()) as { agents?: AgentRecord[] };
      const agents = result.agents ?? [];
      if (options.json) {
        printJson(deps.sink, agents);
      } else {
        printTable(deps.sink, ["agent_id", "display_name", "runtime", "status", "last_heartbeat_at"], agents);
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

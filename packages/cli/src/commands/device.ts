import { Command } from "commander";

import { createClient } from "../context.js";
import type { CliDeps } from "../context.js";
import { printJson, printTable } from "../output.js";

interface DeviceRecord {
  device_id: string;
  hostname: string;
  display_name: string;
  status: string;
  capabilities: string;
  agent_id: string;
  last_heartbeat_at: string | null;
}

export function registerDeviceCommands(program: Command, deps: CliDeps): void {
  const device = program.command("device").description("Device registration, heartbeat, and listing");

  device
    .command("register")
    .description("Register a new device with the daemon")
    .requiredOption("--hostname <hostname>", "device hostname or identifier")
    .requiredOption("--display-name <name>", "human-readable device name")
    .requiredOption("--agent-id <id>", "agent id running on this device")
    .option("--namespace-id <id>", "namespace id", "default")
    .option("--capability <cap>", "a capability tag (repeatable)", collect, [] as string[])
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        hostname: string;
        displayName: string;
        agentId: string;
        namespaceId: string;
        capability: string[];
        json: boolean;
      }) => {
        const { client } = await createClient(deps);
        const result = await client.registerDevice({
          namespace_id: options.namespaceId,
          hostname: options.hostname,
          display_name: options.displayName,
          agent_id: options.agentId,
          capabilities: options.capability,
        });
        if (options.json) {
          printJson(deps.sink, result);
        } else {
          deps.sink.log("Device registered.");
        }
      },
    );

  device
    .command("heartbeat <deviceId>")
    .description("Send a heartbeat for a device")
    .option("--json", "machine-readable output", false)
    .action(async (deviceId: string, options: { json: boolean }) => {
      const { client } = await createClient(deps);
      const result = await client.heartbeatDevice(deviceId);
      if (options.json) {
        printJson(deps.sink, result);
      } else {
        deps.sink.log(`Heartbeat sent for device ${deviceId}.`);
      }
    });

  device
    .command("list")
    .description("List registered devices")
    .option("--json", "machine-readable output", false)
    .action(async (options: { json: boolean }) => {
      const { client } = await createClient(deps);
      const result = (await client.listDevices()) as { devices?: DeviceRecord[] };
      const devices = result.devices ?? [];
      if (options.json) {
        printJson(deps.sink, devices);
      } else {
        devices.forEach((d) => {
          d.capabilities = JSON.stringify(d.capabilities || []);
        });
        printTable(
          deps.sink,
          ["device_id", "hostname", "display_name", "status", "agent_id", "capabilities"],
          devices,
        );
      }
    });

  device
    .command("show <deviceId>")
    .description("Show details for a device")
    .option("--json", "machine-readable output", false)
    .action(async (deviceId: string, options: { json: boolean }) => {
      const { client } = await createClient(deps);
      const result = await client.getDevice(deviceId);
      if (options.json) {
        printJson(deps.sink, result);
      } else {
        printJson(deps.sink, result);
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

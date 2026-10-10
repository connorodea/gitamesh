import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../src/server.js";

describe("createMcpServer", () => {
  it("builds an McpServer instance with every tool registered, without connecting a transport", () => {
    const server = createMcpServer({ daemonUrl: "http://127.0.0.1:8787", token: null, tokenSource: "none" });

    expect(server).toBeInstanceOf(McpServer);
    expect(server.isConnected()).toBe(false);
  });

  it("registers the agent-collaboration tools", () => {
    const server = createMcpServer({ daemonUrl: "http://127.0.0.1:8787", token: null, tokenSource: "none" });
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );

    expect(registered).toEqual(
      expect.arrayContaining([
        "gitamesh_send_message",
        "gitamesh_list_messages",
        "gitamesh_ack_message",
        "gitamesh_get_task",
        "gitamesh_update_task",
        "gitamesh_add_task_note",
        "gitamesh_acquire_lock",
        "gitamesh_list_locks",
        "gitamesh_heartbeat_lock",
        "gitamesh_release_lock",
      ]),
    );
  });
});

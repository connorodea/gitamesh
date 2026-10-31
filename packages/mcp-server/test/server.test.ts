import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";

describe("createMcpServer", () => {
  it("returns successful progress tools through the MCP transport", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = init?.method === "POST"
        ? { progress: { event_type: "task.progress" }, replayed: false }
        : { events: [{ event_type: "task.progress" }], nextCursor: 1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const server = createMcpServer({ daemonUrl: "http://daemon.test", token: null, tokenSource: "none" });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: "gitamesh_report_progress", arguments: {
        taskId: "t", attemptId: "a", fencingToken: 1, summary: "working", phase: "working",
      } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true });
      const listed = await client.callTool({ name: "gitamesh_list_task_progress", arguments: { taskId: "t" } });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toMatchObject({ ok: true, nextCursor: 1 });
    } finally {
      await client.close();
      await server.close();
      fetchMock.mockRestore();
    }
  });
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
        "gitamesh_register_repository",
        "gitamesh_list_repositories",
      ]),
    );
  });
});

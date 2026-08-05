import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../src/server.js";

describe("createMcpServer", () => {
  it("builds an McpServer instance with every tool registered, without connecting a transport", () => {
    const server = createMcpServer({ daemonUrl: "http://127.0.0.1:8787", token: null, tokenSource: "none" });

    expect(server).toBeInstanceOf(McpServer);
    expect(server.isConnected()).toBe(false);
  });
});

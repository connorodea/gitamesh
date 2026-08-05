#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { resolveConfig } from "./config.js";

export { createMcpServer } from "./server.js";
export { resolveConfig } from "./config.js";
export type { GitameshMcpConfig } from "./config.js";
export { DaemonClient } from "./internal-client.js";

async function main(): Promise<void> {
  const config = await resolveConfig();
  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for the MCP protocol stream; log to stderr only.
  console.error(
    `gitamesh-mcp-server connected (daemon: ${config.daemonUrl}, token: ${
      config.token ? "configured" : "none"
    })`,
  );
}

// Only auto-start when run directly (e.g. `node dist/index.js` or via a
// registered MCP client), not when imported as a library (tests import
// `createMcpServer`/`resolveConfig` directly without wanting a live stdio
// connection).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error) => {
    console.error("gitamesh-mcp-server failed to start:", error);
    process.exitCode = 1;
  });
}

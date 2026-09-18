import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LoopMemClient, executeLoopMem, memoryNamespace, type LoopMemExecutor } from "../src/loopmem-client.js";
import { handleMemoryRemember, handleMemoryRecall, handleMemoryContext, MemoryRememberInputSchema } from "../src/tools/memory.js";
import { resolveConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const repositoryId = "repository/with arbitrary:characters";
const namespace = memoryNamespace(repositoryId);
const stored = {
  id: 1, kind: "fact", text: "Use saved memory", evidence: [], supersedes: null,
  provenance: { agent_id: "agent-a", session_id: "session-a", recorded_at_unix_ms: 10 },
};

function fakeClient(outputs: unknown[]) {
  const calls: string[][] = [];
  const execute: LoopMemExecutor = async (_executable, args) => {
    calls.push(args);
    const result = outputs.shift();
    return typeof result === "string" ? result : JSON.stringify(result);
  };
  return { calls, client: new LoopMemClient({ executable: "loopmem", storeRoot: path.resolve(os.tmpdir(), "shared memory"), execute }) };
}

describe("LoopMem configuration", () => {
  it("stays disabled without an explicit store", async () => {
    const config = await resolveConfig(os.tmpdir(), { GITAMESH_LOOPMEM_BIN: "custom-loopmem" });
    expect(config.loopmem).toBeUndefined();
    const result = await handleMemoryRecall({ repositoryId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toContain("loopmem-disabled");
  });

  it("uses an absolute shared store and defaults the executable", async () => {
    const storeRoot = path.resolve(os.tmpdir(), "shared memory");
    expect((await resolveConfig(os.tmpdir(), { GITAMESH_LOOPMEM_STORE: storeRoot })).loopmem)
      .toEqual({ executable: "loopmem", storeRoot });
    expect((await resolveConfig(os.tmpdir(), { GITAMESH_LOOPMEM_STORE: storeRoot, GITAMESH_LOOPMEM_BIN: "/tools/loopmem" })).loopmem?.executable)
      .toBe("/tools/loopmem");
    await expect(resolveConfig(os.tmpdir(), { GITAMESH_LOOPMEM_STORE: "relative-store" })).rejects.toThrow("absolute");
  });
});

describe("LoopMem command bridge", () => {
  it("bounds provenance labels in UTF-8 bytes and refuses control characters", () => {
    const input = { repositoryId, agentId: "a".repeat(256), workspaceSessionId: "session-a", kind: "fact", text: "Fact" };
    expect(MemoryRememberInputSchema.safeParse(input).success).toBe(true);
    for (const agentId of ["a".repeat(257), "é".repeat(129), "agent\nname", "agent\u0085name"]) {
      expect(MemoryRememberInputSchema.safeParse({ ...input, agentId }).success).toBe(false);
      expect(MemoryRememberInputSchema.safeParse({ ...input, workspaceSessionId: agentId }).success).toBe(false);
    }
  });

  it("derives a safe stable namespace from the repository ID", () => {
    expect(namespace).toMatch(/^repo-[a-f0-9]{64}$/);
    expect(memoryNamespace(repositoryId)).toBe(namespace);
    expect(memoryNamespace("../different")).not.toBe(namespace);
  });

  it("passes text as one argument and keeps agent/session/task provenance", async () => {
    const { client, calls } = fakeClient([stored]);
    const result = await handleMemoryRemember({
      repositoryId, agentId: "agent-a", workspaceSessionId: "session-a", kind: "fact",
      text: "--flag $(touch /tmp/not-executed)\nsecond line", evidence: ["src/file with spaces.ts"],
      supersedes: 9, taskId: "task-one", attemptId: "attempt-two",
    }, client);
    expect(result.ok).toBe(true);
    expect(calls[0]).toContain(`--text=--flag $(touch /tmp/not-executed)\nsecond line`);
    expect(calls[0]).toContain("--agent=agent-a");
    expect(calls[0]).toContain("--session=session-a");
    expect(calls[0]).toContain("--evidence=src/file with spaces.ts");
    expect(calls[0]).toContain("--evidence=gitamesh:task:task-one");
    expect(calls[0]).toContain("--evidence=gitamesh:attempt:attempt-two");
    expect(calls[0]).toContain("--supersedes=9");
    expect(calls[0]?.slice(2, 5)).toEqual(["--namespace", namespace, "remember"]);
  });

  it("supports init, filtered recall, get, and raw context", async () => {
    const status = { namespace, description: "Shared facts", store: "/memory", stored_memories: 1, active_memories: 1, max_context_bytes: 12000 };
    const page = { namespace, memories: [stored], total_matches: 1, has_more: false };
    const { client, calls } = fakeClient([status, page, stored, "# Shared context\n"]);
    expect(await client.initialize(repositoryId, "Shared facts")).toEqual(status);
    expect(await client.recall(repositoryId, { query: "saved", kind: "fact", agentId: "agent-a", workspaceSessionId: "session-a", includeSuperseded: true, limit: 8 })).toEqual(page);
    expect(await client.get(repositoryId, 1)).toEqual(stored);
    expect(await client.context(repositoryId)).toBe("# Shared context\n");
    expect(calls[1]).toEqual(expect.arrayContaining(["--query=saved", "--include-superseded", "--limit=8"]));
    expect(calls[2]?.slice(-2)).toEqual(["get", "1"]);
  });

  it("rejects malformed responses, wrong namespaces, and false provenance", async () => {
    for (const output of ["not JSON", { ...stored, kind: "unknown" }, { ...stored, unexpected: true }, { ...stored, provenance: null }]) {
      const { client } = fakeClient([output]);
      const result = await handleMemoryRemember({ repositoryId, agentId: "agent-a", workspaceSessionId: "session-a", kind: "fact", text: "Fact" }, client);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toContain("invalid-output");
    }
    const { client } = fakeClient([{ namespace: "wrong", memories: [], total_matches: 0, has_more: false }]);
    expect((await handleMemoryRecall({ repositoryId }, client)).ok).toBe(false);
  });

  it("accepts legacy memories without provenance on read", async () => {
    const { provenance: _provenance, ...legacy } = stored;
    const { client } = fakeClient([legacy, { ...legacy, provenance: null }]);
    expect(await client.get(repositoryId, 1)).toEqual(legacy);
    expect((await client.get(repositoryId, 1)).provenance).toBeNull();
  });

  it("validates input before spawning and does not echo raw errors", async () => {
    const { client, calls } = fakeClient([]);
    const result = await handleMemoryRemember({ repositoryId, agentId: "", workspaceSessionId: "session-a", kind: "fact", text: "Fact" }, client);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    const broken = new LoopMemClient({ executable: "loopmem", storeRoot: os.tmpdir(), execute: async () => { throw new Error("private content"); } });
    expect(JSON.stringify(await handleMemoryContext({ repositoryId }, broken))).not.toContain("private content");
  });
});

describe("bounded executable transport", () => {
  it("runs an executable without a shell", async () => {
    const text = "$(do-not-run); space\nline";
    expect(await executeLoopMem(process.execPath, ["-e", "process.stdout.write(process.argv[1])", text], { timeoutMs: 2000, maxOutputBytes: 1024 })).toBe(text);
  });

  it("reports nonzero exit without returning stderr or the command arguments", async () => {
    await expect(executeLoopMem(process.execPath, ["-e", "console.error('private content'); process.exit(7)"], { timeoutMs: 2000, maxOutputBytes: 1024 }))
      .rejects.toMatchObject({ code: "command-failed", message: "LoopMem command failed. Check the store and command with the local CLI." });
  });

  it("classifies an already replaced memory without returning child stderr", async () => {
    await expect(executeLoopMem(process.execPath, ["-e", "console.error('LoopMem error: memory 4 is already superseded'); console.error('private content'); process.exit(1)"], { timeoutMs: 2000, maxOutputBytes: 1024 }))
      .rejects.toMatchObject({ code: "memory-conflict", message: "Recall latest memory before replacing an entry." });
  });

  it("stops timed-out and oversized output processes", async () => {
    await expect(executeLoopMem(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100, maxOutputBytes: 1024 }))
      .rejects.toMatchObject({ code: "timeout" });
    await expect(executeLoopMem(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { timeoutMs: 2000, maxOutputBytes: 1024 }))
      .rejects.toMatchObject({ code: "output-limit" });
  });
});

describe.runIf(Boolean(process.env.LOOPMEM_TEST_BIN))("real LoopMem shared-memory bridge", () => {
  it("shares records between two agents, supersedes explicitly, and keeps repositories separate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-loopmem-integration-"));
    try {
      const options = { executable: process.env.LOOPMEM_TEST_BIN!, storeRoot: root };
      const first = new LoopMemClient(options);
      const second = new LoopMemClient(options);
      await first.initialize("repo-one", "Share durable facts across sessions");
      const remembered = await first.remember("repo-one", { agentId: "agent-a", workspaceSessionId: "session-a", kind: "decision", text: "Use saved records" });
      expect((await second.recall("repo-one")).memories).toEqual([remembered]);
      const updated = await second.remember("repo-one", { agentId: "agent-b", workspaceSessionId: "session-b", kind: "decision", text: "Use reviewed saved records", supersedes: remembered.id });
      expect((await first.recall("repo-one")).memories).toEqual([updated]);
      const stale = await handleMemoryRemember({ repositoryId: "repo-one", agentId: "agent-a", workspaceSessionId: "session-a", kind: "decision", text: "Stale replacement", supersedes: remembered.id }, first);
      expect(stale).toMatchObject({ ok: false, error: { type: "https://gitamesh.dev/mcp-problems/loopmem-memory-conflict" } });
      expect((await first.recall("repo-one", { includeSuperseded: true })).total_matches).toBe(2);
      expect((await first.get("repo-one", remembered.id)).provenance?.agent_id).toBe("agent-a");
      expect(await second.context("repo-one")).toContain("Use reviewed saved records");
      await first.initialize("repo-two");
      expect((await second.recall("repo-two")).total_matches).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});


describe("MCP memory tool registration", () => {
  it("lists all five tools and returns a structured disabled result through MCP", async () => {
    const server = createMcpServer({ daemonUrl: "http://127.0.0.1:8787", token: null, tokenSource: "none" });
    const client = new Client({ name: "memory-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "gitamesh_memory_init", "gitamesh_memory_remember", "gitamesh_memory_recall",
        "gitamesh_memory_get", "gitamesh_memory_context",
      ]));
      const result = await client.callTool({ name: "gitamesh_memory_recall", arguments: { repositoryId: "repo-one" } });
      expect(result.structuredContent).toMatchObject({ ok: false, error: {
        type: "https://gitamesh.dev/mcp-problems/loopmem-disabled",
      } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

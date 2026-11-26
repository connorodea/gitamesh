import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import type { GitameshMcpConfig } from "../src/config.js";
import { LoopMemClient, type Memory, type RememberInput } from "../src/loopmem-client.js";

const repositoryId = "knowledge-integration-repo";
const directories: string[] = [];
const connections: { client: Client; server: ReturnType<typeof createMcpServer> }[] = [];

interface SourceState {
  state: "available" | "disabled" | "unavailable" | "omitted";
  truncated: boolean;
}
interface PacketResult {
  ok: true;
  packet: {
    repositoryId: string;
    markdown: string;
    bytes: number;
    maxBytes: number;
    partial: boolean;
    sources: {
      knowledge: SourceState & { notes: { path: string; sha256: string; bytes: number }[]; omittedCount: number };
      memory: SourceState;
      tasks: SourceState;
      claims: SourceState;
    };
  };
}
interface ReadResult {
  ok: true;
  note: { path: string; sha256: string; bytes: number; content: string };
}
interface ExportResult {
  ok: true;
  memoryId: number;
  exported: { path: string; sha256: string; replayed: boolean };
  sourceCheck: { status: string; count: number };
}

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    await connection.client.close();
    await connection.server.close();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-knowledge-mcp-"));
  directories.push(directory);
  const root = path.join(directory, "vault");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "Decisions.md"), "# Current decision\n\nUse PostgreSQL for coordination.\n", "utf8");
  return { directory, root };
}

function config(root?: string, writable = false, storeRoot?: string): GitameshMcpConfig {
  return {
    daemonUrl: "http://coordination.invalid:8787",
    token: "test-token",
    tokenSource: "env",
    ...(root ? { knowledge: { root, repositoryId, writable } } : {}),
    ...(storeRoot ? { loopmem: { executable: "mock-loopmem-not-executed", storeRoot } } : {}),
  };
}

async function connect(settings: GitameshMcpConfig, name = "knowledge-client") {
  const server = createMcpServer(settings);
  const client = new Client({ name, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const connection = { client, server };
  connections.push(connection);
  return connection;
}

async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as T;
}

/**
 * Disk-backed test double for the memory service, shared by independently
 * constructed MCP servers. This exercises the real MCP registration and
 * filesystem adapter, not the real LoopMem binary or its locking guarantees.
 */
async function installMemoryFixture(directory: string) {
  const store = path.join(directory, "memory-fixture.json");
  await fs.writeFile(store, "[]", "utf8");
  const read = async (): Promise<(Memory & { repositoryId: string })[]> => JSON.parse(await fs.readFile(store, "utf8"));
  const remember = vi.spyOn(LoopMemClient.prototype, "remember").mockImplementation(async (repo: string, input: RememberInput) => {
    const records = await read();
    const memory: Memory = {
      id: records.length + 1,
      kind: input.kind,
      text: input.text,
      evidence: input.evidence ?? [],
      supersedes: input.supersedes ?? null,
      provenance: { agent_id: input.agentId, session_id: input.workspaceSessionId, recorded_at_unix_ms: 1_000 + records.length },
    };
    records.push({ ...memory, repositoryId: repo });
    await fs.writeFile(store, JSON.stringify(records), "utf8");
    return memory;
  });
  const get = vi.spyOn(LoopMemClient.prototype, "get").mockImplementation(async (repo: string, id: number) => {
    const record = (await read()).find((entry) => entry.repositoryId === repo && entry.id === id);
    if (!record) throw new Error("Missing fixture memory");
    const { repositoryId: _repositoryId, ...memory } = record;
    return memory;
  });
  const context = vi.spyOn(LoopMemClient.prototype, "context").mockImplementation(async (repo: string) => {
    const records = (await read()).filter((entry) => entry.repositoryId === repo);
    const superseded = new Set(records.flatMap((entry) => entry.supersedes === null ? [] : [entry.supersedes]));
    return "# Active fixture memory\n\n" + records.filter((entry) => !superseded.has(entry.id)).map((entry) => entry.text).join("\n\n");
  });
  return { read, remember, get, context };
}

async function remember(client: Client, text: string, supersedes?: number) {
  const result = await call<{ ok: boolean; memory: Memory }>(client, "gitamesh_memory_remember", {
    repositoryId,
    kind: "next",
    text,
    agentId: "agent-one",
    workspaceSessionId: "session-one",
    evidence: ["Decisions.md"],
    ...(supersedes === undefined ? {} : { supersedes }),
  });
  expect(result.ok).toBe(true);
  return result.memory;
}

function stubEmptyCoordination() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    expect(url.searchParams.get("repositoryId")).toBe(repositoryId);
    return Response.json(url.pathname === "/v1/tasks" ? { tasks: [] } : { claims: [] });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("knowledge MCP integration", () => {
  it("registers discoverable tools while disabled and returns structured disabled results", async () => {
    const { client } = await connect(config());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "gitamesh_knowledge_read", "gitamesh_knowledge_context", "gitamesh_export_handoff",
    ]));
    for (const [name, args] of [
      ["gitamesh_knowledge_read", { repositoryId, path: "Decisions.md" }],
      ["gitamesh_knowledge_context", { repositoryId }],
      ["gitamesh_export_handoff", { repositoryId, memoryId: 1 }],
    ] as const) {
      expect(await call(client, name, args)).toMatchObject({ ok: false, error: { type: expect.stringContaining("knowledge-disabled") } });
    }
  });

  it("rejects a different repository before touching missing paths, memory, or the daemon", async () => {
    const { directory } = await workspace();
    const fixture = await installMemoryFixture(directory);
    const fetch = stubEmptyCoordination();
    const { client } = await connect(config(path.join(directory, "does-not-exist"), true, directory));
    const other = "another-repository";
    for (const [name, args] of [
      ["gitamesh_knowledge_read", { repositoryId: other, path: "Decisions.md" }],
      ["gitamesh_knowledge_context", { repositoryId: other }],
      ["gitamesh_export_handoff", { repositoryId: other, memoryId: 1 }],
    ] as const) {
      expect(await call(client, name, args)).toMatchObject({ ok: false, error: { type: expect.stringContaining("repository-mismatch") } });
    }
    expect(fixture.get).not.toHaveBeenCalled();
    expect(fixture.context).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads exact source bytes while exports remain read-only unless explicitly enabled", async () => {
    const { directory, root } = await workspace();
    const fixture = await installMemoryFixture(directory);
    const { client } = await connect(config(root, false, directory));
    const result = await call<ReadResult>(client, "gitamesh_knowledge_read", { repositoryId, path: "Decisions.md" });
    const bytes = await fs.readFile(path.join(root, "Decisions.md"));
    expect(result).toMatchObject({ ok: true, note: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), content: bytes.toString("utf8") } });
    expect(await call(client, "gitamesh_export_handoff", { repositoryId, memoryId: 1 }))
      .toMatchObject({ ok: false, error: { type: expect.stringContaining("read-only") } });
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it("lets a fresh MCP server resume a saved handoff and replay its immutable export", async () => {
    const { directory, root } = await workspace();
    const fixture = await installMemoryFixture(directory);
    stubEmptyCoordination();
    const settings = config(root, true, directory);
    const first = await connect(settings, "first-agent-session");
    const source = (await call<ReadResult>(first.client, "gitamesh_knowledge_read", { repositoryId, path: "Decisions.md" })).note;
    const memory = await remember(first.client, "Continue from the reviewed ingestion task; the next action is to verify its tests.");
    const exported = await call<ExportResult>(first.client, "gitamesh_export_handoff", {
      repositoryId, memoryId: memory.id, expectedSources: [{ path: source.path, sha256: source.sha256 }],
    });
    expect(exported).toMatchObject({ ok: true, memoryId: memory.id, exported: { replayed: false }, sourceCheck: { status: "checked", count: 1 } });
    await first.client.close();
    await first.server.close();
    connections.splice(connections.indexOf(first), 1);

    const second = await connect(settings, "second-agent-session");
    const context = await call<PacketResult>(second.client, "gitamesh_knowledge_context", { repositoryId });
    expect(context.ok).toBe(true);
    expect(context.packet.markdown).toContain("Use PostgreSQL for coordination.");
    expect(context.packet.markdown).toContain("Continue from the reviewed ingestion task");
    expect(context.packet.sources.knowledge.notes.map((note) => note.path)).toEqual(["Decisions.md"]);
    expect(context.packet.sources.memory.state).toBe("available");
    expect(await call<ExportResult>(second.client, "gitamesh_export_handoff", { repositoryId, memoryId: memory.id }))
      .toMatchObject({ ok: true, exported: { ...exported.exported, replayed: true } });
    expect(fixture.remember).toHaveBeenCalledTimes(1);
    const file = await fs.readFile(path.join(root, exported.exported.path), "utf8");
    expect(file).toContain("agent-one");
    expect(file).toContain("Historical generated projection");
  });

  it("rejects stale source revisions and returns a changed decision in the next packet", async () => {
    const { directory, root } = await workspace();
    await installMemoryFixture(directory);
    const { client } = await connect(config(root, true, directory));
    const old = (await call<ReadResult>(client, "gitamesh_knowledge_read", { repositoryId, path: "Decisions.md" })).note;
    const memory = await remember(client, "A handoff based on the earlier decision.");
    await fs.writeFile(path.join(root, "Decisions.md"), "# Updated decision\n\nThe current owner-approved migration has a new acceptance criterion.\n", "utf8");
    expect(await call(client, "gitamesh_export_handoff", {
      repositoryId, memoryId: memory.id, expectedSources: [{ path: old.path, sha256: old.sha256 }],
    })).toMatchObject({ ok: false, error: { type: expect.stringContaining("stale-source") } });
    await expect(fs.stat(path.join(root, "Handoffs"))).rejects.toMatchObject({ code: "ENOENT" });
    const context = await call<PacketResult>(client, "gitamesh_knowledge_context", {
      repositoryId, includeMemory: false, includeCoordination: false,
    });
    expect(context.packet.markdown).toContain("current owner-approved migration has a new acceptance criterion");
    expect(context.packet.markdown).not.toContain("Use PostgreSQL for coordination");
    expect(context.packet.sources.knowledge.notes[0]?.sha256).not.toBe(old.sha256);
    expect(context.packet.sources.memory.state).toBe("omitted");
    expect(context.packet.sources.tasks.state).toBe("omitted");
  });

  it("recovers an export failure from the saved ID without repeating the memory write", async () => {
    const { directory, root } = await workspace();
    const fixture = await installMemoryFixture(directory);
    const { client } = await connect(config(root, true, directory));
    const memory = await remember(client, "The canonical journal write survives projection failure.");
    await fs.writeFile(path.join(root, "Handoffs"), "A file occupies the output directory.", "utf8");
    expect(await call(client, "gitamesh_export_handoff", { repositoryId, memoryId: memory.id })).toMatchObject({ ok: false });
    expect((await fixture.read()).map((entry) => entry.id)).toEqual([memory.id]);
    await fs.unlink(path.join(root, "Handoffs"));
    const exported = await call<ExportResult>(client, "gitamesh_export_handoff", { repositoryId, memoryId: memory.id });
    expect(exported).toMatchObject({ ok: true, memoryId: memory.id, exported: { replayed: false } });
    expect(fixture.remember).toHaveBeenCalledTimes(1);
    await fs.writeFile(path.join(root, exported.exported.path), "Human changes must not be overwritten.\n", "utf8");
    expect(await call(client, "gitamesh_export_handoff", { repositoryId, memoryId: memory.id }))
      .toMatchObject({ ok: false, error: { type: expect.stringContaining("handoff-conflict") } });
    expect(await fs.readFile(path.join(root, exported.exported.path), "utf8")).toBe("Human changes must not be overwritten.\n");
  });

  it("keeps superseded exported history out of automatic current context", async () => {
    const { directory, root } = await workspace();
    await installMemoryFixture(directory);
    const { client } = await connect(config(root, true, directory));
    const old = await remember(client, "OBSOLETE_NEXT_ACTION_FROM_PREVIOUS_SESSION");
    const exported = await call<ExportResult>(client, "gitamesh_export_handoff", { repositoryId, memoryId: old.id });
    await remember(client, "CURRENT_NEXT_ACTION_AFTER_REVIEW", old.id);
    const context = await call<PacketResult>(client, "gitamesh_knowledge_context", { repositoryId, includeCoordination: false });
    expect(context.packet.markdown).toContain("CURRENT_NEXT_ACTION_AFTER_REVIEW");
    expect(context.packet.markdown).not.toContain("OBSOLETE_NEXT_ACTION_FROM_PREVIOUS_SESSION");
    expect(context.packet.sources.knowledge.notes.every((note) => !note.path.startsWith("Handoffs/"))).toBe(true);
    const historical = await call<ReadResult>(client, "gitamesh_knowledge_read", { repositoryId, path: exported.exported.path });
    expect(historical.note.content).toContain("OBSOLETE_NEXT_ACTION_FROM_PREVIOUS_SESSION");
    expect(historical.note.content).toContain("Historical generated projection");
  });

  it("distinguishes a successful empty source from disabled memory and a failed claims read", async () => {
    const { root } = await workspace();
    let failClaims = true;
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (input) => {
      const route = new URL(String(input)).pathname;
      if (route === "/v1/tasks") return Response.json({ tasks: [] });
      return failClaims ? Response.json({ detail: "temporarily unavailable" }, { status: 503 }) : Response.json({ claims: [] });
    }));
    const { client } = await connect(config(root));
    const degraded = await call<PacketResult>(client, "gitamesh_knowledge_context", { repositoryId });
    expect(degraded.packet.sources).toMatchObject({
      memory: { state: "disabled" }, tasks: { state: "available", truncated: false }, claims: { state: "unavailable" },
    });
    expect(degraded.packet.partial).toBe(true);
    expect(degraded.packet.markdown).toContain("No active tasks in this successful repository read");
    expect(degraded.packet.markdown).not.toContain("No active resource claims");
    failClaims = false;
    const restored = await call<PacketResult>(client, "gitamesh_knowledge_context", { repositoryId });
    expect(restored.packet.sources.claims).toEqual({ state: "available", truncated: false });
    expect(restored.packet.markdown).toContain("No active resource claims in this successful repository read");
  });

  it("fails closed on malformed or cross-repository coordination data", async () => {
    const { root } = await workspace();
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (input) => {
      if (new URL(String(input)).pathname === "/v1/tasks") return Response.json({ tasks: "invalid collection" });
      return Response.json({ claims: [{
        resource_claim_id: "claim-one", repository_id: "another-repository", task_id: "task-one", attempt_id: "attempt-one",
        resource_type: "path", resource_key: "PRIVATE_OTHER_REPOSITORY_PATH", mode: "write", lease_id: "lease-one", fencing_token: 1,
        expires_at: "2099-01-01T00:00:00.000Z",
      }] });
    }));
    const { client } = await connect(config(root));
    const result = await call<PacketResult>(client, "gitamesh_knowledge_context", { repositoryId, includeMemory: false });
    expect(result.packet.sources.tasks.state).toBe("unavailable");
    expect(result.packet.sources.claims.state).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_OTHER_REPOSITORY_PATH");
  });

  it("bounds the entire structured packet in UTF-8 bytes, including metadata and truncated memory", async () => {
    const { directory, root } = await workspace();
    await installMemoryFixture(directory);
    stubEmptyCoordination();
    await fs.writeFile(path.join(root, "Unicode.md"), "# Unicode source\n\n" + "研究🧭é\n".repeat(80), "utf8");
    const { client } = await connect(config(root, true, directory));
    await remember(client, "Memory content with quotes, newlines, and unicode: \"🧭研究\"\n".repeat(500));
    const result = await call<PacketResult>(client, "gitamesh_knowledge_context", { repositoryId, maxBytes: 4096 });
    expect(result.ok).toBe(true);
    const size = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(result.packet.bytes).toBe(size);
    expect(size).toBeLessThanOrEqual(4096);
    expect(result.packet.maxBytes).toBe(4096);
    expect(result.packet.partial).toBe(true);
    expect(result.packet.sources.memory.truncated).toBe(true);
    expect(result.packet.markdown).not.toContain("\uFFFD");
    expect(result.packet.sources.knowledge.notes.some((note) => note.path === "Decisions.md")).toBe(true);
  });
});

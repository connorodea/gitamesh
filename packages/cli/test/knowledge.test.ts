import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { createFakeSink } from "./support/fake-sink.js";

describe("gitamesh knowledge", () => {
  let dir: string;
  let root: string;
  let env: NodeJS.ProcessEnv;
  const databaseNote = "# Database decision\n\nUse PostgreSQL for durable coordination.\n";
  const goalNote = "# Goal\n\nDeliver a reliable handoff between agent runtimes.\n";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-cli-knowledge-"));
    root = path.join(dir, "notes");
    await fs.mkdir(path.join(root, "Decisions"), { recursive: true });
    await fs.writeFile(path.join(root, "Decisions", "Database.md"), databaseNote);
    await fs.writeFile(path.join(root, "Goals.md"), goalNote);
    env = {
      GITAMESH_KNOWLEDGE_ROOT: root,
      GITAMESH_KNOWLEDGE_REPOSITORY_ID: "repo-knowledge-tests",
    };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function invoke(args: string[], environment: NodeJS.ProcessEnv = env) {
    const sink = createFakeSink();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("Local knowledge must not call the daemon");
    });
    const code = await runCli(["node", "gitamesh", "knowledge", ...args], {
      cwd: dir,
      env: environment,
      sink,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    return { code, sink };
  }

  it("reads real Markdown and returns its hash without a Git repository or daemon", async () => {
    const { code, sink } = await invoke(["read", "Decisions/Database.md", "--json"]);
    expect(code).toBe(0);
    expect(sink.errors).toEqual([]);
    expect(JSON.parse(sink.logs.join("\n"))).toEqual({
      path: "Decisions/Database.md",
      sha256: createHash("sha256").update(databaseNote).digest("hex"),
      bytes: Buffer.byteLength(databaseNote),
      content: databaseNote,
    });
  });

  it("prints readable note content and source identity by default", async () => {
    const { code, sink } = await invoke(["read", "Goals.md"]);
    expect(code).toBe(0);
    expect(sink.logs.join("\n")).toContain(goalNote);
    expect(sink.logs.join("\n")).toContain("sha256:");
  });

  it("passes repeated paths and explicit budgets to the knowledge packet", async () => {
    const { code, sink } = await invoke([
      "context", "--path", "Goals.md", "--path", "Decisions/Database.md",
      "--max-notes", "2", "--max-bytes", "8192", "--json",
    ]);
    expect(code).toBe(0);
    const packet = JSON.parse(sink.logs.join("\n"));
    expect(packet.repositoryId).toBe("repo-knowledge-tests");
    expect(packet.notes.map((note: { path: string }) => note.path).sort())
      .toEqual(["Decisions/Database.md", "Goals.md"]);
    expect(packet.markdown).toContain(databaseNote);
    expect(packet.markdown).toContain(goalNote);
    expect(Buffer.byteLength(packet.markdown)).toBeLessThanOrEqual(8192);
    expect(packet.truncated).toBe(false);
  });

  it("filters notes by the supplied query", async () => {
    const { code, sink } = await invoke(["context", "--query", "PostgreSQL", "--json"]);
    expect(code).toBe(0);
    const packet = JSON.parse(sink.logs.join("\n"));
    expect(packet.notes.map((note: { path: string }) => note.path))
      .toEqual(["Decisions/Database.md"]);
  });

  it("reports omitted notes and keeps human output clear about truncation", async () => {
    const jsonResult = await invoke(["context", "--max-notes", "1", "--json"]);
    expect(jsonResult.code).toBe(0);
    const packet = JSON.parse(jsonResult.sink.logs.join("\n"));
    expect(packet.notes).toHaveLength(1);
    expect(packet.truncated).toBe(true);
    expect(packet.omittedCount).toBeGreaterThan(0);

    const readableResult = await invoke(["context", "--max-notes", "1"]);
    expect(readableResult.code).toBe(0);
    expect(readableResult.sink.errors.join("\n")).toContain("truncated");
    expect(readableResult.sink.logs.join("\n")).toBe(packet.markdown);
  });

  it("requires an explicit folder and repository binding", async () => {
    for (const environment of [
      {},
      { GITAMESH_KNOWLEDGE_ROOT: root },
      { GITAMESH_KNOWLEDGE_REPOSITORY_ID: "repo-knowledge-tests" },
      { ...env, GITAMESH_KNOWLEDGE_REPOSITORY_ID: "   " },
    ]) {
      const { code, sink } = await invoke(["context", "--json"], environment);
      expect(code).not.toBe(0);
      expect(sink.logs).toEqual([]);
      expect(sink.errors.join("\n")).toContain("GITAMESH_KNOWLEDGE_REPOSITORY_ID");
    }
  });

  it("refuses a relative configured root", async () => {
    const { code, sink } = await invoke(["context"], { ...env, GITAMESH_KNOWLEDGE_ROOT: "notes" });
    expect(code).not.toBe(0);
    expect(sink.errors.join("\n")).toContain("absolute path");
  });

  it.each([" repo-test", "repo-test ", "repo\n-test", "repo\0-test", "é".repeat(129)])(
    "rejects a repository binding inconsistent with MCP configuration (%j)", async (repositoryId) => {
      const { code, sink } = await invoke(["context", "--json"], {
        ...env, GITAMESH_KNOWLEDGE_REPOSITORY_ID: repositoryId,
      });
      expect(code).not.toBe(0);
      expect(sink.logs).toEqual([]);
      expect(sink.errors.join("\n")).toContain("GITAMESH_KNOWLEDGE_REPOSITORY_ID");
    },
  );

  it("does not allow a caller to replace the configured root", async () => {
    const { code, sink } = await invoke(["context", "--root", dir]);
    expect(code).not.toBe(0);
    expect(sink.errors.join("\n")).toContain("unknown option");
  });

  it("rejects an escaped note path without returning outside content", async () => {
    await fs.writeFile(path.join(dir, "outside.md"), "private outside content");
    const { code, sink } = await invoke(["read", "../outside.md", "--json"]);
    expect(code).not.toBe(0);
    expect(sink.logs).toEqual([]);
    expect(sink.errors.join("\n")).not.toContain("private outside content");
  });

  it.each(["0", "-1", "2.5", "1abc", "NaN", "9007199254740992"])(
    "rejects invalid numeric option %s without producing a packet", async (value) => {
      const { code, sink } = await invoke(["context", "--max-notes", value, "--json"]);
      expect(code).not.toBe(0);
      expect(sink.logs).toEqual([]);
      expect(sink.errors.join("\n")).toContain("positive whole number");
    },
  );

  it.each([
    ["--max-notes", "51"],
    ["--max-bytes", "511"],
    ["--max-bytes", "65537"],
  ])("surfaces workspace bounds for %s=%s", async (option, value) => {
    const { code, sink } = await invoke(["context", option, value, "--json"]);
    expect(code).not.toBe(0);
    expect(sink.logs).toEqual([]);
    expect(sink.errors.length).toBeGreaterThan(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { KNOWLEDGE_LIMITS, KnowledgeError, LocalKnowledgeWorkspace, type HandoffMemory } from "../src/index.js";

let root: string;
let outside: string;
let workspace: LocalKnowledgeWorkspace;
const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const memory: HandoffMemory = {
  id: 42,
  kind: "next",
  text: "Review the PostgreSQL migration with the current architecture notes.",
  evidence: ["Architecture.md", "gitamesh:task:task_1"],
  supersedes: 39,
  provenance: { agent_id: "claude-1", session_id: "session-1", recorded_at_unix_ms: 1_798_000_000_000 },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gitamesh-knowledge-"));
  outside = await mkdtemp(join(tmpdir(), "gitamesh-outside-"));
  workspace = new LocalKnowledgeWorkspace({ root, repositoryId: "repo_juricratic" });
});
afterEach(async () => { await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); });

describe("local source reads", () => {
  it("reads exact UTF-8 bytes, including a BOM, and hashes the original file", async () => {
    const content = "\uFEFF# Architecture\nPostgreSQL 🦉 — authoritative state.\n";
    await writeFile(join(root, "Architecture.md"), content);
    expect(await workspace.read("Architecture.md")).toEqual({ path: "Architecture.md", content,
      bytes: Buffer.byteLength(content), sha256: digest(content) });
  });

  it.each(["../outside.md", "/etc/passwd", "C:/secrets.md", "C:secrets.md", "Notes\\secret.md", "Notes/../secret.md",
    "./note.md", ".hidden.md", "Notes/.private/secret.md", "Notes//note.md", "bad\npath.md", "bad\u007fpath.md", "picture.png"])(
    "rejects unsafe or non-Markdown path %j", async (path) => {
      await expect(workspace.read(path)).rejects.toMatchObject({ code: "invalid-path" });
    });

  it("rejects leaf and ancestor symlinks without reading their contents", async () => {
    await writeFile(join(outside, "secret.md"), "never expose");
    await symlink(join(outside, "secret.md"), join(root, "linked.md"));
    await symlink(outside, join(root, "Linked"));
    await expect(workspace.read("linked.md")).rejects.toMatchObject({ code: "unsafe-path" });
    await expect(workspace.read("Linked/secret.md")).rejects.toMatchObject({ code: "unsafe-path" });
    const context = await workspace.context();
    expect(context.notes).toEqual([]);
    expect(context.markdown).not.toContain("never expose");
  });

  it("rejects a symlink root and directories disguised as notes", async () => {
    await symlink(outside, join(root, "Linked"));
    const linked = new LocalKnowledgeWorkspace({ root: join(root, "Linked"), repositoryId: "repo" });
    await expect(linked.read("secret.md")).rejects.toMatchObject({ code: "unsafe-path" });
    await mkdir(join(root, "directory.md"));
    await expect(workspace.read("directory.md")).rejects.toMatchObject({ code: "unsafe-path" });
  });

  it("rejects non-UTF-8, NUL, and oversized notes", async () => {
    await writeFile(join(root, "invalid.md"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(root, "nul.md"), "a\0b");
    await writeFile(join(root, "large.md"), "x".repeat(KNOWLEDGE_LIMITS.maxNoteBytes + 1));
    await expect(workspace.read("invalid.md")).rejects.toMatchObject({ code: "invalid-content" });
    await expect(workspace.read("nul.md")).rejects.toMatchObject({ code: "invalid-content" });
    await expect(workspace.read("large.md")).rejects.toMatchObject({ code: "note-too-large" });
  });

  it("sanitizes errors and validates configuration", async () => {
    expect(() => new LocalKnowledgeWorkspace({ root: "relative", repositoryId: "r" })).toThrow(KnowledgeError);
    expect(() => new LocalKnowledgeWorkspace({ root, repositoryId: "\nprivate" })).toThrow(KnowledgeError);
    try { await workspace.read("missing.md"); expect.unreachable(); }
    catch (error) {
      expect(error).toBeInstanceOf(KnowledgeError);
      expect((error as KnowledgeError).code).toBe("not-found");
      expect((error as Error).message).not.toContain(root);
      expect((error as Error).message).not.toContain("ENOENT");
    }
  });
});

describe("bounded source context", () => {
  it("orders notes deterministically, searches content and paths, and ignores hidden files", async () => {
    await mkdir(join(root, "Plans"));
    await mkdir(join(root, ".obsidian"));
    await writeFile(join(root, "Plans", "z.md"), "PostgreSQL plan");
    await writeFile(join(root, "a.md"), "An architecture note");
    await writeFile(join(root, ".private.md"), "do not include");
    await writeFile(join(root, ".obsidian", "private.md"), "do not include");
    await writeFile(join(root, "image.png"), "not a note");
    const all = await workspace.context();
    expect(all.notes.map((note) => note.path)).toEqual(["Plans/z.md", "a.md"]);
    expect(all.truncated).toBe(false);
    expect(all.markdown).not.toContain("do not include");
    expect((await workspace.context({ query: "POSTGRESQL" })).notes.map((note) => note.path)).toEqual(["Plans/z.md"]);
    expect((await workspace.context({ query: "Plans/" })).notes.map((note) => note.path)).toEqual(["Plans/z.md"]);
    expect(await workspace.context()).toEqual(all);
  });

  it("bounds UTF-8 context including metadata and includes only complete notes", async () => {
    await writeFile(join(root, "a.md"), "🦉".repeat(400));
    await writeFile(join(root, "b.md"), "small note");
    const context = await workspace.context({ maxBytes: 1_024 });
    expect(Buffer.byteLength(context.markdown, "utf8")).toBeLessThanOrEqual(1_024);
    expect(context.notes.map((note) => note.path)).toEqual(["b.md"]);
    expect(context.notes[0]?.content).toBe("small note");
    expect(context.omittedCount).toBe(1);
    expect(context.truncated).toBe(true);
    const minimum = await workspace.context({ maxBytes: 512 });
    expect(Buffer.byteLength(minimum.markdown, "utf8")).toBeLessThanOrEqual(512);
    await expect(workspace.context({ maxBytes: 511 })).rejects.toMatchObject({ code: "invalid-options" });
    await expect(workspace.context({ maxBytes: 65_537 })).rejects.toMatchObject({ code: "invalid-options" });
    await expect(workspace.context({ maxNotes: 51 })).rejects.toMatchObject({ code: "invalid-options" });
  });

  it("rejects a metadata budget too small for a long repository ID", async () => {
    const longId = new LocalKnowledgeWorkspace({ root, repositoryId: "r".repeat(1_000) });
    await expect(longId.context({ maxBytes: 512 })).rejects.toMatchObject({ code: "invalid-options" });
  });

  it("reports note limits, unreadable candidates, and explicit-path errors truthfully", async () => {
    await writeFile(join(root, "a.md"), "alpha");
    await writeFile(join(root, "b.md"), "beta");
    await writeFile(join(root, "c.md"), Buffer.from([0xff]));
    const context = await workspace.context({ maxNotes: 1 });
    expect(context.notes.map((note) => note.path)).toEqual(["a.md"]);
    expect(context.omittedCount).toBe(2);
    expect(context.truncated).toBe(true);
    await expect(workspace.context({ paths: ["missing.md"] })).rejects.toMatchObject({ code: "not-found" });
    expect((await workspace.context({ paths: ["b.md", "b.md"] })).notes).toHaveLength(1);
  });

  it("limits discovery without an arbitrary partial folder and still permits explicit selection", async () => {
    for (let start = 0; start < 2_005; start += 100) {
      await Promise.all(Array.from({ length: Math.min(100, 2_005 - start) }, (_, offset) =>
        writeFile(join(root, `${String(start + offset).padStart(4, "0")}.md`), "note")));
    }
    const first = await workspace.context();
    const second = await workspace.context();
    expect(first).toEqual(second);
    expect(first.scannedCount).toBe(2_000);
    expect(first.omittedCount).toBe(2_000);
    expect(first.truncated).toBe(true);
    expect(first.notes).toEqual([]);
    expect(first.markdown).toContain("Discovery incomplete: yes");
    expect((await workspace.context({ paths: ["2004.md"] })).notes[0]?.path).toBe("2004.md");
  });

  it("preserves embedded fences in source text without corrupting the context boundary", async () => {
    const content = "```md\n# nested\n```\n````\n";
    await writeFile(join(root, "fences.md"), content);
    const context = await workspace.context();
    expect(context.markdown).toContain("`````markdown\n");
    expect(context.notes[0]?.content).toBe(content);
  });
});

describe("source freshness", () => {
  it("verifies hashes and refuses changed or missing source files", async () => {
    await writeFile(join(root, "Architecture.md"), "PostgreSQL");
    const original = await workspace.read("Architecture.md");
    await expect(workspace.verifySources([original])).resolves.toBeUndefined();
    await writeFile(join(root, "Architecture.md"), "PostgreSQL plus revised migrations");
    await expect(workspace.verifySources([original])).rejects.toMatchObject({ code: "stale-source" });
    await unlink(join(root, "Architecture.md"));
    await expect(workspace.verifySources([original])).rejects.toMatchObject({ code: "stale-source" });
  });

  it("rejects malformed hashes and traversal rather than treating them as sources", async () => {
    await expect(workspace.verifySources([{ path: "a.md", sha256: "oops" }])).rejects.toMatchObject({ code: "invalid-options" });
    await expect(workspace.verifySources([{ path: "../a.md", sha256: "a".repeat(64) }])).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("invalidates a source replaced by a symlink even when the target bytes match", async () => {
    await writeFile(join(root, "source.md"), "source");
    const original = await workspace.read("source.md");
    await writeFile(join(outside, "source.md"), "source");
    await unlink(join(root, "source.md"));
    await symlink(join(outside, "source.md"), join(root, "source.md"));
    await expect(workspace.verifySources([original])).rejects.toMatchObject({ code: "stale-source" });
  });
});

describe("immutable LoopMem projections", () => {
  it("shares one immutable handoff across independent instances and concurrent retries", async () => {
    const second = new LocalKnowledgeWorkspace({ root, repositoryId: "repo_juricratic" });
    const results = await Promise.all([workspace.exportHandoff(memory), second.exportHandoff(memory)]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]?.path).toBe(`Handoffs/${digest("repo_juricratic")}-42.md`);
    expect(results[0]?.sha256).toBe(results[1]?.sha256);
    const note = await second.read(results[0]!.path);
    expect(note.sha256).toBe(results[0]?.sha256);
    expect(note.content).toContain("Historical generated projection");
    expect(note.content).toContain("Agent reports are unverified");
    expect(note.content).toContain("claude-1");
    expect(note.content).toContain("gitamesh_supersedes: 39");
    expect(await readdir(join(root, "Handoffs"))).toEqual([results[0]!.path.split("/")[1]]);
  });

  it("excludes historical handoffs from discovery but supports explicit reads and context", async () => {
    const result = await workspace.exportHandoff(memory);
    await writeFile(join(root, "Current.md"), "Current user-authored decision");
    expect((await workspace.context()).notes.map((note) => note.path)).toEqual(["Current.md"]);
    expect((await workspace.context({ query: "migration" })).notes).toEqual([]);
    const explicit = await workspace.context({ paths: [result.path] });
    expect(explicit.notes[0]?.path).toBe(result.path);
    expect(explicit.markdown).toContain("LoopMem is authoritative for current state and supersession");
  });

  it("reserves the handoff directory regardless of casing for case-insensitive filesystems", async () => {
    await mkdir(join(root, "handoffs"));
    await writeFile(join(root, "handoffs", "historical.md"), "An old report");
    expect((await workspace.context()).notes).toEqual([]);
    expect((await workspace.read("handoffs/historical.md")).content).toBe("An old report");
  });

  it("rejects changed content at the same record path and preserves the original bytes", async () => {
    const first = await workspace.exportHandoff(memory);
    const before = await readFile(join(root, first.path));
    await expect(workspace.exportHandoff({ ...memory, text: "A conflicting replacement" })).rejects.toMatchObject({ code: "handoff-conflict" });
    expect(await readFile(join(root, first.path))).toEqual(before);
    expect((await workspace.exportHandoff(memory)).replayed).toBe(true);
  });

  it("keeps repository namespaces separate and supports records without provenance", async () => {
    const other = new LocalKnowledgeWorkspace({ root, repositoryId: "repo_other" });
    const first = await workspace.exportHandoff({ ...memory, provenance: null });
    const second = await other.exportHandoff(memory);
    expect(first.path).not.toBe(second.path);
    expect((await workspace.read(first.path)).content).toContain("Agent: not recorded");
  });

  it("refuses symlink destinations without writing outside the selected folder", async () => {
    await symlink(outside, join(root, "Handoffs"));
    await expect(workspace.exportHandoff(memory)).rejects.toMatchObject({ code: "unsafe-path" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a symlink occupying the final immutable record path", async () => {
    await mkdir(join(root, "Handoffs"));
    await writeFile(join(outside, "secret.md"), "private");
    await symlink(join(outside, "secret.md"), join(root, "Handoffs", `${digest("repo_juricratic")}-42.md`));
    await expect(workspace.exportHandoff(memory)).rejects.toMatchObject({ code: "unsafe-path" });
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("private");
  });

  it("validates records and bounds projection size before touching the filesystem", async () => {
    await expect(workspace.exportHandoff({ ...memory, id: 0 })).rejects.toMatchObject({ code: "invalid-content" });
    await expect(workspace.exportHandoff({ ...memory, text: "x".repeat(KNOWLEDGE_LIMITS.maxNoteBytes) })).rejects.toMatchObject({ code: "note-too-large" });
    expect(await readdir(root)).toEqual([]);
  });
});

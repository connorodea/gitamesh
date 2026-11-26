import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { createKnowledgeFetch } from "../src/knowledge-fetch.js";
import type { FetchLike } from "../src/internal-client.js";

describe("explicit knowledge configuration", () => {
  const root = resolve(tmpdir(), "knowledge-config-test");
  it("leaves knowledge disabled unless a local folder and repository are supplied", async () => {
    expect((await resolveConfig(tmpdir(), {})).knowledge).toBeUndefined();
    for (const env of [
      { GITAMESH_KNOWLEDGE_ROOT: root },
      { GITAMESH_KNOWLEDGE_REPOSITORY_ID: "repo-a" },
      { GITAMESH_KNOWLEDGE_WRITABLE: "true" },
      { GITAMESH_KNOWLEDGE_ROOT: "", GITAMESH_KNOWLEDGE_REPOSITORY_ID: "repo-a" },
    ]) await expect(resolveConfig(tmpdir(), env)).rejects.toThrow("together");
  });

  it("defaults to read access and requires a literal writable opt-in", async () => {
    const env = { GITAMESH_KNOWLEDGE_ROOT: root, GITAMESH_KNOWLEDGE_REPOSITORY_ID: "repo-a" };
    expect((await resolveConfig(tmpdir(), env)).knowledge).toEqual({ root, repositoryId: "repo-a", writable: false });
    expect((await resolveConfig(tmpdir(), { ...env, GITAMESH_KNOWLEDGE_WRITABLE: "true" })).knowledge?.writable).toBe(true);
    expect((await resolveConfig(tmpdir(), { ...env, GITAMESH_KNOWLEDGE_WRITABLE: "false" })).knowledge?.writable).toBe(false);
    for (const value of ["1", "yes", "", "FALSE"]) {
      await expect(resolveConfig(tmpdir(), { ...env, GITAMESH_KNOWLEDGE_WRITABLE: value })).rejects.toThrow("true or false");
    }
  });

  it("rejects ambiguous repository bindings and relative roots", async () => {
    const env = { GITAMESH_KNOWLEDGE_ROOT: root, GITAMESH_KNOWLEDGE_REPOSITORY_ID: "repo-a" };
    await expect(resolveConfig(tmpdir(), { ...env, GITAMESH_KNOWLEDGE_ROOT: "relative" })).rejects.toThrow("absolute");
    for (const repositoryId of [" repo-a", "repo-a ", "repo\n-a", "repo\0-a", "é".repeat(129)]) {
      await expect(resolveConfig(tmpdir(), { ...env, GITAMESH_KNOWLEDGE_REPOSITORY_ID: repositoryId })).rejects.toThrow("repository".toUpperCase());
    }
  });
});

describe("bounded coordination transport for context", () => {
  it("preserves response status, headers and a successful JSON body", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const stub: FetchLike = async (_input, init) => {
      seenSignal = init?.signal;
      return new Response('{"tasks":[]}', { status: 200, headers: { "content-type": "application/json" } });
    };
    const response = await createKnowledgeFetch(stub, 1000, 100)("http://localhost/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ tasks: [] });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("rejects oversized streamed bodies even without a content-length header", async () => {
    const stub: FetchLike = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("é".repeat(30))); controller.close(); },
    }));
    await expect(createKnowledgeFetch(stub, 1000, 50)("http://localhost/")).rejects.toThrow("exceeded");
  });

  it("times out a real HTTP response stalled after headers", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"tasks":[');
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    try {
      await expect(createKnowledgeFetch(fetch, 80, 1024)(`http://127.0.0.1:${address.port}/`)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    }
  });
});

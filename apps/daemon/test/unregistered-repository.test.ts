/**
 * Writes that name a repository id the daemon never registered. Until this
 * check existed, agents tagged hundreds of messages with an unregistered id
 * for days and nothing told them. Default policy `warn` keeps the write (so
 * live agents and existing rows keep working) and returns `warnings`;
 * `refuse` answers 404 and stores nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { buildServer, type BuiltServer } from "../src/server.js";
import { mintToken, SCOPES } from "../src/auth.js";
import { parseUnregisteredRepositoryPolicy, type UnregisteredRepositoryPolicy } from "../src/collab.js";

let storage: SqliteStorageAdapter | undefined;
let built: BuiltServer | undefined;
let headers: Record<string, string>;
let agentId: string;

async function start(policy?: UnregisteredRepositoryPolicy): Promise<void> {
  const store = createInMemorySqliteStorage();
  const server = buildServer({ storage: store, logger: false, ...(policy ? { unregisteredRepository: policy } : {}) });
  storage = store;
  built = server;
  headers = { authorization: `Bearer ${mintToken(store, [...SCOPES]).rawToken}` };
  const registered = await server.app.inject({
    method: "POST",
    url: "/v1/repositories",
    headers,
    payload: {
      display_name: "known",
      git_common_dir: "/srv/known/.git",
      default_branch: "main",
      metadata: { local_repository_id: "repo-known" },
    },
  });
  expect(registered.statusCode).toBe(201);
  const agent = await server.app.inject({
    method: "POST",
    url: "/v1/agents",
    headers,
    payload: { display_name: "a", runtime: "custom" },
  });
  agentId = agent.json().agent.agent_id;
}

afterEach(async () => {
  await built?.app.close();
  storage?.close();
  built = undefined;
  storage = undefined;
});

const post = (url: string, payload: Record<string, unknown>) =>
  built!.app.inject({ method: "POST", url, headers, payload });

const createTask = (repository_id: string) => post("/v1/tasks", { repository_id, title: "t" });
const sendMessage = (repository_id: string | null) =>
  post("/v1/messages", { from: agentId, to: "all", body: "hi", repository_id });
const acquireLock = (repository_id: string) =>
  post("/v1/locks", { agent_id: agentId, repository_id, paths: ["src"] });

describe("default policy (warn)", () => {
  it("stores a task, message and lock naming an unregistered id, and returns a warning on each", async () => {
    await start();
    for (const res of [await createTask("repo-typo"), await sendMessage("repo-typo"), await acquireLock("repo-typo")]) {
      expect(res.statusCode).toBe(201);
      expect(res.json().warnings).toEqual([
        {
          code: "repository-not-registered",
          repository_id: "repo-typo",
          detail: expect.stringContaining("gitamesh repo register"),
        },
      ]);
    }
    expect(storage!.listTasks({ repositoryId: "repo-typo" })).toHaveLength(1);
    expect(storage!.listMessages({ repositoryId: "repo-typo" })).toHaveLength(1);
    expect(storage!.listUnreleasedPathLocks("repo-typo")).toHaveLength(1);
  });

  it("omits warnings for a registered id and for a message with no repository", async () => {
    await start();
    for (const res of [await createTask("repo-known"), await sendMessage("repo-known"), await sendMessage(null), await acquireLock("repo-known")]) {
      expect(res.statusCode).toBe(201);
      expect(res.json()).not.toHaveProperty("warnings");
    }
  });

  it("warns on an idempotent task replay as well, without a second row", async () => {
    await start();
    const send = () =>
      built!.app.inject({
        method: "POST",
        url: "/v1/tasks",
        headers: { ...headers, "idempotency-key": "k1" },
        payload: { repository_id: "repo-typo", title: "t" },
      });
    const first = await send();
    const second = await send();
    expect(second.json().replayed).toBe(true);
    expect(second.json().task.task_id).toBe(first.json().task.task_id);
    expect(second.json().warnings).toHaveLength(1);
    expect(storage!.listTasks({ repositoryId: "repo-typo" })).toHaveLength(1);
  });
});

describe("refuse policy", () => {
  it("answers 404 repository-not-registered and stores nothing for each write", async () => {
    await start("refuse");
    for (const res of [await createTask("repo-typo"), await sendMessage("repo-typo"), await acquireLock("repo-typo")]) {
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.json()).toMatchObject({
        type: "https://gitamesh.dev/problems/repository-not-registered",
        status: 404,
        detail: expect.stringContaining("gitamesh repo register"),
      });
    }
    expect(storage!.listTasks({ repositoryId: "repo-typo" })).toHaveLength(0);
    expect(storage!.listMessages({ repositoryId: "repo-typo" })).toHaveLength(0);
    expect(storage!.listUnreleasedPathLocks("repo-typo")).toHaveLength(0);
  });

  it("still accepts a registered id and a message with no repository", async () => {
    await start("refuse");
    expect((await createTask("repo-known")).statusCode).toBe(201);
    expect((await sendMessage("repo-known")).statusCode).toBe(201);
    expect((await sendMessage(null)).statusCode).toBe(201);
    expect((await acquireLock("repo-known")).statusCode).toBe(201);
  });
});

describe("parseUnregisteredRepositoryPolicy", () => {
  it("defaults to warn and accepts warn/refuse in any case", () => {
    expect(parseUnregisteredRepositoryPolicy(undefined)).toBe("warn");
    expect(parseUnregisteredRepositoryPolicy("")).toBe("warn");
    expect(parseUnregisteredRepositoryPolicy(" WARN ")).toBe("warn");
    expect(parseUnregisteredRepositoryPolicy("Refuse")).toBe("refuse");
  });

  it("throws on an unknown value rather than silently picking one", () => {
    expect(() => parseUnregisteredRepositoryPolicy("strict")).toThrow(/GITAMESH_UNREGISTERED_REPOSITORY/);
  });
});


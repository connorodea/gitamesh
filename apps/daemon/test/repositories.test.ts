import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { buildServer, type BuiltServer } from "../src/server.js";
import { mintToken, type Scope } from "../src/auth.js";

let storage: SqliteStorageAdapter;
let built: BuiltServer;

beforeEach(() => {
  storage = createInMemorySqliteStorage();
  built = buildServer({ storage, logger: false });
});

afterEach(async () => {
  await built.app.close();
  storage.close();
});

function auth(scopes: Scope[]) {
  return { authorization: `Bearer ${mintToken(storage, scopes).rawToken}` };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  display_name: "gitamesh",
  git_common_dir: "/srv/git/gitamesh/.git",
  default_branch: "main",
  metadata: { local_repository_id: "repo_local_1" },
  ...overrides,
});

function register(payload: Record<string, unknown>, scopes: Scope[] = ["repository:write"]) {
  return built.app.inject({ method: "POST", url: "/v1/repositories", headers: auth(scopes), payload });
}

function list(scopes: Scope[] = ["repository:read"]) {
  return built.app.inject({ method: "GET", url: "/v1/repositories", headers: auth(scopes) });
}

describe("POST /v1/repositories", () => {
  it("registers a repository under its local id and returns 201", async () => {
    const res = await register(body({ namespace_id: "team-a" }));

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      repository: {
        repository_id: "repo_local_1",
        namespace_id: "team-a",
        display_name: "gitamesh",
        git_common_dir: "/srv/git/gitamesh/.git",
        default_branch: "main",
        created_at: expect.any(String),
        metadata: { local_repository_id: "repo_local_1" },
      },
      replayed: false,
    });
    expect(storage.getRepository("repo_local_1")).toEqual(res.json().repository);
  });

  it("defaults namespace_id and metadata, and generates an id when no local id is sent", async () => {
    const res = await register({ display_name: "r", git_common_dir: "/a/.git", default_branch: "main" });

    expect(res.statusCode).toBe(201);
    const { repository } = res.json();
    expect(repository.namespace_id).toBe("default");
    expect(repository.metadata).toEqual({});
    expect(repository.repository_id).toMatch(/^repo_/);
  });

  it("emits one repository.registered event", async () => {
    await register(body());

    const events = storage.listAllEvents().filter((e) => e.event_type === "repository.registered");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      namespace_id: "default",
      repository_id: "repo_local_1",
      payload: { display_name: "gitamesh", default_branch: "main" },
    });
  });

  it("is idempotent on metadata.local_repository_id: the first record is returned unchanged", async () => {
    const first = await register(body());
    const second = await register(body({ display_name: "renamed", git_common_dir: "/moved/.git" }));

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ repository: first.json().repository, replayed: true });
    expect(storage.listRepositories()).toHaveLength(1);
    expect(storage.listAllEvents().filter((e) => e.event_type === "repository.registered")).toHaveLength(1);
  });

  it("is idempotent on git_common_dir when no local id is sent", async () => {
    const first = await register(body({ metadata: {} }));
    const second = await register(body({ metadata: {}, display_name: "renamed" }));

    expect(second.statusCode).toBe(200);
    expect(second.json().repository).toEqual(first.json().repository);
    expect(storage.listRepositories()).toHaveLength(1);
  });

  it("the same git_common_dir in another namespace is a separate repository", async () => {
    await register(body({ metadata: {} }));
    const other = await register(body({ metadata: {}, namespace_id: "team-b" }));

    expect(other.statusCode).toBe(201);
    expect(storage.listRepositories()).toHaveLength(2);
  });

  it("rejects a body that fails the schema with a one-line 400", async () => {
    const res = await register({ display_name: "", default_branch: "main" });

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json().type).toBe("https://gitamesh.dev/problems/invalid-request");
    expect(res.json().detail).toContain("display_name: ");
    expect(res.json().detail).toContain("git_common_dir: ");
    expect(storage.listRepositories()).toEqual([]);
  });

  it("403s without repository:write", async () => {
    const res = await register(body(), ["repository:read"]);
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /v1/repositories", () => {
  it("lists registered repositories", async () => {
    const a = await register(body());
    const b = await register(body({ git_common_dir: "/b/.git", metadata: { local_repository_id: "repo_local_2" } }));

    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json().repositories).toHaveLength(2);
    expect(res.json().repositories).toEqual(
      expect.arrayContaining([a.json().repository, b.json().repository]),
    );
  });

  it("returns an empty list when nothing is registered", async () => {
    expect((await list()).json()).toEqual({ repositories: [] });
  });

  it("403s without repository:read", async () => {
    expect((await list(["events:read"])).statusCode).toBe(403);
  });
});

describe("no delete route", () => {
  it("DELETE /v1/repositories/:id is not routed", async () => {
    await register(body());
    const res = await built.app.inject({
      method: "DELETE",
      url: "/v1/repositories/repo_local_1",
      headers: auth(["admin"]),
    });
    expect(res.statusCode).toBe(404);
    expect(storage.listRepositories()).toHaveLength(1);
  });
});

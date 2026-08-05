import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { configFilePath } from "../src/config.js";
import { createFakeFetch } from "./support/fake-fetch.js";
import { createFakeSink } from "./support/fake-sink.js";

async function createTempGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-cli-repo-"));
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), "hi\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("gitamesh init", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-cli-init-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes .gitamesh/config.yaml and exits 0", async () => {
    const sink = createFakeSink();
    const code = await runCli(["node", "gitamesh", "init"], { cwd: dir, env: {}, sink });
    expect(code).toBe(0);
    const contents = await fs.readFile(configFilePath(dir), "utf8");
    expect(contents).toContain("daemonUrl:");
    expect(contents).not.toMatch(/^token:/m);
  });

  it("refuses to overwrite an existing config without --force", async () => {
    const sink = createFakeSink();
    await runCli(["node", "gitamesh", "init"], { cwd: dir, env: {}, sink });
    const code = await runCli(["node", "gitamesh", "init"], { cwd: dir, env: {}, sink });
    expect(code).not.toBe(0);
    expect(sink.errors.join("\n")).toMatch(/already exists/);
  });

  it("overwrites with --force", async () => {
    const sink = createFakeSink();
    await runCli(["node", "gitamesh", "init", "--daemon-url", "http://a:1"], {
      cwd: dir,
      env: {},
      sink,
    });
    const code = await runCli(
      ["node", "gitamesh", "init", "--daemon-url", "http://b:2", "--force"],
      { cwd: dir, env: {}, sink },
    );
    expect(code).toBe(0);
    const contents = await fs.readFile(configFilePath(dir), "utf8");
    expect(contents).toContain("http://b:2");
  });
});

describe("gitamesh doctor", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempGitRepo();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fails with a nonzero exit code when the daemon is unreachable and no token is set", async () => {
    const sink = createFakeSink();
    const { fetchImpl } = createFakeFetch({}); // no routes registered -> any call throws
    const code = await runCli(["node", "gitamesh", "doctor"], {
      cwd: dir,
      env: {},
      sink,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(code).not.toBe(0);
    const output = sink.logs.join("\n");
    expect(output).toMatch(/\[PASS\] git repository/);
    expect(output).toMatch(/\[FAIL\] daemon reachable/);
    expect(output).toMatch(/\[FAIL\] token configured/);
    void fetchImpl;
  });

  it("passes every check when the daemon is reachable and the token is valid", async () => {
    const sink = createFakeSink();
    const { fetchImpl } = createFakeFetch({
      "GET /healthz": { body: { status: "ok" } },
      "GET /v1/agents": { body: { agents: [] } },
    });
    const code = await runCli(["node", "gitamesh", "doctor"], {
      cwd: dir,
      env: { GITAMESH_TOKEN: "gm_test_token" },
      sink,
      fetchImpl,
    });
    expect(code).toBe(0);
    const output = sink.logs.join("\n");
    expect(output).toMatch(/\[PASS\] daemon reachable/);
    expect(output).toMatch(/\[PASS\] token configured/);
    expect(output).toMatch(/\[PASS\] token valid/);
    expect(output).not.toContain("gm_test_token");
    expect(output).toMatch(/token=\*+oken/);
  });

  it("supports --json output", async () => {
    const sink = createFakeSink();
    const { fetchImpl } = createFakeFetch({
      "GET /healthz": { body: { status: "ok" } },
      "GET /v1/agents": { body: { agents: [] } },
    });
    const code = await runCli(["node", "gitamesh", "doctor", "--json"], {
      cwd: dir,
      env: { GITAMESH_TOKEN: "gm_test_token" },
      sink,
      fetchImpl,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(sink.logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});

describe("gitamesh repo status", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempGitRepo();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lists the primary worktree without needing a daemon", async () => {
    const sink = createFakeSink();
    const code = await runCli(["node", "gitamesh", "repo", "status", "--json"], {
      cwd: dir,
      env: {},
      sink,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(sink.logs.join("\n"));
    expect(parsed.worktrees).toHaveLength(1);
    expect(parsed.worktrees[0].branch).toBe("main");
    expect(parsed.repository_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("gitamesh agent", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempGitRepo();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lists agents via the client and prints a table", async () => {
    const sink = createFakeSink();
    const { fetchImpl } = createFakeFetch({
      "GET /v1/agents": {
        body: {
          agents: [
            {
              agent_id: "agent-1",
              display_name: "Claude Code",
              runtime: "claude-code",
              status: "online",
              last_heartbeat_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    const code = await runCli(["node", "gitamesh", "agent", "list"], {
      cwd: dir,
      env: { GITAMESH_TOKEN: "gm_x" },
      sink,
      fetchImpl,
    });
    expect(code).toBe(0);
    const output = sink.logs.join("\n");
    expect(output).toContain("agent-1");
    expect(output).toContain("Claude Code");
  });

  it("registers an agent and prints JSON when --json is passed", async () => {
    const sink = createFakeSink();
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/agents": {
        status: 201,
        body: { agent: { agent_id: "agent-2" }, replayed: false },
      },
    });
    const code = await runCli(
      [
        "node",
        "gitamesh",
        "agent",
        "register",
        "--display-name",
        "Codex Worker",
        "--runtime",
        "codex",
        "--json",
      ],
      { cwd: dir, env: { GITAMESH_TOKEN: "gm_x" }, sink, fetchImpl },
    );
    expect(code).toBe(0);
    expect(calls[0]?.body).toMatchObject({ display_name: "Codex Worker", runtime: "codex" });
    const parsed = JSON.parse(sink.logs.join("\n"));
    expect(parsed.agent.agent_id).toBe("agent-2");
  });

  it("propagates a clear error and nonzero exit code when the daemon 404s", async () => {
    const sink = createFakeSink();
    const { fetchImpl } = createFakeFetch({}); // GET /v1/agents unregistered -> throws "no route"
    const code = await runCli(["node", "gitamesh", "agent", "list"], {
      cwd: dir,
      env: { GITAMESH_TOKEN: "gm_x" },
      sink,
      fetchImpl,
    });
    expect(code).not.toBe(0);
    expect(sink.errors.join("\n")).toMatch(/Error:/);
  });
});

describe("gitamesh task", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempGitRepo();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates a task with the parsed CLI options mapped onto the request body", async () => {
    const sink = createFakeSink();
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks": { status: 201, body: { task: { task_id: "task-1" } } },
    });
    const code = await runCli(
      [
        "node",
        "gitamesh",
        "task",
        "create",
        "--workflow-id",
        "wf-1",
        "--repository-id",
        "repo-1",
        "--title",
        "Implement feature",
        "--priority",
        "5",
        "--required-capability",
        "typescript",
        "--required-capability",
        "testing",
        "--json",
      ],
      { cwd: dir, env: { GITAMESH_TOKEN: "gm_x" }, sink, fetchImpl },
    );
    expect(code).toBe(0);
    expect(calls[0]?.body).toMatchObject({
      workflow_id: "wf-1",
      repository_id: "repo-1",
      title: "Implement feature",
      priority: 5,
      required_capabilities: ["typescript", "testing"],
    });
  });

  it("lists tasks with repository_id/status filters as query params", async () => {
    const sink = createFakeSink();
    const { fetchImpl, calls } = createFakeFetch({
      "GET /v1/tasks": { body: { tasks: [] } },
    });
    const code = await runCli(
      ["node", "gitamesh", "task", "list", "--repository-id", "repo-1", "--status", "pending"],
      { cwd: dir, env: { GITAMESH_TOKEN: "gm_x" }, sink, fetchImpl },
    );
    expect(code).toBe(0);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("repository_id")).toBe("repo-1");
    expect(url.searchParams.get("status")).toBe("pending");
  });

  it("claims a task, mapping --agent-id/--workspace-session-id onto the request body", async () => {
    const sink = createFakeSink();
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task-1/claim": { body: { attempt: { attempt_id: "attempt-1" } } },
    });
    const code = await runCli(
      [
        "node",
        "gitamesh",
        "task",
        "claim",
        "task-1",
        "--agent-id",
        "agent-1",
        "--workspace-session-id",
        "ws-1",
      ],
      { cwd: dir, env: { GITAMESH_TOKEN: "gm_x" }, sink, fetchImpl },
    );
    expect(code).toBe(0);
    expect(calls[0]?.body).toEqual({ agent_id: "agent-1", workspace_session_id: "ws-1" });
  });
});

describe("gitamesh lock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempGitRepo();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lists claims", async () => {
    const sink = createFakeSink();
    const { fetchImpl } = createFakeFetch({
      "GET /v1/claims": {
        body: {
          claims: [
            {
              resource_claim_id: "claim-1",
              resource_type: "path",
              resource_key: "src/file.ts",
              mode: "write",
              task_id: "task-1",
              expires_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    const code = await runCli(["node", "gitamesh", "lock", "list"], {
      cwd: dir,
      env: { GITAMESH_TOKEN: "gm_x" },
      sink,
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(sink.logs.join("\n")).toContain("claim-1");
  });

  it("releases a claim", async () => {
    const sink = createFakeSink();
    const { fetchImpl } = createFakeFetch({
      "POST /v1/claims/claim-1/release": { body: { released: true } },
    });
    const code = await runCli(["node", "gitamesh", "lock", "release", "claim-1"], {
      cwd: dir,
      env: { GITAMESH_TOKEN: "gm_x" },
      sink,
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(sink.logs.join("\n")).toContain("released");
  });
});

describe("gitamesh status", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempGitRepo();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("combines doctor checks with tasks/claims when the daemon is reachable", async () => {
    const sink = createFakeSink();
    const { fetchImpl } = createFakeFetch({
      "GET /healthz": { body: { status: "ok" } },
      "GET /v1/agents": { body: { agents: [] } },
      "GET /v1/tasks": { body: { tasks: [{ task_id: "t-1", title: "x", status: "pending" }] } },
      "GET /v1/claims": { body: { claims: [] } },
    });
    const code = await runCli(["node", "gitamesh", "status"], {
      cwd: dir,
      env: { GITAMESH_TOKEN: "gm_x" },
      sink,
      fetchImpl,
    });
    expect(code).toBe(0);
    const output = sink.logs.join("\n");
    expect(output).toContain("== doctor ==");
    expect(output).toContain("t-1");
  });

  it("still reports doctor failures gracefully when the daemon is unreachable", async () => {
    const sink = createFakeSink();
    const code = await runCli(["node", "gitamesh", "status"], {
      cwd: dir,
      env: {},
      sink,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(code).toBe(0); // status itself does not fail the process; it reports.
    expect(sink.logs.join("\n")).toMatch(/\[FAIL\] daemon reachable/);
  });
});

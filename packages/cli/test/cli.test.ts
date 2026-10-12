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

  it("lists tasks with repositoryId/status filters as query params", async () => {
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
    expect(url.searchParams.get("repositoryId")).toBe("repo-1");
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
    // camelCase: the daemon's ClaimBody schema rejects agent_id/workspace_session_id.
    expect(calls[0]?.body).toEqual({
      agentId: "agent-1",
      workspaceSessionId: "ws-1",
      requiredResources: [],
    });
  });

  it("maps repeatable --resource onto requiredResources, keeping colons in the key", async () => {
    const sink = createFakeSink();
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task-1/claim": {
        body: { attempt: { attempt_id: "attempt-1" }, fencingToken: 7 },
      },
    });
    const code = await runCli(
      [
        "node", "gitamesh", "task", "claim", "task-1",
        "--agent-id", "agent-1",
        "--workspace-session-id", "ws-1",
        "--resource", "path:write:src/app.ts",
        "--resource", "custom:exclusive:db:migrations",
      ],
      { cwd: dir, env: { GITAMESH_TOKEN: "gm_x" }, sink, fetchImpl },
    );
    expect(code).toBe(0);
    expect((calls[0]?.body as { requiredResources: unknown }).requiredResources).toEqual([
      { resourceType: "path", mode: "write", resourceKey: "src/app.ts" },
      { resourceType: "custom", mode: "exclusive", resourceKey: "db:migrations" },
    ]);
    expect(sink.logs.join("\n")).toContain("attempt_id=attempt-1 fencing_token=7");
  });

  it("rejects a malformed --resource before calling the daemon", async () => {
    const sink = createFakeSink();
    const { fetchImpl, calls } = createFakeFetch({});
    const code = await runCli(
      [
        "node", "gitamesh", "task", "claim", "task-1",
        "--agent-id", "agent-1",
        "--workspace-session-id", "ws-1",
        "--resource", "src/app.ts",
      ],
      { cwd: dir, env: { GITAMESH_TOKEN: "gm_x" }, sink, fetchImpl },
    );
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(sink.errors[0]).toContain("--resource must look like <type>:<mode>:<key>");
  });

  it.each([
    ["heartbeat", [], { attemptId: "attempt-1", fencingToken: 7 }],
    ["complete", [], { attemptId: "attempt-1", fencingToken: 7 }],
    ["fail", ["--error", "boom"], { attemptId: "attempt-1", fencingToken: 7, error: "boom" }],
  ] as const)("task %s sends attemptId + numeric fencingToken", async (verb, extra, body) => {
    const sink = createFakeSink();
    const { fetchImpl, calls } = createFakeFetch({
      [`POST /v1/tasks/task-1/${verb}`]: { body: {} },
    });
    const code = await runCli(
      [
        "node", "gitamesh", "task", verb, "task-1",
        "--attempt-id", "attempt-1",
        "--fencing-token", "7",
        ...extra,
      ],
      { cwd: dir, env: { GITAMESH_TOKEN: "gm_x" }, sink, fetchImpl },
    );
    expect(code).toBe(0);
    expect(calls[0]?.body).toEqual(body);
  });

  it("rejects a non-integer --fencing-token before calling the daemon", async () => {
    const sink = createFakeSink();
    const { fetchImpl, calls } = createFakeFetch({});
    const code = await runCli(
      [
        "node", "gitamesh", "task", "complete", "task-1",
        "--attempt-id", "attempt-1",
        "--fencing-token", "abc",
      ],
      { cwd: dir, env: { GITAMESH_TOKEN: "gm_x" }, sink, fetchImpl },
    );
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("puts the whole failure on the first line when the daemon rejects the body", async () => {
    const sink = createFakeSink();
    const { fetchImpl } = createFakeFetch({
      "POST /v1/tasks/task-1/claim": {
        status: 400,
        body: {
          title: "Invalid request body",
          status: 400,
          // The daemon sends zod's pretty-printed (multi-line) issue array.
          detail: JSON.stringify(
            [
              { code: "invalid_type", path: ["agentId"], message: "Required" },
              { code: "invalid_type", path: ["workspaceSessionId"], message: "Required" },
            ],
            null,
            2,
          ),
        },
      },
    });
    const code = await runCli(
      [
        "node", "gitamesh", "task", "claim", "task-1",
        "--agent-id", "agent-1",
        "--workspace-session-id", "ws-1",
      ],
      { cwd: dir, env: { GITAMESH_TOKEN: "gm_x" }, sink, fetchImpl },
    );
    expect(code).toBe(1);
    expect(sink.errors).toEqual([
      "Error: POST /v1/tasks/task-1/claim failed (400): Invalid request body — agentId: Required; workspaceSessionId: Required",
    ]);
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
    const code = await runCli(["node", "gitamesh", "lock", "list", "--claims"], {
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

  it("lists active task claims with the holder's name and last heartbeat, and path locks", async () => {
    const owner = {
      agent_id: "agent_1",
      display_name: "claude-mvp-loop",
      attempt_id: "attempt_1",
      heartbeat_at: "2026-01-01T00:00:10.000Z",
      expires_at: "2026-01-01T00:00:40.000Z",
    };
    const routes = {
      "GET /healthz": { body: { status: "ok" } },
      "GET /v1/agents": { body: { agents: [] } },
      "GET /v1/tasks": {
        body: {
          tasks: [
            { task_id: "t-1", title: "held", status: "running", owner, readiness: null, blocked_by: [] },
            { task_id: "t-2", title: "free", status: "pending", owner: null, readiness: "ready", blocked_by: [] },
          ],
        },
      },
      "GET /v1/claims": { body: { claims: [] } },
      "GET /v1/locks": {
        body: {
          locks: [
            {
              lock_id: "lock_1",
              agent_id: "agent_2",
              holder_display_name: "codex-mvp-audit",
              paths: ["src/**"],
              task_id: null,
              expires_at: "2026-01-01T00:15:00.000Z",
            },
          ],
        },
      },
    } as const;

    const sink = createFakeSink();
    const { fetchImpl, calls } = createFakeFetch(routes);
    const deps = { cwd: dir, env: { GITAMESH_TOKEN: "gm_x" }, fetchImpl };
    expect(await runCli(["node", "gitamesh", "status"], { ...deps, sink })).toBe(0);

    const lines = sink.logs;
    const claimsAt = lines.indexOf("== claims ==");
    const locksAt = lines.indexOf("== path locks ==");
    const claimRows = lines.slice(claimsAt + 1, locksAt).join("\n");
    expect(claimRows).toContain("t-1");
    expect(claimRows).toContain("claude-mvp-loop");
    expect(claimRows).toContain("2026-01-01T00:00:10.000Z");
    expect(claimRows).not.toContain("t-2");
    expect(lines.slice(locksAt).join("\n")).toContain("codex-mvp-audit (agent_2)");
    // The repository filter goes out under the name the daemon reads.
    for (const path of ["/v1/tasks", "/v1/claims", "/v1/locks"]) {
      expect(calls.find((c) => new URL(c.url).pathname === path)?.url).toMatch(/\?repositoryId=/);
    }

    const jsonSink = createFakeSink();
    expect(await runCli(["node", "gitamesh", "status", "--json"], { ...deps, sink: jsonSink })).toBe(0);
    const report = JSON.parse(jsonSink.logs.join("\n"));
    expect(report.task_claims).toEqual([
      {
        task_id: "t-1",
        title: "held",
        owner: "claude-mvp-loop",
        agent_id: "agent_1",
        heartbeat: "2026-01-01T00:00:10.000Z",
        expires_at: "2026-01-01T00:00:40.000Z",
      },
    ]);
    expect(report.locks).toHaveLength(1);
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

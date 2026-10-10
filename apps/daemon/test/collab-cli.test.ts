/**
 * The real `gitamesh` CLI against a real (in-memory) daemon, for the
 * agent-collaboration commands: messages, task update/notes, dependencies,
 * owner visibility and path locks. Every request the CLI builds goes
 * through the daemon's actual zod schemas, so a camelCase/snake_case
 * mismatch between the two fails here.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { runCli } from "../../../packages/cli/src/cli.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { mintToken, SCOPES } from "../src/auth.js";

const REPO = "repo-1";

let storage: SqliteStorageAdapter;
let built: BuiltServer;
let cwd: string;
let rawToken: string;
let stdin: string;

beforeEach(async () => {
  storage = createInMemorySqliteStorage();
  built = buildServer({ storage, logger: false, rateLimitPerMinute: 10_000 });
  rawToken = mintToken(storage, [...SCOPES]).rawToken;
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-collab-cli-"));
  stdin = "";
});

afterEach(async () => {
  await built.app.close();
  storage.close();
  await fs.rm(cwd, { recursive: true, force: true });
});

/** Routes the CLI's `fetch` calls into the daemon via `app.inject`. */
const injectFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input.toString());
  const res = await built.app.inject({
    method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH",
    url: `${url.pathname}${url.search}`,
    headers: init?.headers as Record<string, string>,
    payload: init?.body as string | undefined,
  });
  return new Response(res.body, {
    status: res.statusCode,
    headers: { "content-type": String(res.headers["content-type"] ?? "") },
  });
}) as typeof fetch;

interface CliResult {
  code: number;
  logs: string[];
  errors: string[];
}

async function cli(...args: string[]): Promise<CliResult> {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await runCli(["node", "gitamesh", ...args], {
    cwd,
    env: { GITAMESH_TOKEN: rawToken },
    sink: { log: (line) => logs.push(line), error: (line) => errors.push(line) },
    fetchImpl: injectFetch,
    readStdin: async () => stdin,
  });
  return { code, logs, errors };
}

async function cliJson<T>(...args: string[]): Promise<T> {
  const result = await cli(...args, "--json");
  expect(result.errors).toEqual([]);
  expect(result.code).toBe(0);
  return JSON.parse(result.logs.join("\n")) as T;
}

/** Runs a command expected to fail and returns its first error line. */
async function cliFailure(...args: string[]): Promise<string> {
  const result = await cli(...args);
  expect(result.code).not.toBe(0);
  expect(result.errors.length).toBeGreaterThan(0);
  return result.errors[0]!;
}

async function registerAgent(name: string): Promise<string> {
  const { agent } = await cliJson<{ agent: { agent_id: string } }>(
    "agent", "register", "--display-name", name, "--runtime", "custom",
  );
  return agent.agent_id;
}

async function createTask(title: string, ...extra: string[]): Promise<string> {
  const { task } = await cliJson<{ task: { task_id: string } }>(
    "task", "create", "--workflow-id", "wf-1", "--repository-id", REPO, "--title", title, ...extra,
  );
  return task.task_id;
}

/** Claims through the HTTP route directly: the `task claim` command is another change's subject. */
async function claimTask(taskId: string, agentId: string) {
  const res = await built.app.inject({
    method: "POST",
    url: `/v1/tasks/${taskId}/claim`,
    headers: { authorization: `Bearer ${rawToken}` },
    payload: { agentId, workspaceSessionId: "ws-1" },
  });
  return res;
}

async function completeTask(taskId: string, agentId: string): Promise<void> {
  const claimed = (await claimTask(taskId, agentId)).json() as {
    attempt: { attempt_id: string };
    fencingToken: number;
  };
  const res = await built.app.inject({
    method: "POST",
    url: `/v1/tasks/${taskId}/complete`,
    headers: { authorization: `Bearer ${rawToken}` },
    payload: { attemptId: claimed.attempt.attempt_id, fencingToken: claimed.fencingToken },
  });
  expect(res.statusCode).toBe(200);
}

interface Msg {
  message_id: string;
  from: string;
  to: string;
  task_id: string | null;
  repository_id: string | null;
  body: string;
  created_at: string;
  acked_by: Array<{ agent_id: string; acked_at: string }>;
}

describe("gitamesh msg", () => {
  it("send -> list --unread -> ack -> no longer unread", async () => {
    const claude = await registerAgent("claude");
    const codex = await registerAgent("codex");
    const taskId = await createTask("t");

    const { message } = await cliJson<{ message: Msg }>(
      "msg", "send", "--from", claude, "--to", codex,
      "--repository-id", REPO, "--task-id", taskId, "--body", "please review",
    );
    expect(message).toMatchObject({
      from: claude,
      to: codex,
      repository_id: REPO,
      task_id: taskId,
      body: "please review",
      acked_by: [],
    });
    expect(message.created_at).toMatch(/^\d{4}-\d\d-\d\dT/);

    const unread = await cliJson<Msg[]>("msg", "list", "--to", codex, "--unread");
    expect(unread.map((m) => m.message_id)).toEqual([message.message_id]);

    const acked = await cliJson<{ message: Msg; already_acked: boolean }>(
      "msg", "ack", message.message_id, "--agent-id", codex,
    );
    expect(acked.already_acked).toBe(false);
    expect(acked.message.acked_by.map((a) => a.agent_id)).toEqual([codex]);

    expect(await cliJson<Msg[]>("msg", "list", "--to", codex, "--unread")).toEqual([]);
    // Still listed (messages are never removed), now with the ack on it.
    const all = await cliJson<Msg[]>("msg", "list", "--to", codex);
    expect(all).toHaveLength(1);
    expect(all[0]!.acked_by).toHaveLength(1);

    const again = await cliJson<{ already_acked: boolean }>(
      "msg", "ack", message.message_id, "--agent-id", codex,
    );
    expect(again.already_acked).toBe(true);
  });

  it("a message to `all` reaches every agent, is unread per agent, and never for its sender", async () => {
    const claude = await registerAgent("claude");
    const codex = await registerAgent("codex");
    const { message } = await cliJson<{ message: Msg }>(
      "msg", "send", "--from", claude, "--to", "all", "--body", "new commands are live",
    );

    expect(await cliJson<Msg[]>("msg", "list", "--to", codex, "--unread")).toHaveLength(1);
    expect(await cliJson<Msg[]>("msg", "list", "--to", claude, "--unread")).toEqual([]);

    await cliJson("msg", "ack", message.message_id, "--agent-id", codex);
    expect(await cliJson<Msg[]>("msg", "list", "--to", codex, "--unread")).toEqual([]);
  });

  it("reads the body from @file and from stdin, keeping newlines", async () => {
    const claude = await registerAgent("claude");
    await fs.writeFile(path.join(cwd, "note.md"), "line one\nline two\n");

    const fromFile = await cliJson<{ message: Msg }>(
      "msg", "send", "--from", claude, "--to", "all", "--body", "@note.md",
    );
    expect(fromFile.message.body).toBe("line one\nline two");

    stdin = "from stdin\n";
    const fromStdin = await cliJson<{ message: Msg }>(
      "msg", "send", "--from", claude, "--to", "all", "--body", "-",
    );
    expect(fromStdin.message.body).toBe("from stdin");
  });

  it("filters by --from, --task-id, --repository-id and --since", async () => {
    const claude = await registerAgent("claude");
    const codex = await registerAgent("codex");
    const taskId = await createTask("t");
    const first = await cliJson<{ message: Msg }>(
      "msg", "send", "--from", claude, "--to", "all", "--task-id", taskId, "--body", "one",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cliJson("msg", "send", "--from", codex, "--to", "all", "--repository-id", REPO, "--body", "two");

    const bodies = async (...args: string[]) =>
      (await cliJson<Msg[]>("msg", "list", ...args)).map((m) => m.body);
    expect(await bodies()).toEqual(["one", "two"]);
    expect(await bodies("--from", codex)).toEqual(["two"]);
    expect(await bodies("--task-id", taskId)).toEqual(["one"]);
    expect(await bodies("--repository-id", REPO)).toEqual(["two"]);
    expect(await bodies("--since", first.message.created_at)).toEqual(["two"]);
  });

  it("prints readable text without --json", async () => {
    const claude = await registerAgent("claude");
    const sent = await cli("msg", "send", "--from", claude, "--to", "all", "--body", "a\nb");
    expect(sent.logs[0]).toMatch(/^Message msg_\S+ sent to all\.$/);

    const listed = await cli("msg", "list");
    expect(listed.logs[0]).toContain(`${claude} -> all`);
    expect(listed.logs[0]).toContain("acked by: nobody");
    expect(listed.logs.slice(1)).toEqual(["    a", "    b"]);
  });

  it("refuses an unknown sender or recipient, a non-recipient ack, and --unread without --to", async () => {
    const claude = await registerAgent("claude");
    const codex = await registerAgent("codex");
    const bystander = await registerAgent("bystander");

    expect(await cliFailure("msg", "send", "--from", "ghost", "--to", "all", "--body", "x")).toMatch(
      /404.*No agent exists with id ghost/,
    );
    expect(await cliFailure("msg", "send", "--from", claude, "--to", "ghost", "--body", "x")).toMatch(
      /404.*No agent exists with id ghost/,
    );
    const { message } = await cliJson<{ message: Msg }>(
      "msg", "send", "--from", claude, "--to", codex, "--body", "private",
    );
    expect(await cliFailure("msg", "ack", message.message_id, "--agent-id", bystander)).toMatch(
      /403.*cannot ack it/,
    );
    expect(await cliFailure("msg", "ack", "msg_nope", "--agent-id", codex)).toMatch(/404/);
    expect(await cliFailure("msg", "list", "--unread")).toMatch(/--unread needs --to/);
    expect(await cliFailure("msg", "send", "--from", claude, "--to", "all", "--body", "  ")).toMatch(
      /--body is empty/,
    );
  });
});

describe("messages, tasks and history have no delete route", () => {
  it.each([
    "/v1/messages/msg_1",
    "/v1/tasks/task_1",
    "/v1/tasks/task_1/notes",
    "/v1/locks/lock_1",
  ])("DELETE %s is not routed", async (url) => {
    const res = await built.app.inject({
      method: "DELETE",
      url,
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

interface TaskView {
  task_id: string;
  title: string;
  description: string;
  priority: number;
  branch: string | null;
  base_sha: string | null;
  dependencies: string[];
  status: string;
  owner: { agent_id: string; display_name: string; heartbeat_at: string } | null;
  readiness: string | null;
  blocked_by: string[];
}

interface Revision {
  revision_id: string;
  changed_by: string | null;
  changed_at: string;
  changes: Record<string, { old: unknown; new: unknown }>;
}

describe("gitamesh task update", () => {
  it("changes fields and records who, when, old -> new", async () => {
    const claude = await registerAgent("claude");
    const taskId = await createTask("old title", "--description", "stale");

    const updated = await cliJson<{ task: TaskView; revision: Revision }>(
      "task", "update", taskId,
      "--title", "new title", "--description", "fresh", "--priority", "7",
      "--branch", "feat/x", "--base-sha", "abc123", "--agent-id", claude,
    );
    expect(updated.task).toMatchObject({
      title: "new title",
      description: "fresh",
      priority: 7,
      branch: "feat/x",
      base_sha: "abc123",
    });
    expect(updated.revision.changed_by).toBe(claude);
    expect(updated.revision.changes).toEqual({
      title: { old: "old title", new: "new title" },
      description: { old: "stale", new: "fresh" },
      priority: { old: 0, new: 7 },
      branch: { old: null, new: "feat/x" },
      base_sha: { old: null, new: "abc123" },
    });

    await cliJson("task", "update", taskId, "--priority", "9");
    const shown = await cliJson<{ task: TaskView; revisions: Revision[] }>("task", "show", taskId);
    expect(shown.task.priority).toBe(9);
    expect(shown.revisions.map((r) => Object.keys(r.changes))).toEqual([
      ["title", "description", "priority", "branch", "base_sha"],
      ["priority"],
    ]);
    expect(shown.revisions[1]!.changes.priority).toEqual({ old: 7, new: 9 });
    expect(shown.revisions[1]!.changed_by).toBeNull();
  });

  it("writes no revision when nothing actually changes", async () => {
    const taskId = await createTask("same");
    const result = await cliJson<{ revision: Revision | null }>("task", "update", taskId, "--title", "same");
    expect(result.revision).toBeNull();
    expect((await cliJson<{ revisions: Revision[] }>("task", "show", taskId)).revisions).toEqual([]);
  });

  it("fails plainly with no fields, an unknown task, or an unknown agent", async () => {
    const taskId = await createTask("t");
    expect(await cliFailure("task", "update", taskId)).toMatch(/nothing to update/);
    expect(await cliFailure("task", "update", "task_nope", "--title", "x")).toMatch(/404.*task_nope/);
    expect(await cliFailure("task", "update", taskId, "--title", "x", "--agent-id", "ghost")).toMatch(
      /404.*No agent exists with id ghost/,
    );
  });
});

describe("gitamesh task note", () => {
  it("appends notes that `task show` returns oldest first", async () => {
    const claude = await registerAgent("claude");
    const taskId = await createTask("t");

    const first = await cliJson<{ note: { note_id: string; agent_id: string; body: string } }>(
      "task", "note", taskId, "--agent-id", claude, "--body", "started",
    );
    expect(first.note).toMatchObject({ agent_id: claude, body: "started" });
    await cliJson("task", "note", taskId, "--agent-id", claude, "--body", "half done");

    const shown = await cliJson<{ notes: Array<{ body: string }> }>("task", "show", taskId);
    expect(shown.notes.map((n) => n.body)).toEqual(["started", "half done"]);

    const human = await cli("task", "show", taskId);
    const text = human.logs.join("\n");
    expect(text).toContain("== notes ==");
    expect(text).toContain("    started");
    expect(text).toContain("    half done");
    expect(text).toContain("== revisions ==");
  });

  it("refuses an unknown task or agent", async () => {
    const claude = await registerAgent("claude");
    const taskId = await createTask("t");
    expect(await cliFailure("task", "note", "task_nope", "--agent-id", claude, "--body", "x")).toMatch(/404/);
    expect(await cliFailure("task", "note", taskId, "--agent-id", "ghost", "--body", "x")).toMatch(/404/);
  });
});

describe("dependencies", () => {
  it("--depends-on marks a task blocked until its dependency completes, and claim is refused meanwhile", async () => {
    const claude = await registerAgent("claude");
    const first = await createTask("first");
    const second = await createTask("second", "--depends-on", first);

    const view = async () => {
      const tasks = await cliJson<TaskView[]>("task", "list", "--repository-id", REPO);
      return Object.fromEntries(tasks.map((t) => [t.title, t]));
    };
    expect((await view()).first).toMatchObject({ readiness: "ready", blocked_by: [] });
    expect((await view()).second).toMatchObject({ readiness: "blocked", blocked_by: [first] });

    const refused = await claimTask(second, claude);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().type).toContain("task-dependencies-incomplete");
    expect(refused.json().detail).toBe(
      `Task ${second} cannot be claimed yet: it waits on ${first} (pending).`,
    );

    await completeTask(first, claude);
    expect((await view()).second).toMatchObject({ readiness: "ready", blocked_by: [] });
    expect((await claimTask(second, claude)).statusCode).toBe(200);
  });

  it("shows a ready column in the human table", async () => {
    const first = await createTask("first");
    await createTask("second", "--depends-on", first);

    const { logs } = await cli("task", "list");
    expect(logs[0]).toMatch(/task_id\s+title\s+status\s+ready\s+owner\s+heartbeat/);
    expect(logs.find((line) => line.includes("first"))).toMatch(/pending\s+ready/);
    expect(logs.find((line) => line.includes("second"))).toMatch(/pending\s+blocked/);
  });

  it("task update --depends-on replaces the list; --clear-dependencies empties it", async () => {
    const a = await createTask("a");
    const b = await createTask("b");
    const c = await createTask("c");

    const set = await cliJson<{ task: TaskView; revision: Revision }>(
      "task", "update", c, "--depends-on", a, "--depends-on", b,
    );
    expect(set.task.dependencies).toEqual([a, b]);
    expect(set.task.readiness).toBe("blocked");
    expect(set.revision.changes.dependencies).toEqual({ old: [], new: [a, b] });

    const cleared = await cliJson<{ task: TaskView }>("task", "update", c, "--clear-dependencies");
    expect(cleared.task.dependencies).toEqual([]);
    expect(cleared.task.readiness).toBe("ready");
  });

  it("refuses a missing dependency, a self-dependency and a cycle", async () => {
    const a = await createTask("a");
    const b = await createTask("b", "--depends-on", a);

    expect(
      await cliFailure(
        "task", "create", "--workflow-id", "wf-1", "--repository-id", REPO,
        "--title", "x", "--depends-on", "task_nope",
      ),
    ).toMatch(/422.*Dependency task_nope does not exist/);
    expect(await cliFailure("task", "update", a, "--depends-on", a)).toMatch(/cannot depend on itself/);
    expect(await cliFailure("task", "update", a, "--depends-on", b)).toMatch(/cycle/);
  });
});

describe("owner visibility", () => {
  it("task list shows the claiming agent's name and heartbeat; --mine and --unclaimed filter", async () => {
    const claude = await registerAgent("claude-mvp-loop");
    const codex = await registerAgent("codex-mvp-audit");
    const held = await createTask("held");
    const free = await createTask("free");
    const blocked = await createTask("blocked", "--depends-on", free);
    expect((await claimTask(held, claude)).statusCode).toBe(200);

    const all = await cliJson<TaskView[]>("task", "list");
    const heldView = all.find((t) => t.task_id === held)!;
    expect(heldView.owner).toMatchObject({ agent_id: claude, display_name: "claude-mvp-loop" });
    expect(heldView.owner!.heartbeat_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(heldView.readiness).toBeNull();
    expect(all.find((t) => t.task_id === free)!.owner).toBeNull();

    const ids = async (...args: string[]) =>
      (await cliJson<TaskView[]>("task", "list", ...args)).map((t) => t.task_id);
    expect(await ids("--mine", "--agent-id", claude)).toEqual([held]);
    expect(await ids("--mine", "--agent-id", codex)).toEqual([]);
    expect(await ids("--unclaimed")).toEqual([free, blocked]);

    const table = (await cli("task", "list")).logs;
    expect(table.find((line) => line.includes("held"))).toContain("claude-mvp-loop");

    expect(await cliFailure("task", "list", "--mine")).toMatch(/--mine needs --agent-id/);
  });
});

interface LockView {
  lock_id: string;
  agent_id: string;
  holder_display_name: string;
  paths: string[];
  task_id: string | null;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
}

describe("gitamesh lock", () => {
  it("acquire -> list shows holder and paths -> an overlapping acquire is refused and names the holder", async () => {
    const claude = await registerAgent("claude-mvp-loop");
    const codex = await registerAgent("codex-mvp-audit");
    const taskId = await createTask("t");

    const { lock } = await cliJson<{ lock: LockView }>(
      "lock", "acquire", "--agent-id", claude, "--repository-id", REPO,
      "--path", "src/api/**", "--path", "./README.md", "--task-id", taskId, "--ttl", "120",
    );
    expect(lock.paths).toEqual(["src/api/**", "README.md"]);
    expect(lock.task_id).toBe(taskId);
    expect(new Date(lock.expires_at).getTime() - new Date(lock.heartbeat_at).getTime()).toBe(120_000);

    const listed = await cliJson<LockView[]>("lock", "list", "--repository-id", REPO);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      lock_id: lock.lock_id,
      agent_id: claude,
      holder_display_name: "claude-mvp-loop",
      paths: ["src/api/**", "README.md"],
    });
    const table = (await cli("lock", "list")).logs.join("\n");
    expect(table).toContain(`claude-mvp-loop (${claude})`);
    expect(table).toContain("src/api/**, README.md");

    const refused = await cliFailure(
      "lock", "acquire", "--agent-id", codex, "--repository-id", REPO, "--path", "src/api/users.ts",
    );
    expect(refused).toMatch(/409/);
    expect(refused).toContain("claude-mvp-loop");
    expect(refused).toContain(claude);
    expect(refused).toContain(lock.lock_id);
    // All-or-nothing: the refused request left no lock behind.
    expect(await cliJson<LockView[]>("lock", "list", "--agent-id", codex)).toEqual([]);

    // Not overlapping, another repository, or the same holder: all fine.
    await cliJson("lock", "acquire", "--agent-id", codex, "--repository-id", REPO, "--path", "docs/**");
    await cliJson("lock", "acquire", "--agent-id", codex, "--repository-id", "repo-2", "--path", "src/api/**");
    await cliJson("lock", "acquire", "--agent-id", claude, "--repository-id", REPO, "--path", "src/api/users.ts");
  });

  it("release frees the paths; only the holder can release", async () => {
    const claude = await registerAgent("claude");
    const codex = await registerAgent("codex");
    const { lock } = await cliJson<{ lock: LockView }>(
      "lock", "acquire", "--agent-id", claude, "--repository-id", REPO, "--path", "src/**",
    );

    expect(await cliFailure("lock", "release", lock.lock_id, "--agent-id", codex)).toMatch(
      /403.*held by/,
    );
    expect(await cliFailure("lock", "release", lock.lock_id)).toMatch(/needs --agent-id/);

    const released = await cliJson<{ lock: LockView }>(
      "lock", "release", lock.lock_id, "--agent-id", claude,
    );
    expect(released.lock.released_at).not.toBeNull();
    expect(await cliJson<LockView[]>("lock", "list")).toEqual([]);
    await cliJson("lock", "acquire", "--agent-id", codex, "--repository-id", REPO, "--path", "src/a.ts");

    expect(await cliFailure("lock", "release", lock.lock_id, "--agent-id", claude)).toMatch(
      /409.*released/,
    );
    // Released, not removed.
    expect(storage.getPathLock(lock.lock_id)).toBeDefined();
  });

  it("a lock expires by TTL unless heartbeated", async () => {
    const claude = await registerAgent("claude");
    const codex = await registerAgent("codex");
    let now = new Date("2026-01-01T00:00:00.000Z").getTime();
    storage.now = () => new Date(now).toISOString();

    const { lock } = await cliJson<{ lock: LockView }>(
      "lock", "acquire", "--agent-id", claude, "--repository-id", REPO, "--path", "src/**", "--ttl", "60",
    );

    now += 50_000;
    const beat = await cliJson<{ lock: LockView }>("lock", "heartbeat", lock.lock_id, "--agent-id", claude);
    expect(beat.lock.expires_at).toBe("2026-01-01T00:01:50.000Z");

    // 100 s after acquire: past the first expiry, inside the renewed one.
    now += 50_000;
    expect(
      await cliFailure("lock", "acquire", "--agent-id", codex, "--repository-id", REPO, "--path", "src/a.ts"),
    ).toMatch(/409/);

    // Past the renewed expiry with no heartbeat: gone from the list, and free to take.
    now += 20_000;
    expect(await cliJson<LockView[]>("lock", "list")).toEqual([]);
    expect(await cliFailure("lock", "heartbeat", lock.lock_id, "--agent-id", claude)).toMatch(
      /409.*expired/,
    );
    await cliJson("lock", "acquire", "--agent-id", codex, "--repository-id", REPO, "--path", "src/a.ts");
    expect(storage.getPathLock(lock.lock_id)).toBeDefined();
  });

  it("refuses a bad path, a bad TTL and an unknown agent", async () => {
    const claude = await registerAgent("claude");
    const acquire = (...args: string[]) =>
      cliFailure("lock", "acquire", "--repository-id", REPO, ...args);

    expect(await acquire("--agent-id", claude, "--path", "/etc/passwd")).toMatch(/400.*relative/);
    expect(await acquire("--agent-id", claude, "--path", "../x")).toMatch(/400/);
    expect(await acquire("--agent-id", claude, "--path", "src", "--ttl", "soon")).toMatch(/--ttl must be/);
    expect(await acquire("--agent-id", "ghost", "--path", "src")).toMatch(/404/);
  });

  it("lock list --claims still lists task resource claims", async () => {
    const claude = await registerAgent("claude");
    const taskId = await createTask("t");
    const res = await built.app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${rawToken}` },
      payload: {
        agentId: claude,
        workspaceSessionId: "ws-1",
        requiredResources: [{ resourceType: "path", resourceKey: "src/app.ts", mode: "write" }],
      },
    });
    expect(res.statusCode).toBe(200);

    const claims = await cliJson<Array<{ resource_key: string }>>(
      "lock", "list", "--claims", "--repository-id", REPO,
    );
    expect(claims.map((c) => c.resource_key)).toEqual(["src/app.ts"]);
    expect(await cliJson<unknown[]>("lock", "list", "--claims", "--repository-id", "other")).toEqual([]);
  });
});

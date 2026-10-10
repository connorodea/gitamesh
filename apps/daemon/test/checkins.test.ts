import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSqliteStorage, type SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { buildServer, type BuiltServer } from "../src/server.js";
import { mintToken } from "../src/auth.js";
import { runCli } from "../../../packages/cli/src/cli.js";

let storage: SqliteStorageAdapter;
let built: BuiltServer;
let directory: string;
let headers: { authorization: string };
let sender: string;
let recipient: string;

async function post(url: string, payload: object, extraHeaders: Record<string, string> = {}) {
  return built.app.inject({ method: "POST", url, payload, headers: { ...headers, ...extraHeaders } });
}
async function task(title = "Work", repository = "repo") {
  return (await post("/v1/tasks", { repository_id: repository, title })).json().task;
}
async function claim(taskId: string) {
  return post(`/v1/tasks/${taskId}/claim`, { agentId: sender, workspaceSessionId: "session" });
}
const messageBody = () => ({ repositoryId: "repo", fromAgentId: sender, toAgentId: recipient, body: "Tests passed; ready for review." });

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "gitamesh-checkins-"));
  storage = createFileSqliteStorage(join(directory, "data.sqlite"));
  built = buildServer({ storage, logger: false });
  headers = { authorization: `Bearer ${mintToken(storage, ["admin"]).rawToken}` };
  sender = (await post("/v1/agents", { display_name: "Codex", runtime: "codex" })).json().agent.agent_id;
  recipient = (await post("/v1/agents", { display_name: "Claude", runtime: "claude-code" })).json().agent.agent_id;
});
afterEach(async () => {
  await built.app.close();
  storage.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("agent messages", () => {
  it("persists messages and acknowledgement across a fresh daemon and database connection", async () => {
    const send = await post("/v1/messages", messageBody());
    expect(send.statusCode).toBe(201);
    const message = send.json().message;
    const ack = await post(`/v1/messages/${message.event_id}/ack`, { repositoryId: "repo", agentId: recipient });
    expect(ack.statusCode).toBe(200);
    expect((await post(`/v1/messages/${message.event_id}/ack`, { repositoryId: "repo", agentId: recipient })).json().acknowledgement.event_id)
      .toBe(ack.json().acknowledgement.event_id);
    await built.app.close(); storage.close();
    storage = createFileSqliteStorage(join(directory, "data.sqlite"));
    built = buildServer({ storage, logger: false });
    const read = await built.app.inject({ url: `/v1/messages?repositoryId=repo&agentId=${sender}`, headers });
    expect(read.json().events.map((e: { event_type: string }) => e.event_type)).toEqual(["agent.message", "agent.message_acknowledged"]);
    expect(storage.listTasks()).toHaveLength(0);
  });

  it("replays one send exactly, rejects changed retries and rolls back duplicate events", async () => {
    const retry = { "idempotency-key": "send-1" };
    const a = await post("/v1/messages", messageBody(), retry);
    const b = await post("/v1/messages", messageBody(), retry);
    expect(b.json().replayed).toBe(true);
    expect(b.json().message.event_id).toBe(a.json().message.event_id);
    expect((await post("/v1/messages", { ...messageBody(), body: "changed" }, retry)).statusCode).toBe(409);
    expect(storage.listEventsForRepository("repo")).toHaveLength(1);
  });

  it("requires scope, registered agents, correct recipient and related task repository", async () => {
    expect((await built.app.inject({ method: "POST", url: "/v1/messages", payload: messageBody() })).statusCode).toBe(401);
    const readToken = mintToken(storage, ["events:read"]).rawToken;
    expect((await post("/v1/messages", messageBody(), { authorization: `Bearer ${readToken}` })).statusCode).toBe(403);
    expect((await post("/v1/messages", { ...messageBody(), toAgentId: "missing" })).statusCode).toBe(409);
    const other = await task("Other", "other");
    expect((await post("/v1/messages", { ...messageBody(), taskId: other.task_id })).statusCode).toBe(409);
    const m = (await post("/v1/messages", messageBody())).json().message;
    expect((await post(`/v1/messages/${m.event_id}/ack`, { repositoryId: "repo", agentId: sender })).statusCode).toBe(409);
  });

  it("paginates past unrelated events without losing messages or leaking other repositories", async () => {
    await task();
    const m = (await post("/v1/messages", messageBody())).json().message;
    await post("/v1/messages", { ...messageBody(), repositoryId: "other" });
    let cursor = 0;
    const messages: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = (await built.app.inject({ url: `/v1/messages?repositoryId=repo&agentId=${recipient}&since=${cursor}&limit=1`, headers })).json();
      messages.push(...r.events.map((e: { event_id: string }) => e.event_id));
      if (r.nextCursor === cursor) break;
      cursor = r.nextCursor;
    }
    expect(messages).toEqual([m.event_id]);
    expect((await built.app.inject({ url: `/v1/messages?repositoryId=repo&agentId=${recipient}&since=-1`, headers })).statusCode).toBe(400);
  });
});

describe("task progress", () => {
  it("records evidence without completing or renewing the task, reports an expired lease honestly", async () => {
    const t = await task(); const c = (await claim(t.task_id)).json();
    const body = { attemptId: c.attempt.attempt_id, fencingToken: c.fencingToken,
      summary: "Verification passed", phase: "ready_for_review", evidence: ["test:checkins", "commit:abc"] };
    expect((await post(`/v1/tasks/${t.task_id}/progress`, body)).statusCode).toBe(200);
    expect(storage.getTask(t.task_id)?.status).toBe("running");
    expect(storage.getAttempt(c.attempt.attempt_id)?.expires_at).toBe(c.attempt.expires_at);
    const now = storage.now;
    storage.now = () => "2100-01-01T00:00:00.000Z";
    const r = (await built.app.inject({ url: `/v1/tasks/${t.task_id}/progress`, headers })).json();
    expect(r.events[0].payload.evidence).toEqual(body.evidence);
    expect(r.active_attempts[0].lease_current).toBe(false);
    expect((await post(`/v1/tasks/${t.task_id}/progress`, body)).statusCode).toBe(409);
    storage.now = now;
  });

  it("rejects stale tokens and cross-task attempts without appending a report", async () => {
    const a = await task(); const b = await task(); const c = (await claim(a.task_id)).json();
    const body = { attemptId: c.attempt.attempt_id, fencingToken: c.fencingToken, phase: "working", summary: "Started" };
    expect((await post(`/v1/tasks/${b.task_id}/progress`, body)).statusCode).toBe(409);
    expect((await post(`/v1/tasks/${a.task_id}/progress`, { ...body, fencingToken: c.fencingToken + 1 })).statusCode).toBe(409);
    expect(storage.listEventsForRepository("repo").filter(e => e.event_type === "task.progress")).toHaveLength(0);
  });

  it("retries progress once and refuses new reports after completion", async () => {
    const t = await task(); const c = (await claim(t.task_id)).json();
    const body = { attemptId: c.attempt.attempt_id, fencingToken: c.fencingToken, phase: "verifying", summary: "Checking" };
    const a = await post(`/v1/tasks/${t.task_id}/progress`, body, { "idempotency-key": "progress-1" });
    const b = await post(`/v1/tasks/${t.task_id}/progress`, body, { "idempotency-key": "progress-1" });
    expect(b.json().progress.event_id).toBe(a.json().progress.event_id);
    expect(b.json().replayed).toBe(true);
    await post(`/v1/tasks/${t.task_id}/complete`, { attemptId: c.attempt.attempt_id, fencingToken: c.fencingToken });
    expect((await post(`/v1/tasks/${t.task_id}/progress`, body)).statusCode).toBe(409);
    expect(storage.listEventsForRepository("repo").filter(e => e.event_type === "task.progress")).toHaveLength(1);
  });
});

describe("dependency ordering", () => {
  it("prevents premature claims and unblocks only after the prerequisite completes", async () => {
    const a = await task(); const b = await task();
    expect((await post(`/v1/tasks/${b.task_id}/dependencies`, { dependencies: [a.task_id], expectedDependencies: [] })).statusCode).toBe(200);
    expect((await claim(b.task_id)).statusCode).toBe(409);
    expect(storage.getActiveAttemptsForTask(b.task_id)).toHaveLength(0);
    const c = (await claim(a.task_id)).json();
    expect((await post(`/v1/tasks/${a.task_id}/complete`, { attemptId: c.attempt.attempt_id, fencingToken: c.fencingToken })).statusCode).toBe(200);
    expect((await claim(b.task_id)).statusCode).toBe(200);
    expect((await post(`/v1/tasks/${b.task_id}/dependencies`, { dependencies: [], expectedDependencies: [a.task_id] })).statusCode).toBe(409);
  });

  it("rejects cycles, missing/cross-repository prerequisites and lost updates atomically", async () => {
    const a = await task(); const b = await task(); const other = await task("Other", "other");
    await post(`/v1/tasks/${b.task_id}/dependencies`, { dependencies: [a.task_id], expectedDependencies: [] });
    for (const dependency of [b.task_id, a.task_id, "missing", other.task_id]) {
      expect((await post(`/v1/tasks/${a.task_id}/dependencies`, { dependencies: [dependency], expectedDependencies: [] })).statusCode).toBe(409);
    }
    expect((await post(`/v1/tasks/${b.task_id}/dependencies`, { dependencies: [], expectedDependencies: [] })).statusCode).toBe(409);
    expect(storage.getTask(b.task_id)?.dependencies).toEqual([a.task_id]);
  });

  it("enforces any join policy and refuses unsupported quorum dependencies at claim time", async () => {
    const a = await task(); const b = await task();
    const any = (await post("/v1/tasks", { repository_id: "repo", title: "Any", dependencies: [a.task_id, b.task_id], join_policy: "any" })).json().task;
    const quorum = (await post("/v1/tasks", { repository_id: "repo", title: "Quorum", dependencies: [a.task_id], join_policy: "quorum" })).json().task;
    expect((await claim(any.task_id)).statusCode).toBe(409);
    const c = (await claim(a.task_id)).json();
    await post(`/v1/tasks/${a.task_id}/complete`, { attemptId: c.attempt.attempt_id, fencingToken: c.fencingToken });
    expect((await claim(any.task_id)).statusCode).toBe(200);
    expect((await claim(quorum.task_id)).statusCode).toBe(409);
  });
});

it("drives native message, acknowledgement, progress and dependency commands through real HTTP routes", async () => {
  const token = headers.authorization.slice(7);
  const logs: string[] = []; const errors: string[] = [];
  const deps = { cwd: directory, env: { GITAMESH_TOKEN: token },
    sink: { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const r = await built.app.inject({ method: (init?.method ?? "GET") as "GET" | "POST", url: u.pathname + u.search,
        headers: init?.headers as Record<string, string>, payload: init?.body as string | undefined });
      return new Response(r.body, { status: r.statusCode, headers: { "content-type": "application/json" } });
    }) as typeof fetch };
  const run = async (...args: string[]) => { logs.length = 0; expect(await runCli(["node", "gitamesh", ...args], deps), errors.join("\n")).toBe(0); return JSON.parse(logs.join("\n")); };
  const m = await run("message", "send", "--repository-id", "repo", "--from", sender, "--to", recipient, "--body", "check in", "--idempotency-key", "cli-1", "--json");
  expect((await run("message", "inbox", "--repository-id", "repo", "--agent-id", recipient, "--json")).events[0].event_id).toBe(m.message.event_id);
  await run("message", "ack", m.message.event_id, "--repository-id", "repo", "--agent-id", recipient);
  const a = await task(); const b = await task();
  await run("task", "dependencies", b.task_id, "--depends-on", a.task_id);
  expect((await claim(b.task_id)).statusCode).toBe(409);
  const c = (await claim(a.task_id)).json();
  await run("task", "progress", a.task_id, "--attempt-id", c.attempt.attempt_id, "--fencing-token", String(c.fencingToken), "--phase", "working", "--summary", "CLI wired", "--evidence", "test:real-routes");
  expect((await run("task", "history", a.task_id)).events[0].payload.summary).toBe("CLI wired");
});

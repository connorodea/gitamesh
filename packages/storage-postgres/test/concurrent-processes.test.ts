import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import type { Task } from "@gitamesh/protocol";
import { createPostgresStorage, type PostgresStorageAdapter } from "../src/index.js";

const url = process.env.GITAMESH_TEST_POSTGRES_URL;
const fixture = new URL("./fixtures/concurrent-worker.mjs", import.meta.url);
const adapters: PostgresStorageAdapter[] = [];
const clients: pg.Client[] = [];
const folders: string[] = [];
const processes: { child: ChildProcess; exited: Promise<void> }[] = [];

interface WorkerResult {
  type: "result";
  ok: boolean;
  attemptId?: string;
  taskId?: string;
  replayed?: boolean;
  message?: string;
  errorType?: string;
}

function sampleTask(repositoryId: string, suffix: string): Task {
  const now = new Date().toISOString();
  return {
    task_id: `${repositoryId}_${suffix}`, workflow_id: `${repositoryId}_workflow`,
    repository_id: repositoryId, parent_task_id: null, title: suffix,
    description: "Concurrent-process regression", status: "pending", priority: 0,
    required_capabilities: [], dependencies: [], join_policy: "all", base_sha: null,
    branch: null, idempotency_key: null, deadline_at: null, created_at: now, updated_at: now,
  };
}

function connect(connectionString = url!): PostgresStorageAdapter {
  const storage = createPostgresStorage(connectionString);
  adapters.push(storage);
  return storage;
}

async function observer(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
  await client.connect();
  clients.push(client);
  return client;
}

function spawnWorker(applicationName: string) {
  const child = fork(fixture, [], {
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, GITAMESH_CONCURRENCY_APP_NAME: applicationName },
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  processes.push({ child, exited });
  let snapshots = 0;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let resultResolve!: (result: WorkerResult) => void;
  let resultReject!: (error: Error) => void;
  const result = new Promise<WorkerResult>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  // A startup failure can happen while the caller is still awaiting ready.
  // Keep both promises handled; the caller still observes their rejection.
  void ready.catch(() => {});
  void result.catch(() => {});
  let reported = false;
  child.on("message", (message) => {
    const payload = message as { type: string };
    if (payload.type === "ready") readyResolve();
    else if (payload.type === "snapshot") snapshots += 1;
    else if (payload.type === "result") {
      reported = true;
      resultResolve(message as WorkerResult);
    }
  });
  child.on("error", (error) => { readyReject(error); resultReject(error); });
  child.on("exit", (code, signal) => {
    if (reported) return;
    const error = new Error(`Concurrent-process worker ended before its result (${code ?? signal})`);
    readyReject(error);
    resultReject(error);
  });
  return { child, ready, result, applicationName, snapshots: () => snapshots };
}

async function race(mode: "claim" | "idempotency", tasks: [Task, Task], key?: string): Promise<WorkerResult[]> {
  const control = await observer();
  const directory = await mkdtemp(join(tmpdir(), "gitamesh-pg-race-"));
  folders.push(directory);
  const gate = join(directory, "release");
  const run = randomUUID().replaceAll("-", "");
  const workers = [spawnWorker(`gm_race_${run}_a`), spawnWorker(`gm_race_${run}_b`)];
  await Promise.all(workers.map((worker) => worker.ready));
  workers.forEach((worker, index) => worker.child.send({ mode, task: tasks[index], key, gate }));
  try {
    await vi.waitFor(() => expect(workers.reduce((sum, worker) => sum + worker.snapshots(), 0)).toBeGreaterThan(0), { timeout: 5_000, interval: 10 });
    await vi.waitFor(async () => {
      // With the old code both processes reach the stale read. With the fix,
      // one pauses after that read and the other waits before entering its
      // transaction callback. In either case release the same barrier.
      if (workers.every((worker) => worker.snapshots() > 0)) return;
      const waiting = await control.query<{ count: string }>(
        "SELECT count(*) FROM pg_stat_activity WHERE application_name = ANY($1::text[]) AND wait_event_type = 'Lock' AND wait_event = 'advisory'",
        [workers.map((worker) => worker.applicationName)],
      );
      expect(Number(waiting.rows[0]?.count)).toBeGreaterThan(0);
    }, { timeout: 5_000, interval: 10 });
  } finally {
    // Always release readers, including when the assertion fails. The outer
    // afterEach also kills/joins processes if any operation remains blocked.
    await writeFile(gate, "continue\n");
  }
  return Promise.all(workers.map((worker) => worker.result));
}

afterEach(async () => {
  for (const { child } of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(processes.splice(0).map(({ exited }) => exited));
  for (const client of clients.splice(0)) await client.end();
  while (adapters.length) adapters.pop()!.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe.skipIf(!url)("Postgres coordination across independent processes", () => {
  it("permits only one live attempt when two processes read and claim one task", async () => {
    const storage = connect();
    const repository = `race_claim_${randomUUID()}`;
    const task = sampleTask(repository, "shared");
    storage.saveTask(task);
    const results = await race("claim", [task, task]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.errorType).toMatch(/task-(not-claimable|already-claimed)$/);
    expect(storage.getActiveAttemptsForTask(task.task_id)).toHaveLength(1);
    expect(storage.getTask(task.task_id)?.status).toBe("running");
  }, 20_000);

  it("persists one task and one receipt when two processes transact on the same idempotency key", async () => {
    const storage = connect();
    const repository = `race_receipt_${randomUUID()}`;
    const key = `${repository}_idempotency`;
    const results = await race("idempotency", [sampleTask(repository, "a"), sampleTask(repository, "b")], key);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => result.taskId)).size).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    const tasks = storage.listTasks({ repositoryId: repository });
    expect(tasks).toHaveLength(1);
    expect(storage.lookupIdempotentResult(key)).toEqual({ taskId: tasks[0]!.task_id });
    const control = await observer();
    const count = await control.query<{ count: string }>("SELECT count(*) FROM idempotency_keys WHERE idempotency_key = $1", [key]);
    expect(Number(count.rows[0]?.count)).toBe(1);
  }, 20_000);

  it("recovers server and adapter state after advisory-lock acquisition times out", async () => {
    const control = await observer();
    await control.query("SELECT pg_advisory_lock(1195988033, 1296388936)");
    try {
      const limited = new URL(url!);
      limited.searchParams.set("options", "-c lock_timeout=150ms");
      const storage = connect(limited.toString());
      const callback = vi.fn();
      expect(() => storage.transaction(callback)).toThrow(/lock timeout/i);
      expect(callback).not.toHaveBeenCalled();
      await control.query("SELECT pg_advisory_unlock(1195988033, 1296388936)");
      const key = `after_timeout_${randomUUID()}`;
      expect(() => storage.transaction(() => {
        storage.recordIdempotentResult(key, { rollback: true });
        throw new Error("rollback after failed begin");
      })).toThrow("rollback after failed begin");
      expect(storage.lookupIdempotentResult(key)).toBeUndefined();
      expect(storage.transaction(() => storage.ping())).toBe(true);
    } finally {
      await control.query("SELECT pg_advisory_unlock_all()");
    }
  }, 10_000);
});

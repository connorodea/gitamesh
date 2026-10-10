import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@gitamesh/protocol";
import { createPostgresStorage, type PostgresStorageAdapter } from "../src/index.js";

/**
 * The `pg` path against a real server. Skipped unless
 * `GITAMESH_TEST_POSTGRES_URL` points at a throwaway database (CI provides
 * one; locally, start any Postgres and export the URL). The embedded pglite
 * tests cannot cover this path: they never open a `pg.Client`.
 */
const url = process.env.GITAMESH_TEST_POSTGRES_URL;

const run = Date.now().toString(36);
let n = 0;
function task(label: string): Task {
  n += 1;
  const now = new Date().toISOString();
  return {
    task_id: `${run}_${label}_${n}`,
    workflow_id: `${run}_wf`,
    repository_id: `${run}_repo`,
    parent_task_id: null,
    title: label,
    description: "",
    status: "pending",
    priority: 0,
    required_capabilities: [],
    dependencies: [],
    join_policy: "all",
    base_sha: null,
    branch: null,
    idempotency_key: null,
    deadline_at: null,
    created_at: now,
    updated_at: now,
  };
}

const open: PostgresStorageAdapter[] = [];
function connect(): PostgresStorageAdapter {
  const storage = createPostgresStorage(url!);
  open.push(storage);
  return storage;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

describe.skipIf(!url)("PostgresStorageAdapter against a real server: one connection per adapter", () => {
  it("a rollback on one adapter does not undo a write made by another", () => {
    const a = connect();
    const b = connect();
    const inA = task("in_a");
    const inB = task("in_b");

    expect(() =>
      a.transaction(() => {
        a.saveTask(inA);
        b.saveTask(inB); // b autocommits on its own connection
        throw new Error("abort a");
      }),
    ).toThrow("abort a");

    expect(a.getTask(inA.task_id)).toBeUndefined();
    expect(a.getTask(inB.task_id)).toBeDefined();
  });

  it("closing one adapter leaves the other connected", () => {
    const a = connect();
    const b = connect();
    a.close();
    const t = task("after_close");
    b.saveTask(t);
    expect(b.getTask(t.task_id)).toBeDefined();
  });

  it("a closed adapter cannot reach another adapter's connection", () => {
    const a = connect();
    const b = connect();
    a.close();
    expect(() => a.getTask("anything")).toThrow();
    expect(b.listTasks({ repositoryId: `${run}_repo` })).toBeDefined();
  });
});

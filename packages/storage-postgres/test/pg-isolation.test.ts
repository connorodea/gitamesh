import { describe, expect, it } from "vitest";
import type { Task } from "@gitamesh/protocol";
import { createPostgresStorage } from "../src/index.js";

/**
 * Real-`pg` isolation: each adapter owns its own worker thread and its own
 * server connection. Needs a live server, so it only runs when
 * `GITAMESH_TEST_PG_URL` is set (CI provides one).
 */
const url = process.env.GITAMESH_TEST_PG_URL;

let n = 0;
function task(): Task {
  n += 1;
  const id = `iso_${process.pid}_${Date.now()}_${n}`;
  const now = new Date().toISOString();
  return {
    task_id: id,
    workflow_id: `wf_${id}`,
    repository_id: "repo_iso",
    parent_task_id: null,
    title: id,
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

describe.skipIf(!url)("PostgresStorageAdapter: two adapters in one process (real pg)", () => {
  it("closing one adapter does not end the other's connection", () => {
    const a = createPostgresStorage(url!);
    const b = createPostgresStorage(url!);
    try {
      a.close();
      const t = task();
      b.saveTask(t);
      expect(b.getTask(t.task_id)).toEqual(t);
    } finally {
      b.close();
    }
  });

  it("a rollback on one adapter does not undo writes made through the other", () => {
    const a = createPostgresStorage(url!);
    const b = createPostgresStorage(url!);
    try {
      const inA = task();
      const inB = task();
      expect(() =>
        a.transaction(() => {
          a.saveTask(inA);
          b.saveTask(inB);
          throw new Error("abort a");
        }),
      ).toThrow("abort a");
      expect(a.getTask(inA.task_id)).toBeUndefined();
      expect(a.getTask(inB.task_id)).toEqual(inB);
    } finally {
      a.close();
      b.close();
    }
  });

  it("opening a second adapter does not replace the first one's connection", () => {
    const a = createPostgresStorage(url!);
    const t = task();
    a.saveTask(t);
    const b = createPostgresStorage(url!);
    try {
      b.close();
      expect(a.getTask(t.task_id)).toEqual(t);
    } finally {
      a.close();
    }
  });
});

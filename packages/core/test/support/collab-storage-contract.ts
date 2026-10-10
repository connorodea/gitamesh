import { afterEach, describe, expect, it } from "vitest";
import type { Message, PathLock } from "@gitamesh/protocol";
import type { StorageAdapter } from "../../src/storage-adapter.js";

/**
 * Behavioral spec for the agent-collaboration part of `StorageAdapter`
 * (messages, task history, path locks, active attempts). Each concrete
 * adapter's test file calls this with its own factory, so SQLite and
 * Postgres are held to the same contract.
 */
export function runCollabStorageContract(
  adapterName: string,
  createStorage: () => StorageAdapter,
): void {
  const open: StorageAdapter[] = [];
  const fresh = (): StorageAdapter => {
    const storage = createStorage();
    open.push(storage);
    return storage;
  };
  afterEach(() => {
    while (open.length > 0) open.pop()!.close();
  });

  const message = (overrides: Partial<Message>): Message => ({
    message_id: "msg_1",
    from: "agent_a",
    to: "all",
    repository_id: null,
    task_id: null,
    body: "hello",
    created_at: "2026-01-01T00:00:00.000Z",
    acked_by: [],
    ...overrides,
  });

  describe(`${adapterName}: messages`, () => {
    it("stores a message and returns it with an empty ack list", () => {
      const storage = fresh();
      const sent = message({ repository_id: "repo_1", task_id: "task_1", body: "line 1\nline 2" });
      storage.appendMessage(sent);

      expect(storage.getMessage("msg_1")).toEqual(sent);
      expect(storage.getMessage("nope")).toBeUndefined();
    });

    it("lists in creation order and filters by repository and since", () => {
      const storage = fresh();
      storage.appendMessage(message({ message_id: "m2", created_at: "2026-01-02T00:00:00.000Z", repository_id: "repo_1" }));
      storage.appendMessage(message({ message_id: "m1", created_at: "2026-01-01T00:00:00.000Z", repository_id: "repo_2" }));
      storage.appendMessage(message({ message_id: "m3", created_at: "2026-01-03T00:00:00.000Z", repository_id: "repo_1" }));

      expect(storage.listMessages().map((m) => m.message_id)).toEqual(["m1", "m2", "m3"]);
      expect(storage.listMessages({ repositoryId: "repo_1" }).map((m) => m.message_id)).toEqual(["m2", "m3"]);
      expect(
        storage.listMessages({ since: "2026-01-02T00:00:00.000Z" }).map((m) => m.message_id),
      ).toEqual(["m3"]);
    });

    it("records one ack per agent and reports a repeat ack as false", () => {
      const storage = fresh();
      storage.appendMessage(message({}));

      expect(storage.ackMessage("msg_1", "agent_b", "2026-01-01T00:01:00.000Z")).toBe(true);
      expect(storage.ackMessage("msg_1", "agent_b", "2026-01-01T00:09:00.000Z")).toBe(false);
      expect(storage.ackMessage("msg_1", "agent_c", "2026-01-01T00:02:00.000Z")).toBe(true);

      expect(storage.getMessage("msg_1")?.acked_by).toEqual([
        { agent_id: "agent_b", acked_at: "2026-01-01T00:01:00.000Z" },
        { agent_id: "agent_c", acked_at: "2026-01-01T00:02:00.000Z" },
      ]);
    });

    it("refuses to overwrite a message: appending the same id again throws", () => {
      const storage = fresh();
      storage.appendMessage(message({ body: "original" }));

      expect(() => storage.appendMessage(message({ body: "rewritten" }))).toThrow();
      expect(storage.getMessage("msg_1")?.body).toBe("original");
    });
  });

  describe(`${adapterName}: task history`, () => {
    it("keeps revisions per task, oldest first, with structured changes", () => {
      const storage = fresh();
      storage.appendTaskRevision({
        revision_id: "rev_2",
        task_id: "task_1",
        changed_by: null,
        changed_at: "2026-01-02T00:00:00.000Z",
        changes: { priority: { old: 0, new: 5 } },
      });
      storage.appendTaskRevision({
        revision_id: "rev_1",
        task_id: "task_1",
        changed_by: "agent_a",
        changed_at: "2026-01-01T00:00:00.000Z",
        changes: { title: { old: "a", new: "b" }, branch: { old: null, new: "feat/x" } },
      });
      storage.appendTaskRevision({
        revision_id: "rev_3",
        task_id: "task_2",
        changed_by: null,
        changed_at: "2026-01-01T00:00:00.000Z",
        changes: {},
      });

      expect(storage.listTaskRevisions("task_1")).toEqual([
        {
          revision_id: "rev_1",
          task_id: "task_1",
          changed_by: "agent_a",
          changed_at: "2026-01-01T00:00:00.000Z",
          changes: { title: { old: "a", new: "b" }, branch: { old: null, new: "feat/x" } },
        },
        {
          revision_id: "rev_2",
          task_id: "task_1",
          changed_by: null,
          changed_at: "2026-01-02T00:00:00.000Z",
          changes: { priority: { old: 0, new: 5 } },
        },
      ]);
    });

    it("keeps notes per task, oldest first", () => {
      const storage = fresh();
      const note = (id: string, taskId: string, at: string) => ({
        note_id: id,
        task_id: taskId,
        agent_id: "agent_a",
        body: `note ${id}`,
        created_at: at,
      });
      storage.appendTaskNote(note("n2", "task_1", "2026-01-02T00:00:00.000Z"));
      storage.appendTaskNote(note("n1", "task_1", "2026-01-01T00:00:00.000Z"));
      storage.appendTaskNote(note("n3", "task_2", "2026-01-01T00:00:00.000Z"));

      expect(storage.listTaskNotes("task_1")).toEqual([
        note("n1", "task_1", "2026-01-01T00:00:00.000Z"),
        note("n2", "task_1", "2026-01-02T00:00:00.000Z"),
      ]);
      expect(storage.listTaskNotes("task_9")).toEqual([]);
    });
  });

  describe(`${adapterName}: path locks`, () => {
    const lock = (overrides: Partial<PathLock>): PathLock => ({
      lock_id: "lock_1",
      repository_id: "repo_1",
      agent_id: "agent_a",
      task_id: null,
      paths: ["src/**", "README.md"],
      acquired_at: "2026-01-01T00:00:00.000Z",
      heartbeat_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-01-01T00:15:00.000Z",
      released_at: null,
      ...overrides,
    });

    it("round-trips a lock and lists unreleased locks per repository", () => {
      const storage = fresh();
      storage.savePathLock(lock({}));
      storage.savePathLock(lock({ lock_id: "lock_2", repository_id: "repo_2", task_id: "task_1" }));

      expect(storage.getPathLock("lock_1")).toEqual(lock({}));
      expect(storage.listUnreleasedPathLocks("repo_1").map((l) => l.lock_id)).toEqual(["lock_1"]);
      expect(storage.listUnreleasedPathLocks().map((l) => l.lock_id).sort()).toEqual(["lock_1", "lock_2"]);
    });

    it("a released lock leaves the unreleased list but stays stored", () => {
      const storage = fresh();
      storage.savePathLock(lock({}));
      storage.savePathLock(lock({ released_at: "2026-01-01T00:05:00.000Z" }));

      expect(storage.listUnreleasedPathLocks("repo_1")).toEqual([]);
      expect(storage.getPathLock("lock_1")?.released_at).toBe("2026-01-01T00:05:00.000Z");
    });

    it("a heartbeat save moves heartbeat_at and expires_at only", () => {
      const storage = fresh();
      storage.savePathLock(lock({}));
      storage.savePathLock(
        lock({
          agent_id: "agent_intruder",
          paths: ["other/**"],
          heartbeat_at: "2026-01-01T00:10:00.000Z",
          expires_at: "2026-01-01T00:25:00.000Z",
        }),
      );

      expect(storage.getPathLock("lock_1")).toEqual(
        lock({ heartbeat_at: "2026-01-01T00:10:00.000Z", expires_at: "2026-01-01T00:25:00.000Z" }),
      );
    });
  });

  describe(`${adapterName}: listActiveAttempts`, () => {
    it("returns only created/leased/running attempts across tasks", () => {
      const storage = fresh();
      const attempt = (id: string, status: "running" | "completed" | "expired") => ({
        attempt_id: id,
        task_id: `task_${id}`,
        agent_id: "agent_a",
        workspace_session_id: "ws",
        attempt_number: 1,
        status,
        lease_id: null,
        fencing_token: 1,
        started_at: "2026-01-01T00:00:00.000Z",
        heartbeat_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2026-01-01T00:00:30.000Z",
        completed_at: null,
        error: null,
      });
      storage.saveAttempt(attempt("a1", "running"));
      storage.saveAttempt(attempt("a2", "completed"));
      storage.saveAttempt(attempt("a3", "expired"));

      expect(storage.listActiveAttempts().map((a) => a.attempt_id)).toEqual(["a1"]);
    });
  });
}

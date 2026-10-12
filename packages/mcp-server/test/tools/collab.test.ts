import { describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/internal-client.js";
import {
  AcquireLockInputSchema,
  handleAcquireLock,
  handleListMessages,
  handleSendMessage,
  handleUpdateTask,
  ListMessagesInputSchema,
  SendMessageInputSchema,
  UpdateTaskInputSchema,
} from "../../src/tools/collab.js";
import { handleListTasks, ListTasksInputSchema } from "../../src/tools/list-tasks.js";
import { createFakeFetch } from "../support/fake-fetch.js";

function clientFor(fetchImpl: typeof fetch): DaemonClient {
  return new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });
}

describe("collaboration tools: input handling that never reaches the daemon", () => {
  it("list_messages refuses unread without `to`", async () => {
    const { fetchImpl, calls } = createFakeFetch({});
    const result = await handleListMessages(ListMessagesInputSchema.parse({ unread: true }), clientFor(fetchImpl));

    expect(result).toMatchObject({ ok: false, error: { type: expect.stringContaining("invalid-input") } });
    expect(calls).toEqual([]);
  });

  it("update_task refuses a call with no field to change", async () => {
    const { fetchImpl, calls } = createFakeFetch({});
    const result = await handleUpdateTask(
      UpdateTaskInputSchema.parse({ taskId: "task_1", agentId: "agent_1" }),
      clientFor(fetchImpl),
    );

    expect(result).toMatchObject({ ok: false, error: { type: expect.stringContaining("invalid-input") } });
    expect(calls).toEqual([]);
  });

  it("schemas reject an empty body, no paths and an out-of-range TTL", () => {
    expect(() => SendMessageInputSchema.parse({ from: "a", to: "all", body: "" })).toThrow();
    expect(() => AcquireLockInputSchema.parse({ agentId: "a", repositoryId: "r", paths: [] })).toThrow();
    expect(() =>
      AcquireLockInputSchema.parse({ agentId: "a", repositoryId: "r", paths: ["src"], ttlSeconds: 0 }),
    ).toThrow();
  });
});

describe("collaboration tools: daemon failures become structured results", () => {
  it("a 409 lock conflict is ok:false with the daemon's problem type and detail", async () => {
    const { fetchImpl } = createFakeFetch({
      "POST /v1/locks": {
        status: 409,
        body: {
          type: "https://gitamesh.dev/problems/path-lock-conflict",
          title: "Path already locked",
          status: 409,
          detail: 'Path "src/a.ts" overlaps "src/**", locked by codex (agent_2).',
        },
      },
    });
    const result = await handleAcquireLock(
      AcquireLockInputSchema.parse({ agentId: "agent_1", repositoryId: "repo_1", paths: ["src/a.ts"] }),
      clientFor(fetchImpl),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        type: "https://gitamesh.dev/problems/path-lock-conflict",
        title: "Path already locked",
        status: 409,
        detail: 'Path "src/a.ts" overlaps "src/**", locked by codex (agent_2).',
      },
    });
  });

  it("an unreachable daemon is ok:false, not a throw", async () => {
    const { fetchImpl } = createFakeFetch({ "POST /v1/messages": { networkError: true } });
    const result = await handleSendMessage(
      SendMessageInputSchema.parse({ from: "agent_1", to: "all", body: "hi" }),
      clientFor(fetchImpl),
    );

    expect(result).toMatchObject({ ok: false, error: { type: expect.stringContaining("daemon-unreachable") } });
  });
});

describe("gitamesh_list_tasks owner filters", () => {
  it("forwards agentId and unclaimed as the daemon's query params", async () => {
    const { fetchImpl, calls } = createFakeFetch({ "GET /v1/tasks": { body: { tasks: [] } } });
    await handleListTasks(
      ListTasksInputSchema.parse({ agentId: "agent_1", unclaimed: true }),
      clientFor(fetchImpl),
    );

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("agentId")).toBe("agent_1");
    expect(url.searchParams.get("unclaimed")).toBe("true");
  });
});

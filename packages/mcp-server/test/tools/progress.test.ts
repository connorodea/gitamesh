import { describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/internal-client.js";
import { createMcpServer } from "../../src/server.js";
import {
  handleListTaskProgress,
  handleReportProgress,
  ListTaskProgressInputSchema,
  ReportProgressInputSchema,
} from "../../src/tools/progress.js";
import { handleUpdateTask, UpdateTaskInputSchema } from "../../src/tools/collab.js";
import { createFakeFetch } from "../support/fake-fetch.js";

function clientFor(fetchImpl: typeof fetch): DaemonClient {
  return new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });
}

const event = { event_type: "task.progress", task_id: "task_1", payload: { summary: "s", phase: "working", evidence: [] } };

describe("gitamesh_report_progress", () => {
  it("posts the report with the attempt and fencing token to the task's progress route", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task_1/progress": { status: 201, body: { progress: event, replayed: false } },
    });
    const result = await handleReportProgress(
      ReportProgressInputSchema.parse({
        taskId: "task_1",
        attemptId: "attempt_1",
        fencingToken: 3,
        summary: "parsed the manifest",
        phase: "working",
        evidence: ["log line"],
      }),
      clientFor(fetchImpl),
    );
    expect(result).toMatchObject({ ok: true, replayed: false });
    expect(calls[0]?.body).toEqual({
      attemptId: "attempt_1",
      fencingToken: 3,
      summary: "parsed the manifest",
      phase: "working",
      evidence: ["log line"],
    });
  });

  it("returns a structured error on a stale fencing token", async () => {
    const { fetchImpl } = createFakeFetch({
      "POST /v1/tasks/task_1/progress": {
        status: 409,
        body: { type: "https://gitamesh.dev/problems/stale-attempt-token", title: "Stale", status: 409, detail: "stale" },
      },
    });
    const result = await handleReportProgress(
      ReportProgressInputSchema.parse({ taskId: "task_1", attemptId: "a", fencingToken: 0, summary: "s", phase: "working" }),
      clientFor(fetchImpl),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(409);
  });

  it("rejects an empty summary, an unknown phase and a negative token", () => {
    const base = { taskId: "t", attemptId: "a", fencingToken: 1, summary: "s", phase: "working" };
    expect(() => ReportProgressInputSchema.parse({ ...base, summary: "" })).toThrow();
    expect(() => ReportProgressInputSchema.parse({ ...base, phase: "nope" })).toThrow();
    expect(() => ReportProgressInputSchema.parse({ ...base, fencingToken: -1 })).toThrow();
  });
});

describe("gitamesh_list_task_progress", () => {
  it("returns the task's progress events and the next cursor", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "GET /v1/tasks/task_1/progress": { body: { events: [event], nextCursor: 9 } },
    });
    const result = await handleListTaskProgress(
      ListTaskProgressInputSchema.parse({ taskId: "task_1", since: 4, limit: 10 }),
      clientFor(fetchImpl),
    );
    expect(result).toMatchObject({ ok: true, nextCursor: 9 });
    expect(calls[0]?.url).toContain("since=4");
    expect(calls[0]?.url).toContain("limit=10");
  });
});

describe("gitamesh_update_task expectedDependencies", () => {
  it("sends expected_dependencies alongside dependencies", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "PATCH /v1/tasks/task_1": { body: { task: {}, revision: null } },
    });
    await handleUpdateTask(
      UpdateTaskInputSchema.parse({ taskId: "task_1", dependencies: ["b"], expectedDependencies: ["a"] }),
      clientFor(fetchImpl),
    );
    expect(calls[0]?.body).toEqual({ dependencies: ["b"], expected_dependencies: ["a"] });
  });

  it("refuses expectedDependencies without dependencies before calling the daemon", async () => {
    const { fetchImpl, calls } = createFakeFetch({});
    const result = await handleUpdateTask(
      UpdateTaskInputSchema.parse({ taskId: "task_1", title: "x", expectedDependencies: [] }),
      clientFor(fetchImpl),
    );
    expect(result).toMatchObject({ ok: false, error: { type: expect.stringContaining("invalid-input") } });
    expect(calls).toEqual([]);
  });
});

describe("createMcpServer", () => {
  it("registers the progress tools", () => {
    const server = createMcpServer({ daemonUrl: "http://127.0.0.1:8787", token: null, tokenSource: "none" });
    const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(registered).toEqual(expect.arrayContaining(["gitamesh_report_progress", "gitamesh_list_task_progress"]));
  });
});

import { describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/internal-client.js";
import {
  handleCompleteTask,
  CompleteTaskInputSchema,
  CompleteTaskOutputSchema,
} from "../../src/tools/complete-task.js";
import { createFakeFetch } from "../support/fake-fetch.js";
import { fakeAttempt, fakeTask } from "../support/fixtures.js";

describe("gitamesh_complete_task", () => {
  it("completes an attempt on the happy path", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task_1/complete": {
        body: {
          attempt: fakeAttempt({ status: "completed" }),
          task: fakeTask({ status: "completed" }),
          result: { summary: "done" },
          replayed: false,
        },
      },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const input = CompleteTaskInputSchema.parse({
      taskId: "task_1",
      attemptId: "attempt_1",
      fencingToken: 1,
      result: { summary: "done" },
    });
    const result = await handleCompleteTask(input, client);
    const parsed = CompleteTaskOutputSchema.parse(result);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.attempt.status).toBe("completed");
      expect(parsed.task.status).toBe("completed");
      expect(parsed.result).toEqual({ summary: "done" });
    }
    expect(calls[0]?.body).toMatchObject({ attemptId: "attempt_1", fencingToken: 1 });
  });

  it("returns a structured error, not a throw, for an unknown attempt", async () => {
    const { fetchImpl } = createFakeFetch({
      "POST /v1/tasks/task_1/complete": {
        status: 404,
        body: {
          type: "https://gitamesh.dev/problems/attempt-not-found",
          title: "Attempt not found",
          status: 404,
          detail: "No attempt exists with id attempt_1.",
        },
      },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const result = await handleCompleteTask(
      CompleteTaskInputSchema.parse({ taskId: "task_1", attemptId: "attempt_1", fencingToken: 1 }),
      client,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(404);
    }
  });
});

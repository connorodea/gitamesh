import { describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/internal-client.js";
import { handleFailTask, FailTaskInputSchema, FailTaskOutputSchema } from "../../src/tools/fail-task.js";
import { createFakeFetch } from "../support/fake-fetch.js";
import { fakeAttempt, fakeTask } from "../support/fixtures.js";

describe("gitamesh_fail_task", () => {
  it("fails an attempt, requeuing the task, on the happy path", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task_1/fail": {
        body: {
          attempt: fakeAttempt({ status: "failed", error: "boom" }),
          task: fakeTask({ status: "queued" }),
          replayed: false,
        },
      },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const input = FailTaskInputSchema.parse({
      taskId: "task_1",
      attemptId: "attempt_1",
      fencingToken: 1,
      error: "boom",
    });
    const result = await handleFailTask(input, client);
    const parsed = FailTaskOutputSchema.parse(result);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.attempt.error).toBe("boom");
      expect(parsed.task.status).toBe("queued");
    }
    expect(calls[0]?.body).toMatchObject({ error: "boom" });
  });

  it("rejects an empty error string via schema validation", () => {
    expect(() =>
      FailTaskInputSchema.parse({ taskId: "task_1", attemptId: "attempt_1", fencingToken: 1, error: "" }),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/internal-client.js";
import { handleCreateTask, CreateTaskInputSchema, CreateTaskOutputSchema } from "../../src/tools/create-task.js";
import { createFakeFetch } from "../support/fake-fetch.js";
import { fakeTask } from "../support/fixtures.js";

describe("gitamesh_create_task", () => {
  it("creates a task on the happy path", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks": { status: 201, body: { task: fakeTask(), replayed: false } },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const input = CreateTaskInputSchema.parse({ repositoryId: "repo_1", title: "Build the thing" });
    const result = await handleCreateTask(input, client);
    const parsed = CreateTaskOutputSchema.parse(result);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.task.repository_id).toBe("repo_1");
    }
    expect(calls[0]?.body).toMatchObject({ repository_id: "repo_1", title: "Build the thing" });
  });

  it("rejects malformed input via schema validation (missing required title)", () => {
    expect(() => CreateTaskInputSchema.parse({ repositoryId: "repo_1" })).toThrow();
  });

  it("returns a structured error, not a throw, on a 400 from the daemon", async () => {
    const { fetchImpl } = createFakeFetch({
      "POST /v1/tasks": {
        status: 400,
        body: {
          type: "https://gitamesh.dev/problems/invalid-request",
          title: "Invalid request body",
          status: 400,
          detail: "title is required",
        },
      },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const result = await handleCreateTask(
      CreateTaskInputSchema.parse({ repositoryId: "repo_1", title: "x" }),
      client,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(400);
    }
  });
});

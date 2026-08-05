import { describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/internal-client.js";
import { handleListTasks, ListTasksInputSchema, ListTasksOutputSchema } from "../../src/tools/list-tasks.js";
import { createFakeFetch } from "../support/fake-fetch.js";
import { fakeTask } from "../support/fixtures.js";

describe("gitamesh_list_tasks", () => {
  it("lists tasks, forwarding optional filters as query params", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "GET /v1/tasks": { body: { tasks: [fakeTask()] } },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const input = ListTasksInputSchema.parse({ repositoryId: "repo_1", status: "pending" });
    const result = await handleListTasks(input, client);
    const parsed = ListTasksOutputSchema.parse(result);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.tasks).toHaveLength(1);
    }
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("repositoryId")).toBe("repo_1");
    expect(url.searchParams.get("status")).toBe("pending");
  });

  it("rejects an invalid status value via schema validation", () => {
    expect(() => ListTasksInputSchema.parse({ status: "not-a-real-status" })).toThrow();
  });
});

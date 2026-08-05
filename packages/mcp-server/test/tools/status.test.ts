import { describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/internal-client.js";
import { handleStatus, StatusOutputSchema } from "../../src/tools/status.js";
import { createFakeFetch } from "../support/fake-fetch.js";
import { fakeTask, fakeClaim } from "../support/fixtures.js";

describe("gitamesh_status", () => {
  it("reports daemon health plus task/claim counts on the happy path", async () => {
    const { fetchImpl } = createFakeFetch({
      "GET /healthz": { body: { status: "ok" } },
      "GET /v1/tasks": {
        body: { tasks: [fakeTask({ status: "pending" }), fakeTask({ task_id: "task_2", status: "completed" })] },
      },
      "GET /v1/claims": { body: { claims: [fakeClaim()] } },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const result = await handleStatus({}, client, "http://127.0.0.1:8787");
    const parsed = StatusOutputSchema.parse(result);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.daemon).toEqual({ reachable: true, status: "ok" });
      expect(parsed.tasks?.open).toBe(1);
      expect(parsed.tasks?.byStatus.pending).toBe(1);
      expect(parsed.tasks?.byStatus.completed).toBe(1);
      expect(parsed.claims?.active).toBe(1);
      expect(parsed.config.daemonUrl).toBe("http://127.0.0.1:8787");
    }
  });

  it("reports daemon unreachable without task/claim counts, and does not throw", async () => {
    const client = new DaemonClient({
      baseUrl: "http://127.0.0.1:8787",
      token: null,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });

    const result = await handleStatus({}, client, "http://127.0.0.1:8787");
    const parsed = StatusOutputSchema.parse(result);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.daemon).toEqual({ reachable: false });
      expect(parsed.tasks).toBeUndefined();
      expect(parsed.claims).toBeUndefined();
    }
  });

  it("scopes task/claim listing to repositoryId when provided", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "GET /healthz": { body: { status: "ok" } },
      "GET /v1/tasks": { body: { tasks: [] } },
      "GET /v1/claims": { body: { claims: [] } },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    await handleStatus({ repositoryId: "repo_1" }, client, "http://127.0.0.1:8787");

    const taskCall = calls.find((c) => c.url.includes("/v1/tasks"));
    const claimCall = calls.find((c) => c.url.includes("/v1/claims"));
    expect(new URL(taskCall!.url).searchParams.get("repositoryId")).toBe("repo_1");
    expect(new URL(claimCall!.url).searchParams.get("repositoryId")).toBe("repo_1");
  });
});

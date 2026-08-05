import { describe, expect, it } from "vitest";

import { GitameshClient, GitameshClientError } from "../src/client.js";
import { createFakeFetch } from "./support/fake-fetch.js";

describe("GitameshClient", () => {
  it("sends an Authorization: Bearer header when a token is configured", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "GET /v1/agents": { body: { agents: [] } },
    });
    const client = new GitameshClient({
      baseUrl: "http://127.0.0.1:4477",
      token: "gm_secret",
      fetchImpl,
    });

    await client.listAgents();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.Authorization).toBe("Bearer gm_secret");
  });

  it("does not send an Authorization header for /healthz", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "GET /healthz": { body: { status: "ok" } },
    });
    const client = new GitameshClient({
      baseUrl: "http://127.0.0.1:4477",
      token: "gm_secret",
      fetchImpl,
    });

    const result = await client.healthz();

    expect(result).toEqual({ status: "ok" });
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("throws a clear, non-stack-trace error when the daemon is unreachable", async () => {
    const { fetchImpl } = createFakeFetch({});
    const client = new GitameshClient({
      baseUrl: "http://127.0.0.1:4477",
      token: null,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });

    await expect(client.healthz()).rejects.toMatchObject({
      message: "daemon unreachable at http://127.0.0.1:4477 — is it running? (gitamesh doctor)",
      unreachable: true,
    });
    void fetchImpl;
  });

  it("surfaces RFC 9457 problem details on a non-2xx response", async () => {
    const { fetchImpl } = createFakeFetch({
      "POST /v1/agents": {
        status: 400,
        body: {
          type: "https://gitamesh.dev/problems/invalid-request",
          title: "Invalid request body",
          status: 400,
          detail: "display_name is required",
        },
      },
    });
    const client = new GitameshClient({ baseUrl: "http://127.0.0.1:4477", token: "t", fetchImpl });

    await expect(
      client.registerAgent({ display_name: "", runtime: "claude-code" }),
    ).rejects.toBeInstanceOf(GitameshClientError);

    try {
      await client.registerAgent({ display_name: "", runtime: "claude-code" });
      expect.unreachable();
    } catch (error) {
      const err = error as GitameshClientError;
      expect(err.status).toBe(400);
      expect(err.problem?.detail).toBe("display_name is required");
      expect(err.unreachable).toBe(false);
    }
  });

  it("posts a JSON body with Content-Type application/json for task creation", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks": { status: 201, body: { task: { task_id: "t-1" } } },
    });
    const client = new GitameshClient({ baseUrl: "http://127.0.0.1:4477", token: "t", fetchImpl });

    await client.createTask({ title: "do the thing" });

    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({ title: "do the thing" });
  });

  it("encodes query parameters for list endpoints", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "GET /v1/tasks": { body: { tasks: [] } },
    });
    const client = new GitameshClient({ baseUrl: "http://127.0.0.1:4477", token: "t", fetchImpl });

    await client.listTasks({ repository_id: "repo-1", status: "pending" });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("repository_id")).toBe("repo-1");
    expect(url.searchParams.get("status")).toBe("pending");
  });
});

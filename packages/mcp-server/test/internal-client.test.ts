import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/internal-client.js";
import { createFakeFetch } from "./support/fake-fetch.js";

describe("DaemonClient", () => {
  it("sends an Authorization: Bearer header when a token is configured", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "GET /v1/agents": { body: { agents: [] } },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: "gm_secret", fetchImpl });

    await client.listAgents();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.Authorization).toBe("Bearer gm_secret");
  });

  it("does not send an Authorization header for /healthz", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "GET /healthz": { body: { status: "ok" } },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: "gm_secret", fetchImpl });

    const result = await client.healthz();

    expect(result).toEqual({ ok: true, status: 200, data: { status: "ok" } });
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("returns a structured unreachable result instead of throwing on a network failure", async () => {
    const { fetchImpl } = createFakeFetch({});
    const client = new DaemonClient({
      baseUrl: "http://127.0.0.1:8787",
      token: null,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });

    const result = await client.healthz();
    void fetchImpl;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unreachable).toBe(true);
    }
  });

  it("returns a structured problem-details result instead of throwing on a non-2xx response", async () => {
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
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: "gm_secret", fetchImpl });

    const result = await client.registerAgent({ display_name: "", runtime: "claude-code" });

    expect(result.ok).toBe(false);
    if (!result.ok && !result.unreachable) {
      expect(result.status).toBe(400);
      expect(result.problem.detail).toBe("display_name is required");
    }
  });

  it("builds query strings, skipping undefined values", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "GET /v1/tasks": { body: { tasks: [] } },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    await client.listTasks({ repositoryId: "repo_1", status: undefined });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("repositoryId")).toBe("repo_1");
    expect(url.searchParams.has("status")).toBe(false);
  });
});

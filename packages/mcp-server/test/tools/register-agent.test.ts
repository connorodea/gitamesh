import { describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/internal-client.js";
import {
  handleRegisterAgent,
  RegisterAgentInputSchema,
  RegisterAgentOutputSchema,
} from "../../src/tools/register-agent.js";
import { createFakeFetch } from "../support/fake-fetch.js";
import { fakeAgent } from "../support/fixtures.js";

describe("gitamesh_register_agent", () => {
  it("registers an agent, forwarding the optional agentId hint as metadata", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/agents": {
        status: 201,
        body: { agent: fakeAgent({ metadata: { requested_agent_id: "my-hint" } }), replayed: false },
      },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const input = RegisterAgentInputSchema.parse({
      agentId: "my-hint",
      displayName: "claude-code-1",
      runtime: "claude-code",
      capabilities: ["typescript"],
    });
    const result = await handleRegisterAgent(input, client);
    const parsed = RegisterAgentOutputSchema.parse(result);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.agent.metadata.requested_agent_id).toBe("my-hint");
      expect(parsed.replayed).toBe(false);
    }
    expect(calls[0]?.body).toMatchObject({
      display_name: "claude-code-1",
      runtime: "claude-code",
      metadata: { requested_agent_id: "my-hint" },
    });
  });

  it("rejects malformed input via schema validation", () => {
    expect(() => RegisterAgentInputSchema.parse({ runtime: "claude-code" })).toThrow();
  });

  it("returns a structured error on a daemon-side validation failure", async () => {
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
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const result = await handleRegisterAgent(
      RegisterAgentInputSchema.parse({ displayName: "x", runtime: "claude-code" }),
      client,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(400);
      expect(result.error.detail).toBe("display_name is required");
    }
  });
});

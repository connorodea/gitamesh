import { describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/internal-client.js";
import { handleClaimTask, ClaimTaskInputSchema, ClaimTaskOutputSchema } from "../../src/tools/claim-task.js";
import { createFakeFetch } from "../support/fake-fetch.js";
import { fakeAttempt, fakeClaim } from "../support/fixtures.js";

describe("gitamesh_claim_task", () => {
  it("claims a task and returns the attempt + fencing token on the happy path", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task_1/claim": {
        body: {
          attempt: fakeAttempt(),
          fencingToken: 1,
          resourceClaims: [fakeClaim()],
          replayed: false,
        },
      },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const input = ClaimTaskInputSchema.parse({
      taskId: "task_1",
      agentId: "agent_1",
      workspaceSessionId: "session_1",
      requiredResources: [{ resourceType: "path", resourceKey: "src/index.ts", mode: "write" }],
    });
    const result = await handleClaimTask(input, client);
    const parsed = ClaimTaskOutputSchema.parse(result);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.attempt.attempt_id).toBe("attempt_1");
      expect(parsed.fencingToken).toBe(1);
      expect(parsed.resourceClaims).toHaveLength(1);
    }
    expect(calls[0]?.body).toMatchObject({ agentId: "agent_1", workspaceSessionId: "session_1" });
  });

  /**
   * This is the test the task spec calls out explicitly: a 409 claim
   * conflict must come back as a structured `{ ok: false, error }` result,
   * never as a thrown exception — so the calling AI agent can react
   * sensibly (e.g. "pick a different task") instead of crashing on an
   * unhandled rejection.
   */
  it("returns a structured conflict result (not a thrown error) when the task is already claimed", async () => {
    const { fetchImpl } = createFakeFetch({
      "POST /v1/tasks/task_1/claim": {
        status: 409,
        body: {
          type: "https://gitamesh.dev/problems/task-already-claimed",
          title: "Task already claimed",
          status: 409,
          detail: "Task task_1 already has a live attempt and cannot be claimed again.",
          extensions: { task_id: "task_1", existing_attempt_id: "attempt_9" },
        },
      },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const input = ClaimTaskInputSchema.parse({
      taskId: "task_1",
      agentId: "agent_1",
      workspaceSessionId: "session_1",
    });

    await expect(handleClaimTask(input, client)).resolves.not.toThrow();
    const result = await handleClaimTask(input, client);
    const parsed = ClaimTaskOutputSchema.parse(result);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.status).toBe(409);
      expect(parsed.error.type).toBe("https://gitamesh.dev/problems/task-already-claimed");
      expect(parsed.error.detail).toContain("already has a live attempt");
    }
  });

  it("defaults requiredResources to an empty array when omitted", () => {
    const input = ClaimTaskInputSchema.parse({
      taskId: "task_1",
      agentId: "agent_1",
      workspaceSessionId: "session_1",
    });
    expect(input.requiredResources).toEqual([]);
  });

  it("rejects an invalid resource mode via schema validation", () => {
    expect(() =>
      ClaimTaskInputSchema.parse({
        taskId: "task_1",
        agentId: "agent_1",
        workspaceSessionId: "session_1",
        requiredResources: [{ resourceType: "path", resourceKey: "x", mode: "not-a-mode" }],
      }),
    ).toThrow();
  });
});

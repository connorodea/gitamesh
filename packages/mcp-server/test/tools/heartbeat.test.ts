import { describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/internal-client.js";
import { handleHeartbeat, HeartbeatInputSchema, HeartbeatOutputSchema } from "../../src/tools/heartbeat.js";
import { createFakeFetch } from "../support/fake-fetch.js";
import { fakeAttempt, fakeClaim } from "../support/fixtures.js";

describe("gitamesh_heartbeat", () => {
  it("renews an attempt's lease on the happy path", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task_1/heartbeat": {
        body: { attempt: fakeAttempt({ fencing_token: 1 }), resourceClaims: [fakeClaim()] },
      },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const input = HeartbeatInputSchema.parse({ taskId: "task_1", attemptId: "attempt_1", fencingToken: 1 });
    const result = await handleHeartbeat(input, client);
    const parsed = HeartbeatOutputSchema.parse(result);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.attempt.attempt_id).toBe("attempt_1");
      expect(parsed.resourceClaims).toHaveLength(1);
    }
    expect(calls[0]?.body).toMatchObject({ attemptId: "attempt_1", fencingToken: 1 });
  });

  it("returns a structured error (not a throw) on a stale fencing token", async () => {
    const { fetchImpl } = createFakeFetch({
      "POST /v1/tasks/task_1/heartbeat": {
        status: 409,
        body: {
          type: "https://gitamesh.dev/problems/stale-attempt-token",
          title: "Stale fencing token",
          status: 409,
          detail: "Fencing token for attempt attempt_1 is stale; this worker's lease was superseded.",
        },
      },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const result = await handleHeartbeat(
      HeartbeatInputSchema.parse({ taskId: "task_1", attemptId: "attempt_1", fencingToken: 0 }),
      client,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(409);
    }
  });

  it("rejects a negative fencingToken via schema validation", () => {
    expect(() =>
      HeartbeatInputSchema.parse({ taskId: "task_1", attemptId: "attempt_1", fencingToken: -1 }),
    ).toThrow();
  });
});

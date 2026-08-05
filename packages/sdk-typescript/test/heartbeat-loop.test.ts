import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitameshClient } from "../src/client.js";
import { createFakeFetch } from "./support/fake-fetch.js";

const baseUrl = "http://127.0.0.1:8787";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GitameshClient.startHeartbeatLoop", () => {
  it("calls the heartbeat endpoint on the expected interval", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task_1/heartbeat": {
        body: { attempt: { attempt_id: "attempt_1" }, resourceClaims: [] },
      },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    const handle = client.startHeartbeatLoop("task_1", "attempt_1", 7, 1000);

    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toHaveLength(5);

    handle.stop();
  });

  it("stops cleanly when .stop() is called — no further calls after stopping", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task_1/heartbeat": {
        body: { attempt: { attempt_id: "attempt_1" }, resourceClaims: [] },
      },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    const handle = client.startHeartbeatLoop("task_1", "attempt_1", 7, 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);

    handle.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);
  });

  it("surfaces heartbeat failures via onError instead of throwing into the interval", async () => {
    const problem = {
      type: "https://gitamesh.dev/problems/stale-attempt-token",
      title: "Stale fencing token",
      status: 409,
      detail: "Fencing token for attempt attempt_1 is stale.",
    };
    const { fetchImpl } = createFakeFetch({
      "POST /v1/tasks/task_1/heartbeat": { status: 409, body: problem },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    const onError = vi.fn();
    const handle = client.startHeartbeatLoop("task_1", "attempt_1", 7, 500, { onError });

    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ name: "GitameshConflictError", status: 409 });

    handle.stop();
  });

  it("sends the fencing token on every tick, unchanged across the loop's lifetime", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "POST /v1/tasks/task_1/heartbeat": {
        body: { attempt: { attempt_id: "attempt_1" }, resourceClaims: [] },
      },
    });
    const client = new GitameshClient({ baseUrl, token: "gm_t", fetchImpl });

    const handle = client.startHeartbeatLoop("task_1", "attempt_1", 42, 250);
    await vi.advanceTimersByTimeAsync(750);

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.body).toMatchObject({ attemptId: "attempt_1", fencingToken: 42 });
    }

    handle.stop();
  });
});

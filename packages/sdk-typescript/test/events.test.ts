import { describe, expect, it, vi } from "vitest";
import { GitameshClient } from "../src/client.js";
import { createFakeWebSocketCtor } from "./support/fake-websocket.js";

const baseUrl = "http://127.0.0.1:8787";

describe("GitameshClient.subscribeToEvents", () => {
  it("connects to the ws:// stream URL with ?since= and ?token=", () => {
    const { ctor, instances } = createFakeWebSocketCtor();
    const client = new GitameshClient({ baseUrl, token: "gm_secret", fetchImpl: (async () => {
      throw new Error("unused");
    }) as typeof fetch });

    const sub = client.subscribeToEvents({ since: 5, onEvent: () => {}, wsImpl: ctor });

    expect(instances).toHaveLength(1);
    const url = new URL(instances[0]!.url);
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/v1/events/stream");
    expect(url.searchParams.get("since")).toBe("5");
    expect(url.searchParams.get("token")).toBe("gm_secret");

    sub.close();
  });

  it("delivers events to onEvent and advances the cursor", () => {
    const { ctor, instances } = createFakeWebSocketCtor();
    const client = new GitameshClient({ baseUrl, token: "t", fetchImpl: (async () => {
      throw new Error("unused");
    }) as typeof fetch });

    const received: unknown[] = [];
    const sub = client.subscribeToEvents({ since: 0, onEvent: (e) => received.push(e), wsImpl: ctor });

    instances[0]!.emitMessage({ cursor: 1, event_id: "ev_1", event_type: "task.created" });
    instances[0]!.emitMessage({ cursor: 2, event_id: "ev_2", event_type: "task.claimed" });

    expect(received).toEqual([
      { cursor: 1, event_id: "ev_1", event_type: "task.created" },
      { cursor: 2, event_id: "ev_2", event_type: "task.claimed" },
    ]);

    sub.close();
  });

  it("on a server-side disconnect, reconnects with ?since= set to the last cursor seen — no events skipped", async () => {
    vi.useFakeTimers();
    try {
      const { ctor, instances } = createFakeWebSocketCtor();
      const client = new GitameshClient({ baseUrl, token: "t", fetchImpl: (async () => {
        throw new Error("unused");
      }) as typeof fetch });

      const received: number[] = [];
      const disconnects: unknown[] = [];
      const sub = client.subscribeToEvents({
        since: 0,
        onEvent: (e) => received.push(e.cursor),
        onDisconnect: (info) => disconnects.push(info),
        reconnectDelayMs: 1000,
        wsImpl: ctor,
      });

      // First connection: server delivers cursor 1, then 2, before dropping.
      instances[0]!.emitMessage({ cursor: 1, event_id: "ev_1", event_type: "task.created" });
      instances[0]!.emitMessage({ cursor: 2, event_id: "ev_2", event_type: "task.claimed" });
      instances[0]!.simulateServerDisconnect();

      expect(disconnects).toHaveLength(1);
      expect(instances).toHaveLength(1); // reconnect not yet scheduled to fire

      await vi.advanceTimersByTimeAsync(1000);

      // A new socket was opened, resuming from cursor 2 (the last event fully processed).
      expect(instances).toHaveLength(2);
      const reconnectUrl = new URL(instances[1]!.url);
      expect(reconnectUrl.searchParams.get("since")).toBe("2");

      // Server resumes delivery on the new socket: no gap, cursor 3 arrives next.
      instances[1]!.emitMessage({ cursor: 3, event_id: "ev_3", event_type: "attempt.completed" });

      expect(received).toEqual([1, 2, 3]);

      sub.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after .close() is called by the caller", async () => {
    vi.useFakeTimers();
    try {
      const { ctor, instances } = createFakeWebSocketCtor();
      const client = new GitameshClient({ baseUrl, token: "t", fetchImpl: (async () => {
        throw new Error("unused");
      }) as typeof fetch });

      const sub = client.subscribeToEvents({ since: 0, onEvent: () => {}, reconnectDelayMs: 1000, wsImpl: ctor });
      sub.close();

      expect(instances[0]!.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(instances).toHaveLength(1); // no reconnect happened
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect when autoReconnect is false", async () => {
    vi.useFakeTimers();
    try {
      const { ctor, instances } = createFakeWebSocketCtor();
      const client = new GitameshClient({ baseUrl, token: "t", fetchImpl: (async () => {
        throw new Error("unused");
      }) as typeof fetch });

      const disconnects: unknown[] = [];
      client.subscribeToEvents({
        since: 0,
        onEvent: () => {},
        onDisconnect: (info) => disconnects.push(info),
        autoReconnect: false,
        reconnectDelayMs: 1000,
        wsImpl: ctor,
      });

      instances[0]!.simulateServerDisconnect();
      expect(disconnects).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

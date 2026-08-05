import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { EventBroadcaster, type StreamClient } from "../src/events-bus.js";
import { Metrics } from "../src/metrics.js";

/**
 * `ioredis-mock` is used here instead of a real `redis-server` because
 * this test needs no network I/O or durability — it is exercising pure
 * pub/sub wiring logic (does a publish on one connection reach a
 * subscriber on another connection, and does that trigger the right
 * broadcaster method). `ioredis-mock` shares its in-memory pub/sub bus
 * across every mock client instance created in the same process, which
 * is exactly the shape needed to simulate "two separate daemon processes
 * both connected to the same Redis": two `Redis` instances in this one
 * test process, talking only through the mock's shared bus, never
 * calling each other's code directly.
 *
 * A real `redis-server` (this repo has one available locally, and one
 * was used to manually verify `ioredis`'s basic publish/subscribe
 * round-trip against actual Redis before this adapter was built — see
 * `apps/daemon/src/redis-signal.ts`'s doc comment) is reserved for the
 * end-to-end two-Docker-container proof, which additionally exercises
 * the real daemon process boundary, real HTTP API, and a real WebSocket
 * client — well beyond what a hermetic `pnpm test` run should require
 * (this suite must pass in CI with no external services, the same
 * reasoning `@gitamesh/storage-postgres` applied when it chose
 * `pglite` as its default test backend over a required real Postgres).
 */
vi.mock("ioredis", async () => {
  const { default: RedisMock } = await import("ioredis-mock");
  return { Redis: RedisMock, default: RedisMock };
});

const { createRedisSignal } = await import("../src/redis-signal.js");

function fakeClient(overrides: Partial<StreamClient> = {}): StreamClient & { sent: unknown[][] } {
  const sent: unknown[][] = [];
  return {
    cursor: 0,
    send: (events) => sent.push(events),
    sent,
    ...overrides,
  };
}

describe("createRedisSignal", () => {
  it("delivers a signal published on one connection to a subscriber on a separate connection", async () => {
    // Same URL for both: `ioredis-mock` scopes its shared in-memory bus per
    // connection string (mirroring how two real daemon processes must
    // point at the *same* Redis instance/URL to signal each other at all).
    const received: string[] = [];
    const a = createRedisSignal({ url: "redis://mock-shared", onSignal: () => received.push("a") });
    const b = createRedisSignal({ url: "redis://mock-shared", onSignal: () => received.push("b") });
    await Promise.all([a.ready, b.ready]);

    a.publish();

    // Both fire: `a` receives its own publish too, because Redis pub/sub
    // has no concept of sender identity — every connection subscribed to
    // a channel gets every message published to it, including messages
    // published from a different connection owned by the same logical
    // process (each `RedisSignal` opens a separate publish connection and
    // subscribe connection). This is harmless in production: A's own
    // `notifyFromRemoteSignal()` re-reads storage from each client's
    // current cursor, which `notifyNew()`'s direct local push already
    // advanced, so the redundant call finds nothing new to send.
    await vi.waitFor(() => {
      expect(received).toContain("a");
      expect(received).toContain("b");
    });

    await Promise.all([a.close(), b.close()]);
  });

  it("does not throw when publish is called with no subscribers", async () => {
    const solo = createRedisSignal({ url: "redis://mock-solo", onSignal: () => {} });
    await solo.ready;
    expect(() => solo.publish()).not.toThrow();
    await solo.close();
  });
});

describe("cross-process live event delivery via Redis signaling", () => {
  let storage: SqliteStorageAdapter;

  beforeEach(() => {
    // One shared storage instance stands in for one shared database
    // (e.g. Postgres) that two separate daemon *processes* would both
    // point at in production — the whole point of this feature is fan-out
    // between processes that already share the same source of truth.
    storage = createInMemorySqliteStorage();
  });

  afterEach(() => {
    storage.close();
  });

  it("process B's client receives a live event caused by process A's mutation, without B.notifyNew() ever being called directly", async () => {
    // "Process A": has its own EventBroadcaster and its own Redis signal connection.
    const broadcasterA = new EventBroadcaster(storage, new Metrics());
    const signalA = createRedisSignal({
      url: "redis://mock-cross",
      onSignal: () => broadcasterA.notifyFromRemoteSignal(),
    });
    broadcasterA.setSignalPublisher(signalA);
    await signalA.ready;

    // "Process B": its own EventBroadcaster, own Redis signal connection,
    // and a locally-connected WebSocket-style client (fake stand-in).
    const broadcasterB = new EventBroadcaster(storage, new Metrics());
    const notifyFromRemoteSignalSpy = vi.spyOn(broadcasterB, "notifyFromRemoteSignal");
    const notifyNewSpy = vi.spyOn(broadcasterB, "notifyNew");
    const signalB = createRedisSignal({
      url: "redis://mock-cross",
      onSignal: () => broadcasterB.notifyFromRemoteSignal(),
    });
    broadcasterB.setSignalPublisher(signalB);
    await signalB.ready;

    const clientB = fakeClient();
    broadcasterB.subscribe(clientB, storage.latestEventCursor());

    // A mutation happens on "process A" — e.g. via its own HTTP route
    // handler calling storage.appendEvent(...) then broadcaster.notifyNew().
    storage.appendEvent({
      schema_version: 1,
      event_type: "agent.registered",
      occurred_at: storage.now(),
      namespace_id: "ns-1",
      repository_id: null,
      workflow_id: null,
      task_id: null,
      attempt_id: null,
      agent_id: "agent-from-process-a",
      workspace_session_id: null,
      correlation_id: null,
      causation_id: null,
      idempotency_key: null,
      payload: {},
      metadata: {},
    });
    broadcasterA.notifyNew();

    // Process B never had notifyNew() called on it directly — only the
    // remote-signal path should have fired, and it should have re-read
    // shared storage and pushed the new event to B's own local client.
    await vi.waitFor(() => expect(clientB.sent.length).toBe(1));
    expect(notifyFromRemoteSignalSpy).toHaveBeenCalledTimes(1);
    expect(notifyNewSpy).not.toHaveBeenCalled();
    const deliveredEvents = clientB.sent[0] as Array<{ event_type: string }>;
    expect(deliveredEvents[0]?.event_type).toBe("agent.registered");

    await Promise.all([signalA.close(), signalB.close()]);
  });

  it("a client on the same process as the mutation still gets the event via the plain local path (no signal involved when unconfigured)", () => {
    const broadcaster = new EventBroadcaster(storage, new Metrics());
    const client = fakeClient();
    broadcaster.subscribe(client, storage.latestEventCursor());

    storage.appendEvent({
      schema_version: 1,
      event_type: "agent.registered",
      occurred_at: storage.now(),
      namespace_id: "ns-1",
      repository_id: null,
      workflow_id: null,
      task_id: null,
      attempt_id: null,
      agent_id: "agent-local",
      workspace_session_id: null,
      correlation_id: null,
      causation_id: null,
      idempotency_key: null,
      payload: {},
      metadata: {},
    });
    broadcaster.notifyNew();

    expect(client.sent.length).toBe(1);
  });
});

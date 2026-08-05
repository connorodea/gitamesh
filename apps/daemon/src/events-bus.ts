import type { StorageAdapter, EventWithCursor } from "@gitamesh/core";
import type { Metrics } from "./metrics.js";

/**
 * Broadcasts newly-appended events to connected `/v1/events/stream`
 * WebSocket clients.
 *
 * Delivery semantics (documented for API consumers too, in
 * apps/daemon/README.md): this is **at-least-once**. On connect (and on
 * every reconnect), a client first replays every event after its `since`
 * cursor from durable storage, then receives live events as they are
 * appended. Because replay and the live-notify path share the same
 * cursor-based storage read (`listEventsSince`), a client can never see a
 * GAP — but if a client reconnects with a cursor equal to (not past) the
 * last event it fully processed, it may see that boundary event a second
 * time. Consumers should treat `event_id` as a dedupe key if exactly-once
 * processing matters to them.
 *
 * By default there is no external pub/sub here — for a single daemon
 * process (embedded-SQLite, or a lone `postgres`-driver process) an
 * in-process broadcaster that re-reads storage after every mutation is
 * sufficient and simpler than adding a message bus dependency.
 *
 * For **multi-process** deployments (several `postgres`-driver daemon
 * processes behind a load balancer, sharing one database), an optional
 * Redis signal can be wired in via `setSignalPublisher()` (see
 * `apps/daemon/src/redis-signal.ts`, opt-in via `GITAMESH_REDIS_URL`).
 * That signal carries no event data — it is purely a "something changed,
 * go re-check storage" ping. Storage remains the sole source of truth:
 * every process, on receiving a signal, re-runs exactly the same
 * `listEventsSince`-from-each-client's-own-cursor read that the local
 * `notifyNew()` path already does, so the at-least-once/no-gap guarantee
 * documented above is unaffected by whether Redis is configured, and
 * Redis message durability (or lack thereof) never matters — a dropped
 * signal just means a client catches up slightly later via its own
 * cursor-based replay/reconnect, not that it loses an event.
 */
export interface StreamClient {
  send(events: EventWithCursor[]): void;
  repositoryId?: string;
  cursor: number;
}

/** A cross-process "something changed" signal publisher (e.g. Redis pub/sub). */
export interface SignalPublisher {
  publish(): void;
}

export class EventBroadcaster {
  private readonly clients = new Set<StreamClient>();
  private signalPublisher: SignalPublisher | undefined;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly metrics: Metrics,
  ) {}

  /**
   * Wires an optional cross-process signal publisher. When set, every
   * locally-caused `notifyNew()` also publishes a lightweight signal so
   * other daemon processes subscribed to the same channel can re-check
   * storage and push to their own locally-connected clients. Pass
   * `undefined` to disable (the default, single-process behavior).
   */
  setSignalPublisher(publisher: SignalPublisher | undefined): void {
    this.signalPublisher = publisher;
  }

  /** Registers a client, replays everything after `sinceCursor`, and returns an unsubscribe function. */
  subscribe(client: Omit<StreamClient, "cursor"> & { cursor?: number }, sinceCursor: number): () => void {
    const full: StreamClient = { ...client, cursor: sinceCursor };
    const { events, nextCursor } = this.storage.listEventsSince(sinceCursor, {
      repositoryId: full.repositoryId,
    });
    if (events.length > 0) {
      full.send(events);
      full.cursor = nextCursor;
    }
    this.clients.add(full);
    this.metrics.wsClientConnected();
    return () => {
      this.clients.delete(full);
      this.metrics.wsClientDisconnected();
    };
  }

  /**
   * Call after every mutating operation that may have appended events.
   * Re-reads storage from each client's own cursor (cheap: an indexed
   * `rowid > ?` scan bounded by `limit`) and pushes anything new, then
   * (if a signal publisher is wired in) publishes a cross-process signal
   * so other daemon processes do the same for their own clients.
   */
  notifyNew(): void {
    this.pushToLocalClients();
    this.signalPublisher?.publish();
  }

  /**
   * Call when a cross-process signal arrives (e.g. a Redis message)
   * indicating some OTHER daemon process appended events. Re-reads
   * storage and pushes to this process's own locally-connected clients
   * only — deliberately does NOT re-publish a signal, which would create
   * an infinite ping-pong between processes.
   */
  notifyFromRemoteSignal(): void {
    this.pushToLocalClients();
  }

  private pushToLocalClients(): void {
    for (const client of this.clients) {
      const { events, nextCursor } = this.storage.listEventsSince(client.cursor, {
        repositoryId: client.repositoryId,
      });
      if (events.length > 0) {
        client.send(events);
        client.cursor = nextCursor;
      }
    }
  }
}

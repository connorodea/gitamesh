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
 * There is deliberately no external pub/sub (Redis, etc.) here — this
 * daemon is single-process/embedded-SQLite for this milestone (see
 * `packages/storage-sqlite/src/schema.ts`), so an in-process broadcaster
 * that re-reads storage after every mutation is sufficient and simpler
 * than adding a message bus dependency.
 */
export interface StreamClient {
  send(events: EventWithCursor[]): void;
  repositoryId?: string;
  cursor: number;
}

export class EventBroadcaster {
  private readonly clients = new Set<StreamClient>();

  constructor(
    private readonly storage: StorageAdapter,
    private readonly metrics: Metrics,
  ) {}

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
   * `rowid > ?` scan bounded by `limit`) and pushes anything new.
   */
  notifyNew(): void {
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

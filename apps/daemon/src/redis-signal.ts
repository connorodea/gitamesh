import { Redis } from "ioredis";
import type { SignalPublisher } from "./events-bus.js";

/**
 * Optional cross-process "something changed" signal, backed by Redis
 * pub/sub, for multi-process daemon deployments (see
 * `apps/daemon/src/events-bus.ts`'s doc comment for the full design
 * rationale). This module is only ever imported dynamically from
 * `index.ts` when `GITAMESH_REDIS_URL` is set, so a deployment that never
 * opts in never resolves `ioredis` at all — mirroring how
 * `@gitamesh/storage-postgres` is dynamic-imported only when
 * `GITAMESH_STORAGE_DRIVER=postgres`.
 *
 * `ioredis` was chosen because it is the standard, well-maintained Node
 * Redis client and — verified standalone before being adopted here, per
 * this project's "verify libraries before building on top of them"
 * discipline — is pure JS with no native build step (its dependency tree
 * is plain TS/JS: `@ioredis/commands`, `denque`, `redis-parser`, etc.),
 * and its basic `publish`/`subscribe` round-trip was confirmed working
 * against both `ioredis-mock` and a real local `redis-server` instance.
 *
 * The channel payload is a single fixed byte, not a serialized event.
 * Redis carries only "something changed, go re-check storage" — never
 * the actual event data — because Redis pub/sub has no delivery
 * durability guarantee (a message published while a subscriber is
 * disconnected is simply lost), which would be unacceptable for event
 * *data* but is perfectly fine for a *signal*: a dropped signal only
 * delays a client's live update until its next reconnect-triggered
 * replay from storage (which never loses anything — see
 * `events-bus.ts`), so storage remains the sole source of truth.
 */
const CHANNEL = "gitamesh:events:signal";
const SIGNAL_PAYLOAD = "1";

export interface RedisSignalLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface RedisSignalOptions {
  /** `redis://[:password@]host:port[/db]` */
  url: string;
  /** Invoked whenever a signal is received from another process. */
  onSignal: () => void;
  logger?: RedisSignalLogger;
}

export interface RedisSignal extends SignalPublisher {
  /** Resolves once the subscriber connection has confirmed its SUBSCRIBE. */
  ready: Promise<void>;
  close(): Promise<void>;
}

/**
 * Two separate connections are required: once a connection issues
 * `SUBSCRIBE`, ioredis (like Redis itself) restricts it to
 * subscribe-mode commands only, so the same connection can't also be
 * used to `PUBLISH`.
 */
export function createRedisSignal(options: RedisSignalOptions): RedisSignal {
  const { url, onSignal, logger } = options;

  const publisher = new Redis(url);
  const subscriber = new Redis(url);

  publisher.on("error", (err: Error) => {
    logger?.error({ err: err.message }, "redis signal publisher connection error");
  });
  subscriber.on("error", (err: Error) => {
    logger?.error({ err: err.message }, "redis signal subscriber connection error");
  });

  subscriber.on("message", (channel: string) => {
    if (channel === CHANNEL) onSignal();
  });

  const ready = subscriber.subscribe(CHANNEL).then(() => undefined);

  return {
    ready,
    publish(): void {
      // Fire-and-forget: a failed publish just means other processes
      // catch up on their next reconnect-triggered replay, same as a
      // dropped/undelivered pub/sub message would anyway.
      publisher.publish(CHANNEL, SIGNAL_PAYLOAD).catch((err: Error) => {
        logger?.error({ err: err.message }, "redis signal publish failed");
      });
    },
    async close(): Promise<void> {
      await Promise.allSettled([publisher.quit(), subscriber.quit()]);
    },
  };
}

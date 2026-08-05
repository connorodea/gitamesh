/**
 * `subscribeToEvents` connects to the daemon's `GET /v1/events/stream`
 * (see `apps/daemon/src/routes/events.ts` and its README section
 * "WebSocket reconnect / cursor semantics"). Every delivered message
 * carries a `cursor` field; reconnecting with `?since=<lastCursor>`
 * replays anything appended since, guaranteeing no gaps. Delivery is
 * **at-least-once**: reconnecting with a cursor equal to (not past) the
 * last event you saw may redeliver that boundary event — verified
 * against `apps/daemon/test/daemon.test.ts`'s "streams task lifecycle
 * events live, then replays with no gaps on reconnect" test, which
 * explicitly documents this as acceptable. Consumers that need
 * exactly-once processing should dedupe on `event_id`.
 *
 * The daemon only supports authenticating a WebSocket upgrade via the
 * `Authorization` header OR a `?token=` query param (the latter exists
 * *because* browser `WebSocket` clients cannot set custom headers on the
 * upgrade request — see `apps/daemon/src/auth.ts`'s `extractBearerToken`).
 * This SDK always uses `?token=` for the stream connection so the same
 * code path works in both Node and the browser without special-casing.
 */

/**
 * Minimal structural subset of the standard (browser + Node 24 global)
 * `WebSocket` that this module depends on. Anything satisfying this
 * shape can be injected via `wsImpl` — real `WebSocket`, the `ws` npm
 * package's client, or a test fake.
 */
export interface WebSocketLike {
  onopen: ((this: WebSocketLike, ev: unknown) => void) | null;
  onmessage: ((this: WebSocketLike, ev: { data: unknown }) => void) | null;
  onclose: ((this: WebSocketLike, ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((this: WebSocketLike, ev: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface StreamEvent {
  cursor: number;
  event_id: string;
  event_type: string;
  [key: string]: unknown;
}

export interface SubscribeToEventsOptions {
  /** Cursor to resume from. Omit (or 0) to start from the beginning of the log. */
  since?: number;
  /** Restrict the stream to one repository, matching the daemon's `?repositoryId=` filter. */
  repositoryId?: string;
  onEvent: (event: StreamEvent) => void;
  /** Called whenever the underlying socket closes, whether or not it will reconnect. */
  onDisconnect?: (info: { code?: number; reason?: string }) => void;
  /** Default `true` — reconnect automatically from the last-seen cursor after a disconnect. */
  autoReconnect?: boolean;
  /** Delay before each reconnect attempt. Default 1000ms. */
  reconnectDelayMs?: number;
  /** Injectable WebSocket constructor. Defaults to `globalThis.WebSocket`. */
  wsImpl?: WebSocketCtor;
  /** Injectable timer functions, for deterministic tests of the reconnect delay. */
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export interface EventSubscription {
  /** Closes the socket and cancels any pending reconnect. No more events will be delivered. */
  close(): void;
}

export function subscribeToEvents(
  baseUrl: string,
  token: string | null,
  options: SubscribeToEventsOptions,
): EventSubscription {
  const wsCtor = options.wsImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!wsCtor) {
    throw new Error(
      "No WebSocket implementation available: pass `wsImpl` explicitly (e.g. the `ws` package's client in Node, or a test fake).",
    );
  }
  const autoReconnect = options.autoReconnect ?? true;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  const timers = options.timers ?? { setTimeout, clearTimeout };

  let cursor = options.since ?? 0;
  let closedByCaller = false;
  let socket: WebSocketLike | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const buildUrl = (): string => {
    const wsBase = baseUrl.replace(/^http/, "ws");
    const url = new URL(`${wsBase}/v1/events/stream`);
    url.searchParams.set("since", String(cursor));
    if (options.repositoryId) url.searchParams.set("repositoryId", options.repositoryId);
    if (token) url.searchParams.set("token", token);
    return url.toString();
  };

  const connect = (): void => {
    const ws = new wsCtor(buildUrl());
    socket = ws;
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      const event = JSON.parse(raw) as StreamEvent;
      // Guaranteed no-gap resumption: always advance to the cursor of the
      // last event actually delivered, never past it.
      cursor = event.cursor;
      options.onEvent(event);
    };
    ws.onclose = (ev) => {
      options.onDisconnect?.({ code: ev?.code, reason: ev?.reason });
      if (!closedByCaller && autoReconnect) {
        reconnectTimer = timers.setTimeout(connect, reconnectDelayMs);
      }
    };
    ws.onerror = () => {
      // The WebSocket spec fires `close` after `error` for connection
      // failures, so reconnect scheduling lives entirely in `onclose`.
    };
  };

  connect();

  return {
    close: () => {
      closedByCaller = true;
      if (reconnectTimer !== undefined) timers.clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}

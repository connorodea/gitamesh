import type { WebSocketLike, WebSocketCtor } from "../../src/events.js";

/**
 * A test fake for the `WebSocketLike` shape `events.ts` depends on. Every
 * constructed instance is pushed onto `instances` so a test can grab the
 * most recent one and drive it manually (`emitMessage`, `simulateClose`)
 * to simulate server behavior without a real socket.
 */
export class FakeWebSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;

  constructor(
    public readonly url: string,
    private readonly instances: FakeWebSocket[],
  ) {
    instances.push(this);
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  /** Simulates the caller explicitly closing the socket (no reconnect should follow). */
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
  }

  /** Simulates an unexpected server-side disconnect (a reconnect should follow, if enabled). */
  simulateServerDisconnect(code = 1006, reason = "simulated disconnect"): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code, reason });
  }
}

export function createFakeWebSocketCtor(): { ctor: WebSocketCtor; instances: FakeWebSocket[] } {
  const instances: FakeWebSocket[] = [];
  const ctor = class extends FakeWebSocket {
    constructor(url: string) {
      super(url, instances);
    }
  } as unknown as WebSocketCtor;
  return { ctor, instances };
}

import type { FetchLike } from "../../src/client.js";

export interface RouteHandler {
  status?: number;
  body?: unknown;
  /** If set, the fetch call rejects (simulating a network-level failure). */
  networkError?: boolean;
}

export type RouteKey = `${"GET" | "POST"} ${string}`;

export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * A tiny fake `fetch` keyed by `"METHOD /path"` (path only, no query
 * string or host). Mirrors `packages/cli/test/support/fake-fetch.ts` so
 * the SDK's tests read the same way as the CLI's own proven pattern.
 * Supports registering a list of handlers per route key so a single test
 * can simulate a sequence of responses (e.g. idempotent replay calls).
 */
export function createFakeFetch(
  routes: Partial<Record<RouteKey, RouteHandler | RouteHandler[]>>,
): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const callIndex = new Map<RouteKey, number>();

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET") as "GET" | "POST";
    const key = `${method} ${url.pathname}` as RouteKey;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url: url.toString(), body, headers });

    const registered = routes[key];
    if (!registered) {
      throw new Error(`fake-fetch: no route registered for ${key}`);
    }
    let handler: RouteHandler;
    if (Array.isArray(registered)) {
      const idx = callIndex.get(key) ?? 0;
      handler = registered[Math.min(idx, registered.length - 1)] as RouteHandler;
      callIndex.set(key, idx + 1);
    } else {
      handler = registered;
    }

    if (handler.networkError) {
      throw new TypeError("fetch failed");
    }
    const status = handler.status ?? 200;
    const responseBody = handler.body ?? {};
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;

  return { fetchImpl, calls };
}

import type { FetchLike } from "../../src/client.js";

export interface RouteHandler {
  status?: number;
  body?: unknown;
  /** If set, the fetch call rejects (simulating a network-level failure). */
  networkError?: boolean;
}

export type RouteKey = `${"GET" | "POST"} ${string}`;

/**
 * A tiny fake `fetch` keyed by `"METHOD /path"` (path only, no query
 * string or host — the fake matches on pathname). Used to unit-test the
 * CLI's HTTP client and command wiring without a real daemon or network.
 */
export function createFakeFetch(routes: Partial<Record<RouteKey, RouteHandler>>): {
  fetchImpl: FetchLike;
  calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }>;
} {
  const calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> =
    [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET") as "GET" | "POST";
    const key = `${method} ${url.pathname}` as RouteKey;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url: url.toString(), body, headers });

    const handler = routes[key];
    if (!handler) {
      throw new Error(`fake-fetch: no route registered for ${key}`);
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

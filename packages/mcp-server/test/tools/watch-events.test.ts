import { describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/internal-client.js";
import {
  handleWatchEvents,
  WatchEventsInputSchema,
  WatchEventsOutputSchema,
} from "../../src/tools/watch-events.js";
import { createFakeFetch } from "../support/fake-fetch.js";
import { fakeEvent } from "../support/fixtures.js";

describe("gitamesh_watch_events", () => {
  it("fetches a cursor page via GET /v1/events (not the WebSocket stream)", async () => {
    const { fetchImpl, calls } = createFakeFetch({
      "GET /v1/events": { body: { events: [fakeEvent()], nextCursor: 5 } },
    });
    const client = new DaemonClient({ baseUrl: "http://127.0.0.1:8787", token: null, fetchImpl });

    const input = WatchEventsInputSchema.parse({ since: 1, limit: 50 });
    const result = await handleWatchEvents(input, client);
    const parsed = WatchEventsOutputSchema.parse(result);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.events).toHaveLength(1);
      expect(parsed.nextCursor).toBe(5);
    }
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/events");
    expect(url.searchParams.get("since")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("returns a structured error, not a throw, when the daemon is unreachable", async () => {
    const client = new DaemonClient({
      baseUrl: "http://127.0.0.1:8787",
      token: null,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });

    const result = await handleWatchEvents(WatchEventsInputSchema.parse({}), client);
    expect(result.ok).toBe(false);
  });

  it("rejects a limit above 1000 via schema validation", () => {
    expect(() => WatchEventsInputSchema.parse({ limit: 5000 })).toThrow();
  });
});

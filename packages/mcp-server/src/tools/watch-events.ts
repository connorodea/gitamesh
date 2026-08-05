import { z } from "zod";
import { EventEnvelopeSchema } from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

/**
 * `gitamesh_watch_events` — DESIGN NOTE on why this is a page fetch, not a
 * live subscription.
 *
 * The daemon exposes two ways to read the event log
 * (`apps/daemon/src/routes/events.ts`): `GET /v1/events` (a one-shot cursor
 * page) and `GET /v1/events/stream` (a long-lived WebSocket that replays
 * from a cursor and then pushes new events as they happen).
 *
 * An MCP tool call is a single request/response round trip — the calling
 * agent invokes the tool, waits for a result, and moves on. There is no
 * standard MCP mechanism for a tool call to "stay open" and keep pushing
 * results after it returns; holding a WebSocket connection open inside a
 * tool handler and blocking would either time out the calling agent's tool
 * call or require inventing a non-standard streaming convention on top of
 * MCP, which is out of scope here. So this tool intentionally implements
 * "watch" as "fetch events since a cursor", matching `GET /v1/events`
 * exactly: pass the `nextCursor` from one call as `since` on the next to
 * poll incrementally with no gaps (same at-least-once/no-skip semantics
 * documented in `apps/daemon/README.md`'s "WebSocket reconnect / cursor
 * semantics" section, since both routes share the same underlying
 * `listEventsSince` storage method).
 *
 * A genuinely live push mechanism (the calling agent being notified the
 * moment a new event lands, without polling) belongs either to a future
 * daemon-side push capability the AGENT RUNTIME subscribes to directly, or
 * a separate long-running client process — not this stdio MCP tool call.
 */
export const WatchEventsInputSchema = z.object({
  since: z.number().int().nonnegative().optional().describe("Cursor from a previous call's nextCursor; omit to start from the beginning."),
  repositoryId: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});
export type WatchEventsInput = z.infer<typeof WatchEventsInputSchema>;

const WatchEventsSuccessSchema = z.object({
  ok: z.literal(true),
  events: z.array(EventEnvelopeSchema),
  nextCursor: z.number().int().nonnegative(),
});
export type WatchEventsSuccess = z.infer<typeof WatchEventsSuccessSchema>;

export const WatchEventsOutputSchema = z.union([WatchEventsSuccessSchema, ToolErrorSchema]);
export type WatchEventsOutput = WatchEventsSuccess | ToolError;

export async function handleWatchEvents(
  input: WatchEventsInput,
  client: DaemonClient,
): Promise<WatchEventsOutput> {
  const result = await client.listEventsSince({
    since: input.since,
    repositoryId: input.repositoryId,
    limit: input.limit,
  });
  return fromDaemonResult(result, (data) => {
    const { events, nextCursor } = data as { events: unknown[]; nextCursor: number };
    return {
      ok: true as const,
      events: events as z.infer<typeof EventEnvelopeSchema>[],
      nextCursor,
    };
  });
}

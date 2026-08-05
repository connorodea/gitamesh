import { z } from "zod";
import { TaskAttemptSchema, ResourceClaimSchema } from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

/**
 * The daemon's heartbeat route is nested under a task
 * (`POST /v1/tasks/:taskId/heartbeat`), but the body is entirely keyed off
 * `attemptId` + `fencingToken` — `:taskId` in the URL is not otherwise
 * validated against the attempt. This tool takes `taskId` as an explicit
 * input (rather than trying to look it up) to keep the daemon call a
 * single round trip; callers already have it from `gitamesh_claim_task`'s
 * result.
 */
export const HeartbeatInputSchema = z.object({
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  fencingToken: z.number().int().nonnegative(),
  leaseDurationMs: z.number().int().positive().optional(),
});
export type HeartbeatInput = z.infer<typeof HeartbeatInputSchema>;

const HeartbeatSuccessSchema = z.object({
  ok: z.literal(true),
  attempt: TaskAttemptSchema,
  resourceClaims: z.array(ResourceClaimSchema),
});
export type HeartbeatSuccess = z.infer<typeof HeartbeatSuccessSchema>;

export const HeartbeatOutputSchema = z.union([HeartbeatSuccessSchema, ToolErrorSchema]);
export type HeartbeatOutput = HeartbeatSuccess | ToolError;

export async function handleHeartbeat(
  input: HeartbeatInput,
  client: DaemonClient,
): Promise<HeartbeatOutput> {
  const result = await client.heartbeatTask(input.taskId, {
    attemptId: input.attemptId,
    fencingToken: input.fencingToken,
    leaseDurationMs: input.leaseDurationMs,
  });
  return fromDaemonResult(result, (data) => {
    const { attempt, resourceClaims } = data as { attempt: unknown; resourceClaims: unknown[] };
    return {
      ok: true as const,
      attempt: attempt as z.infer<typeof TaskAttemptSchema>,
      resourceClaims: resourceClaims as z.infer<typeof ResourceClaimSchema>[],
    };
  });
}

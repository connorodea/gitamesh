import { z } from "zod";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

const id = z.string().min(1);

/**
 * `POST /v1/tasks/:taskId/progress`: accepted only from the task's current
 * attempt (attemptId + fencingToken from `gitamesh_claim_task`) while its lease
 * is active. It never renews the lease; use `gitamesh_heartbeat` for that.
 */
export const ReportProgressInputSchema = z.object({
  taskId: id,
  attemptId: id,
  fencingToken: z.number().int().nonnegative(),
  summary: z.string().trim().min(1).max(8_000),
  phase: z.enum(["working", "blocked", "verifying", "ready_for_review"]),
  evidence: z.array(z.string().trim().min(1).max(2_000)).max(20).optional(),
});
export type ReportProgressInput = z.infer<typeof ReportProgressInputSchema>;

export const ReportProgressOutputSchema = z.union([
  z.object({ ok: z.literal(true), progress: z.record(z.string(), z.unknown()), replayed: z.boolean() }),
  ToolErrorSchema,
]);

export async function handleReportProgress(
  input: ReportProgressInput,
  client: DaemonClient,
): Promise<{ ok: true; progress: Record<string, unknown>; replayed: boolean } | ToolError> {
  const result = await client.reportProgress(input.taskId, {
    attemptId: input.attemptId,
    fencingToken: input.fencingToken,
    summary: input.summary,
    phase: input.phase,
    evidence: input.evidence ?? [],
  });
  return fromDaemonResult(result, (data) => ({
    ok: true as const,
    progress: data.progress as Record<string, unknown>,
    replayed: data.replayed,
  }));
}

export const ListTaskProgressInputSchema = z.object({
  taskId: id,
  since: z.number().int().nonnegative().optional().describe("Event cursor; pass nextCursor from the previous call."),
  limit: z.number().int().positive().max(500).optional(),
});
export type ListTaskProgressInput = z.infer<typeof ListTaskProgressInputSchema>;

export const ListTaskProgressOutputSchema = z.union([
  z.object({ ok: z.literal(true), events: z.array(z.record(z.string(), z.unknown())), nextCursor: z.number() }),
  ToolErrorSchema,
]);

export async function handleListTaskProgress(
  input: ListTaskProgressInput,
  client: DaemonClient,
): Promise<{ ok: true; events: Record<string, unknown>[]; nextCursor: number } | ToolError> {
  const result = await client.listTaskProgress(input.taskId, { since: input.since, limit: input.limit });
  return fromDaemonResult(result, (data) => ({
    ok: true as const,
    events: data.events as Record<string, unknown>[],
    nextCursor: data.nextCursor,
  }));
}

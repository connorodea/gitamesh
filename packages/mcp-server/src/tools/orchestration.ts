import { z } from "zod";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

const id = z.string().min(1);
const record = z.record(z.string(), z.unknown());

/**
 * Async multi-agent orchestration (ADR-0002). The orchestrator holds a parent
 * task, fans out with gitamesh_dispatch_subtasks, keeps working or calls
 * gitamesh_wait_for_subtasks, reads results with gitamesh_get_subtask_results,
 * and stops stragglers with gitamesh_cancel_subtasks. Workers use the normal
 * claim / heartbeat / complete (with `result`) / fail tools on each child.
 */
export const DispatchSubtasksInputSchema = z.object({
  taskId: id.describe("The parent task the orchestrator holds."),
  subtasks: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        priority: z.number().optional(),
        requiredCapabilities: z.array(z.string()).optional(),
        branch: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
  workflowId: z.string().min(1).optional().describe("Defaults to the parent's workflow."),
  deadlineAt: z.string().datetime().optional().describe("Shared deadline; unsettled children past it show as overdue."),
});
export type DispatchSubtasksInput = z.infer<typeof DispatchSubtasksInputSchema>;

export const DispatchSubtasksOutputSchema = z.union([
  z.object({ ok: z.literal(true), subtasks: z.array(record), replayed: z.boolean() }),
  ToolErrorSchema,
]);

export async function handleDispatchSubtasks(
  input: DispatchSubtasksInput,
  client: DaemonClient,
): Promise<{ ok: true; subtasks: Record<string, unknown>[]; replayed: boolean } | ToolError> {
  const result = await client.dispatchSubtasks(input.taskId, {
    subtasks: input.subtasks.map((s) => ({
      title: s.title,
      ...(s.description !== undefined ? { description: s.description } : {}),
      ...(s.priority !== undefined ? { priority: s.priority } : {}),
      ...(s.requiredCapabilities !== undefined ? { required_capabilities: s.requiredCapabilities } : {}),
      ...(s.branch !== undefined ? { branch: s.branch } : {}),
    })),
    ...(input.workflowId ? { workflow_id: input.workflowId } : {}),
    ...(input.deadlineAt ? { deadline_at: input.deadlineAt } : {}),
  });
  return fromDaemonResult(result, (data) => ({
    ok: true as const,
    subtasks: data.subtasks as Record<string, unknown>[],
    replayed: data.replayed,
  }));
}

export const SubtaskResultsInputSchema = z.object({ taskId: id.describe("The parent task.") });
export type SubtaskResultsInput = z.infer<typeof SubtaskResultsInputSchema>;

export const SubtaskResultsOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: record }),
  ToolErrorSchema,
]);

export async function handleGetSubtaskResults(
  input: SubtaskResultsInput,
  client: DaemonClient,
): Promise<{ ok: true; summary: Record<string, unknown> } | ToolError> {
  const result = await client.getSubtaskResults(input.taskId);
  return fromDaemonResult(result, (data) => ({ ok: true as const, summary: data }));
}

export const WaitForSubtasksInputSchema = z.object({
  taskId: id.describe("The parent task."),
  until: z.enum(["all", "any"]).optional().describe('"all" (default): every child settled. "any": first completed child.'),
  failFast: z.boolean().optional().describe("Also wake on the first child that failed for good."),
  timeoutMs: z.number().int().min(0).max(120_000).optional().describe("Default 30000. A timeout is a normal result, not an error."),
});
export type WaitForSubtasksInput = z.infer<typeof WaitForSubtasksInputSchema>;

export const WaitForSubtasksOutputSchema = z.union([
  z.object({ ok: z.literal(true), woke: z.string(), waitedMs: z.number(), summary: record }),
  ToolErrorSchema,
]);

export async function handleWaitForSubtasks(
  input: WaitForSubtasksInput,
  client: DaemonClient,
): Promise<{ ok: true; woke: string; waitedMs: number; summary: Record<string, unknown> } | ToolError> {
  const result = await client.waitForSubtasks(input.taskId, {
    ...(input.until ? { until: input.until } : {}),
    ...(input.failFast !== undefined ? { fail_fast: input.failFast } : {}),
    ...(input.timeoutMs !== undefined ? { timeout_ms: input.timeoutMs } : {}),
  });
  return fromDaemonResult(result, (data) => ({
    ok: true as const,
    woke: data.woke,
    waitedMs: data.waited_ms,
    summary: data.summary,
  }));
}

export const CancelSubtasksInputSchema = z.object({ taskId: id.describe("The parent task.") });
export type CancelSubtasksInput = z.infer<typeof CancelSubtasksInputSchema>;

export const CancelSubtasksOutputSchema = z.union([
  z.object({ ok: z.literal(true), cancelled: z.array(record), summary: record }),
  ToolErrorSchema,
]);

export async function handleCancelSubtasks(
  input: CancelSubtasksInput,
  client: DaemonClient,
): Promise<{ ok: true; cancelled: Record<string, unknown>[]; summary: Record<string, unknown> } | ToolError> {
  const result = await client.cancelSubtasks(input.taskId);
  return fromDaemonResult(result, (data) => ({
    ok: true as const,
    cancelled: data.cancelled as Record<string, unknown>[],
    summary: data.summary,
  }));
}

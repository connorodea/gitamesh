import { z } from "zod";
import { TaskAttemptSchema, TaskSchema } from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

export const CompleteTaskInputSchema = z.object({
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  fencingToken: z.number().int().nonnegative(),
  result: z.record(z.string(), z.unknown()).optional(),
});
export type CompleteTaskInput = z.infer<typeof CompleteTaskInputSchema>;

const CompleteTaskSuccessSchema = z.object({
  ok: z.literal(true),
  attempt: TaskAttemptSchema,
  task: TaskSchema,
  result: z.record(z.string(), z.unknown()).optional(),
  replayed: z.boolean(),
});
export type CompleteTaskSuccess = z.infer<typeof CompleteTaskSuccessSchema>;

export const CompleteTaskOutputSchema = z.union([CompleteTaskSuccessSchema, ToolErrorSchema]);
export type CompleteTaskOutput = CompleteTaskSuccess | ToolError;

export async function handleCompleteTask(
  input: CompleteTaskInput,
  client: DaemonClient,
): Promise<CompleteTaskOutput> {
  const daemonResult = await client.completeTask(input.taskId, {
    attemptId: input.attemptId,
    fencingToken: input.fencingToken,
    result: input.result,
  });
  return fromDaemonResult(daemonResult, (data) => {
    const { attempt, task, result, replayed } = data as {
      attempt: unknown;
      task: unknown;
      result: Record<string, unknown> | undefined;
      replayed: boolean;
    };
    return {
      ok: true as const,
      attempt: attempt as z.infer<typeof TaskAttemptSchema>,
      task: task as z.infer<typeof TaskSchema>,
      result,
      replayed,
    };
  });
}

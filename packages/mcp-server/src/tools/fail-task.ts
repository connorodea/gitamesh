import { z } from "zod";
import { TaskAttemptSchema, TaskSchema } from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

export const FailTaskInputSchema = z.object({
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  fencingToken: z.number().int().nonnegative(),
  error: z.string().min(1),
});
export type FailTaskInput = z.infer<typeof FailTaskInputSchema>;

const FailTaskSuccessSchema = z.object({
  ok: z.literal(true),
  attempt: TaskAttemptSchema,
  task: TaskSchema,
  replayed: z.boolean(),
});
export type FailTaskSuccess = z.infer<typeof FailTaskSuccessSchema>;

export const FailTaskOutputSchema = z.union([FailTaskSuccessSchema, ToolErrorSchema]);
export type FailTaskOutput = FailTaskSuccess | ToolError;

export async function handleFailTask(
  input: FailTaskInput,
  client: DaemonClient,
): Promise<FailTaskOutput> {
  const daemonResult = await client.failTask(input.taskId, {
    attemptId: input.attemptId,
    fencingToken: input.fencingToken,
    error: input.error,
  });
  return fromDaemonResult(daemonResult, (data) => {
    const { attempt, task, replayed } = data as { attempt: unknown; task: unknown; replayed: boolean };
    return {
      ok: true as const,
      attempt: attempt as z.infer<typeof TaskAttemptSchema>,
      task: task as z.infer<typeof TaskSchema>,
      replayed,
    };
  });
}

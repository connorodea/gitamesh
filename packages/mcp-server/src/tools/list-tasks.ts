import { z } from "zod";
import { TaskSchema, TaskStateSchema } from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

export const ListTasksInputSchema = z.object({
  repositoryId: z.string().optional(),
  status: TaskStateSchema.optional(),
});
export type ListTasksInput = z.infer<typeof ListTasksInputSchema>;

const ListTasksSuccessSchema = z.object({
  ok: z.literal(true),
  tasks: z.array(TaskSchema),
});
export type ListTasksSuccess = z.infer<typeof ListTasksSuccessSchema>;

export const ListTasksOutputSchema = z.union([ListTasksSuccessSchema, ToolErrorSchema]);
export type ListTasksOutput = ListTasksSuccess | ToolError;

export async function handleListTasks(
  input: ListTasksInput,
  client: DaemonClient,
): Promise<ListTasksOutput> {
  const result = await client.listTasks({
    repositoryId: input.repositoryId,
    status: input.status,
  });
  return fromDaemonResult(result, (data) => {
    const { tasks } = data as { tasks: unknown[] };
    return { ok: true as const, tasks: tasks as z.infer<typeof TaskSchema>[] };
  });
}

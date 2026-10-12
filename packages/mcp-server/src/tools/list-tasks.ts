import { z } from "zod";
import { TaskSchema, TaskStateSchema } from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

export const ListTasksInputSchema = z.object({
  repositoryId: z.string().optional(),
  status: TaskStateSchema.optional(),
  /** Only tasks this agent currently holds. */
  agentId: z.string().min(1).optional(),
  /** Only tasks nobody holds that still wait to be claimed. */
  unclaimed: z.boolean().optional(),
});
export type ListTasksInput = z.infer<typeof ListTasksInputSchema>;

/** A task as the daemon lists it: the record plus who holds it and whether it can be claimed. */
export const TaskViewSchema = TaskSchema.extend({
  owner: z
    .object({
      agent_id: z.string(),
      display_name: z.string(),
      attempt_id: z.string(),
      heartbeat_at: z.string(),
      expires_at: z.string(),
    })
    .nullable()
    .optional(),
  readiness: z.enum(["ready", "blocked"]).nullable().optional(),
  blocked_by: z.array(z.string()).optional(),
});
export type TaskView = z.infer<typeof TaskViewSchema>;

const ListTasksSuccessSchema = z.object({
  ok: z.literal(true),
  tasks: z.array(TaskViewSchema),
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
    agentId: input.agentId,
    unclaimed: input.unclaimed ? "true" : undefined,
  });
  return fromDaemonResult(result, (data) => {
    const { tasks } = data as { tasks: unknown[] };
    return { ok: true as const, tasks: tasks as TaskView[] };
  });
}

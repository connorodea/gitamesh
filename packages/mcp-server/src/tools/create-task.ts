import { z } from "zod";
import { TaskSchema, JoinPolicySchema } from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

export const CreateTaskInputSchema = z.object({
  repositoryId: z.string().min(1),
  workflowId: z.string().optional(),
  parentTaskId: z.string().nullable().optional(),
  title: z.string().min(1),
  description: z.string().default(""),
  priority: z.number().default(0),
  requiredCapabilities: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  joinPolicy: JoinPolicySchema.default("all"),
  baseSha: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  deadlineAt: z.string().datetime().nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

const CreateTaskSuccessSchema = z.object({
  ok: z.literal(true),
  task: TaskSchema,
  replayed: z.boolean(),
});
export type CreateTaskSuccess = z.infer<typeof CreateTaskSuccessSchema>;

export const CreateTaskOutputSchema = z.union([CreateTaskSuccessSchema, ToolErrorSchema]);
export type CreateTaskOutput = CreateTaskSuccess | ToolError;

export async function handleCreateTask(
  input: CreateTaskInput,
  client: DaemonClient,
): Promise<CreateTaskOutput> {
  const result = await client.createTask({
    repository_id: input.repositoryId,
    workflow_id: input.workflowId,
    parent_task_id: input.parentTaskId ?? null,
    title: input.title,
    description: input.description,
    priority: input.priority,
    required_capabilities: input.requiredCapabilities,
    dependencies: input.dependencies,
    join_policy: input.joinPolicy,
    base_sha: input.baseSha ?? null,
    branch: input.branch ?? null,
    deadline_at: input.deadlineAt ?? null,
  });
  return fromDaemonResult(result, (data) => {
    const { task, replayed } = data as { task: unknown; replayed: boolean };
    return { ok: true as const, task: task as z.infer<typeof TaskSchema>, replayed };
  });
}

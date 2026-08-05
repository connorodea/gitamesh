import { z } from "zod";
import { TASK_STATES } from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, type ToolError } from "../tool-result.js";

export const StatusInputSchema = z.object({
  repositoryId: z
    .string()
    .optional()
    .describe("Restrict task/claim counts to this repository. Omit for an all-repositories count."),
});
export type StatusInput = z.infer<typeof StatusInputSchema>;

const TaskCountsSchema = z.object({
  open: z.number().int(),
  byStatus: z.record(z.enum(TASK_STATES), z.number().int()),
});

const StatusSuccessSchema = z.object({
  ok: z.literal(true),
  daemon: z.object({
    reachable: z.boolean(),
    status: z.string().optional(),
  }),
  tasks: TaskCountsSchema.optional(),
  claims: z
    .object({
      active: z.number().int(),
    })
    .optional(),
  config: z.object({
    daemonUrl: z.string(),
  }),
});
export type StatusSuccess = z.infer<typeof StatusSuccessSchema>;

export const StatusOutputSchema = z.union([StatusSuccessSchema, ToolErrorSchema]);
export type StatusOutput = StatusSuccess | ToolError;

const OPEN_TASK_STATES = new Set<string>([
  "pending",
  "queued",
  "claiming",
  "running",
  "blocked",
  "awaiting_approval",
]);

function summarizeTasks(list: Array<{ status: string }>): z.infer<typeof TaskCountsSchema> {
  const byStatus: Record<string, number> = {};
  for (const state of TASK_STATES) byStatus[state] = 0;
  let open = 0;
  for (const task of list) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    if (OPEN_TASK_STATES.has(task.status)) open += 1;
  }
  return { open, byStatus: byStatus as z.infer<typeof TaskCountsSchema>["byStatus"] };
}

/**
 * `gitamesh_status` never surfaces a "tool failed" `ok: false` result for
 * an unreachable daemon — that IS the status being reported, not an error
 * in the reporting itself. Only genuinely unexpected situations (none
 * currently) would return `ToolError`; the return type keeps that door
 * open for consistency with every other tool.
 */
export async function handleStatus(
  input: StatusInput,
  client: DaemonClient,
  daemonUrl: string,
): Promise<StatusOutput> {
  const health = await client.healthz();
  if (!health.ok) {
    return {
      ok: true,
      daemon: { reachable: false },
      config: { daemonUrl },
    };
  }

  const query = input.repositoryId ? { repositoryId: input.repositoryId } : undefined;
  const [tasksResult, claimsResult] = await Promise.all([
    client.listTasks(query),
    client.listClaims(query),
  ]);

  const tasks = tasksResult.ok
    ? summarizeTasks((tasksResult.data as { tasks: Array<{ status: string }> }).tasks)
    : undefined;
  const claims = claimsResult.ok
    ? { active: (claimsResult.data as { claims: unknown[] }).claims.length }
    : undefined;

  return {
    ok: true,
    daemon: { reachable: true, status: (health.data as { status: string }).status },
    tasks,
    claims,
    config: { daemonUrl },
  };
}

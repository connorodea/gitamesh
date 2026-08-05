import { z } from "zod";
import { TaskAttemptSchema, ResourceClaimSchema, ResourceTypeSchema, ResourceModeSchema } from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

const RequiredResourceInputSchema = z.object({
  resourceType: ResourceTypeSchema,
  resourceKey: z.string().min(1),
  mode: ResourceModeSchema,
});

export const ClaimTaskInputSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  workspaceSessionId: z.string().min(1),
  requiredResources: z.array(RequiredResourceInputSchema).default([]),
});
export type ClaimTaskInput = z.infer<typeof ClaimTaskInputSchema>;

const ClaimTaskSuccessSchema = z.object({
  ok: z.literal(true),
  attempt: TaskAttemptSchema,
  fencingToken: z.number().int().nonnegative(),
  resourceClaims: z.array(ResourceClaimSchema),
  replayed: z.boolean(),
});
export type ClaimTaskSuccess = z.infer<typeof ClaimTaskSuccessSchema>;

/**
 * On a 409 (`task-already-claimed`, `resource-conflict`, or
 * `task-not-claimable` — see `apps/daemon/src/routes/tasks.ts`'s
 * `isClaimConflict`), this tool returns the SAME `ToolErrorSchema` shape
 * every other tool uses for a daemon-level failure — it is not a special
 * case at the schema level. What makes claim conflicts notable is only
 * that they are the EXPECTED, common-case failure mode of this specific
 * tool (another agent got there first), so callers should treat `ok:
 * false` here as a normal "try a different task" signal rather than an
 * exceptional condition — never a thrown exception, per the task spec.
 */
export const ClaimTaskOutputSchema = z.union([ClaimTaskSuccessSchema, ToolErrorSchema]);
export type ClaimTaskOutput = ClaimTaskSuccess | ToolError;

export async function handleClaimTask(
  input: ClaimTaskInput,
  client: DaemonClient,
): Promise<ClaimTaskOutput> {
  const result = await client.claimTask(input.taskId, {
    agentId: input.agentId,
    workspaceSessionId: input.workspaceSessionId,
    requiredResources: input.requiredResources,
  });
  return fromDaemonResult(result, (data) => {
    const { attempt, fencingToken, resourceClaims, replayed } = data as {
      attempt: unknown;
      fencingToken: number;
      resourceClaims: unknown[];
      replayed: boolean;
    };
    return {
      ok: true as const,
      attempt: attempt as z.infer<typeof TaskAttemptSchema>,
      fencingToken,
      resourceClaims: resourceClaims as z.infer<typeof ResourceClaimSchema>[],
      replayed,
    };
  });
}

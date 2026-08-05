import { z } from "zod";
import { ResourceClaimSchema } from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

export const ListClaimsInputSchema = z.object({
  repositoryId: z.string().optional(),
});
export type ListClaimsInput = z.infer<typeof ListClaimsInputSchema>;

const ListClaimsSuccessSchema = z.object({
  ok: z.literal(true),
  claims: z.array(ResourceClaimSchema),
});
export type ListClaimsSuccess = z.infer<typeof ListClaimsSuccessSchema>;

export const ListClaimsOutputSchema = z.union([ListClaimsSuccessSchema, ToolErrorSchema]);
export type ListClaimsOutput = ListClaimsSuccess | ToolError;

export async function handleListClaims(
  input: ListClaimsInput,
  client: DaemonClient,
): Promise<ListClaimsOutput> {
  const result = await client.listClaims({ repositoryId: input.repositoryId });
  return fromDaemonResult(result, (data) => {
    const { claims } = data as { claims: unknown[] };
    return { ok: true as const, claims: claims as z.infer<typeof ResourceClaimSchema>[] };
  });
}

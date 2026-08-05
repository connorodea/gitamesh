import { z } from "zod";
import { AgentSchema, AgentRuntimeSchema } from "@gitamesh/protocol";
import type { DaemonClient } from "../internal-client.js";
import { ToolErrorSchema, fromDaemonResult, type ToolError } from "../tool-result.js";

/**
 * `apps/daemon`'s `POST /v1/agents` always mints its own `agent_id`
 * server-side (`storage.generateId("agent")`) — there is no route
 * parameter to force a caller-chosen id. This tool's `agentId` input is
 * therefore a caller-supplied HINT/label only (stored in the created
 * agent's `metadata.requested_agent_id`), not the id that ends up on the
 * returned `Agent` record. Callers must read `agent.agent_id` from the
 * result for the real, daemon-assigned id.
 */
export const RegisterAgentInputSchema = z.object({
  agentId: z
    .string()
    .optional()
    .describe(
      "Optional caller-chosen label, recorded as metadata.requested_agent_id. " +
        "The daemon always assigns the real agent_id server-side; read it from the result.",
    ),
  displayName: z.string().min(1),
  runtime: AgentRuntimeSchema,
  capabilities: z.array(z.string()).default([]),
  namespaceId: z.string().optional(),
});
export type RegisterAgentInput = z.infer<typeof RegisterAgentInputSchema>;

const RegisterAgentSuccessSchema = z.object({
  ok: z.literal(true),
  agent: AgentSchema,
  replayed: z.boolean(),
});
export type RegisterAgentSuccess = z.infer<typeof RegisterAgentSuccessSchema>;

export const RegisterAgentOutputSchema = z.union([RegisterAgentSuccessSchema, ToolErrorSchema]);
export type RegisterAgentOutput = RegisterAgentSuccess | ToolError;

export async function handleRegisterAgent(
  input: RegisterAgentInput,
  client: DaemonClient,
): Promise<RegisterAgentOutput> {
  const result = await client.registerAgent({
    namespace_id: input.namespaceId,
    display_name: input.displayName,
    runtime: input.runtime,
    capabilities: input.capabilities,
    metadata: input.agentId ? { requested_agent_id: input.agentId } : {},
  });
  return fromDaemonResult(result, (data) => {
    const { agent, replayed } = data as { agent: unknown; replayed: boolean };
    return { ok: true as const, agent: agent as z.infer<typeof AgentSchema>, replayed };
  });
}

import { z } from "zod";

/**
 * `gitamesh_enqueue_integration` — HONEST "NOT SUPPORTED YET" TOOL.
 *
 * The product spec for this MCP server lists an integration-candidate
 * enqueue tool. But as of this package's implementation:
 *   - `apps/daemon` has no integration-candidate routes at all (confirmed
 *     by reading its route source under `apps/daemon/src/routes/` and its
 *     own README, which lists "Integration-candidate routes" under "What's
 *     NOT implemented", explaining that `packages/core` has no
 *     integration-candidate lifecycle — only the unused `IntegrationState`
 *     enum exists in `packages/protocol`).
 *   - There is therefore no endpoint this tool could call.
 *
 * Per this task's instruction, the tool stays REGISTERED (so an agent
 * discovering tools via MCP sees it exists and what it's for) but always
 * returns a structured, honest "not supported yet" result instead of
 * either calling a nonexistent daemon route or silently disappearing from
 * the tool list. This is intentionally NOT modeled as a `ToolError` from
 * `tool-result.ts` — it isn't a daemon-call failure, it's a capability gap
 * in the daemon itself, so it gets its own explicit `supported: false`
 * discriminant rather than reusing the request-failure error shape.
 */

export const EnqueueIntegrationInputSchema = z.object({
  taskId: z.string().min(1).describe("The task whose completed work would become an integration candidate."),
  repositoryId: z.string().min(1),
  branch: z.string().optional(),
  notes: z.string().optional(),
});
export type EnqueueIntegrationInput = z.infer<typeof EnqueueIntegrationInputSchema>;

export const EnqueueIntegrationOutputSchema = z.object({
  ok: z.literal(true),
  supported: z.literal(false),
  reason: z.string(),
});
export type EnqueueIntegrationOutput = z.infer<typeof EnqueueIntegrationOutputSchema>;

export function handleEnqueueIntegration(
  _input: EnqueueIntegrationInput,
): EnqueueIntegrationOutput {
  return {
    ok: true,
    supported: false,
    reason:
      "apps/daemon does not implement an integration-candidate lifecycle yet — " +
      "packages/core has no integration-candidate state machine, and packages/protocol's " +
      "IntegrationState enum is currently unconsumed by any route. This tool is registered " +
      "so it is discoverable, but there is no daemon endpoint to enqueue an integration " +
      "candidate against. It will start working once the daemon grows that lifecycle.",
  };
}

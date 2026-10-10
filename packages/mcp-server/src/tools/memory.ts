import { z } from "zod";
import { LoopMemClient, LoopMemError, MemoryKindSchema, memoryNamespace } from "../loopmem-client.js";
import { invalidInputError, type ToolError } from "../tool-result.js";

const IdentifierSchema = z.string().min(1).max(4096).refine((value) => value.trim().length > 0 && !value.includes("\0"));
const ProvenanceIdSchema = z.string().min(1).max(256).refine((value) =>
  value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const BaseInput = { repositoryId: IdentifierSchema };
export const MemoryInitInputSchema = z.object({ ...BaseInput, goal: z.string().min(1).optional() });
export const MemoryRememberInputSchema = z.object({
  ...BaseInput,
  kind: MemoryKindSchema,
  text: z.string().min(1).refine((value) => value.trim().length > 0 && !value.includes("\0")),
  agentId: ProvenanceIdSchema,
  workspaceSessionId: ProvenanceIdSchema,
  evidence: z.array(z.string().refine((value) => !value.includes("\0"))).optional(),
  supersedes: z.number().int().positive().safe().optional(),
  taskId: IdentifierSchema.optional(),
  attemptId: IdentifierSchema.optional(),
});
export const MemoryRecallInputSchema = z.object({
  ...BaseInput,
  query: z.string().refine((value) => !value.includes("\0")).optional(),
  kind: MemoryKindSchema.optional(),
  agentId: ProvenanceIdSchema.optional(),
  workspaceSessionId: ProvenanceIdSchema.optional(),
  includeSuperseded: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export const MemoryGetInputSchema = z.object({ ...BaseInput, id: z.number().int().positive().safe() });
export const MemoryContextInputSchema = z.object(BaseInput);

async function withMemory<T extends Record<string, unknown>>(
  client: LoopMemClient | undefined,
  action: (client: LoopMemClient) => Promise<T>,
): Promise<({ ok: true } & T) | ToolError> {
  if (!client) return { ok: false, error: {
    type: "https://gitamesh.dev/mcp-problems/loopmem-disabled",
    detail: "Set GITAMESH_LOOPMEM_STORE to an absolute shared store path to enable memory tools.",
  } };
  try {
    return { ok: true, ...await action(client) };
  } catch (error) {
    if (error instanceof z.ZodError) return invalidInputError("Invalid memory tool input.");
    const known = error instanceof LoopMemError;
    return { ok: false, error: {
      type: `https://gitamesh.dev/mcp-problems/loopmem-${known ? error.code : "command-failed"}`,
      detail: known ? error.message : "LoopMem operation failed.",
    } };
  }
}

export function handleMemoryInit(input: z.infer<typeof MemoryInitInputSchema>, client?: LoopMemClient) {
  return withMemory(client, async (memory) => {
    const parsed = MemoryInitInputSchema.parse(input);
    return { store: await memory.initialize(parsed.repositoryId, parsed.goal) };
  });
}

export function handleMemoryRemember(input: z.infer<typeof MemoryRememberInputSchema>, client?: LoopMemClient) {
  return withMemory(client, async (memory) => {
    const parsed = MemoryRememberInputSchema.parse(input);
    return { namespace: memoryNamespace(parsed.repositoryId), memory: await memory.remember(parsed.repositoryId, parsed) };
  });
}

export function handleMemoryRecall(input: z.infer<typeof MemoryRecallInputSchema>, client?: LoopMemClient) {
  return withMemory(client, async (memory) => {
    const parsed = MemoryRecallInputSchema.parse(input);
    return memory.recall(parsed.repositoryId, parsed);
  });
}

export function handleMemoryGet(input: z.infer<typeof MemoryGetInputSchema>, client?: LoopMemClient) {
  return withMemory(client, async (memory) => {
    const parsed = MemoryGetInputSchema.parse(input);
    return { namespace: memoryNamespace(parsed.repositoryId), memory: await memory.get(parsed.repositoryId, parsed.id) };
  });
}

export function handleMemoryContext(input: z.infer<typeof MemoryContextInputSchema>, client?: LoopMemClient) {
  return withMemory(client, async (memory) => {
    const parsed = MemoryContextInputSchema.parse(input);
    return { namespace: memoryNamespace(parsed.repositoryId), context: await memory.context(parsed.repositoryId) };
  });
}
